/**
 * Initialization wizard for Fermi.
 *
 * Provides an interactive first-run setup experience using @inquirer/prompts.
 * Saves provider configuration to ~/.fermi/settings.json + state/model-selection.json.
 * Supports Ctrl+C / ESC to go back to the previous step.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { select, input, confirm } from "@inquirer/prompts";
import { getFermiHomeDir } from "./home-path.js";
import {
  PROVIDER_PRESETS,
  buildProviderPresetRawConfig,
  type ProviderPreset,
} from "./provider-presets.js";
import { fetchModelsFromServer } from "./model-discovery.js";
import { setDotenvKey } from "./dotenv.js";
import {
  type FermiSettings,
  type ModelSelectionState,
  type ProviderEntry,
  type ModelTierEntry,
  saveSettings,
  globalSettingsPath,
  saveModelSelectionState,
  loadGlobalSettings,
} from "./persistence.js";
import {
  detectManagedCredentialCandidates,
  hasAnyManagedCredential,
  hasManagedCredential,
  isManagedProvider,
} from "./managed-provider-credentials.js";
import {
  ensureManagedProviderCredential,
  type CredentialPromptAdapter,
} from "./provider-credential-flow.js";
import { Config, getThinkingLevels } from "./config.js";
import { buildModelPickerTree, labelModelPickerNode, type ModelPickerTreeNode } from "./model-picker-tree.js";
import { createModelTierEntry, parseProviderModelTarget } from "./model-selection.js";
import { describeModel } from "./model-presentation.js";

// ------------------------------------------------------------------
// Wizard result
// ------------------------------------------------------------------

export interface WizardResult {
  homeDir: string;
}

// ------------------------------------------------------------------
// Internal types
// ------------------------------------------------------------------

/** Result of configuring a single provider. */
interface ProviderConfigResult {
  providerId: string;
  providerEntry: ProviderEntry;
  skipped?: boolean;
}

/** A fully selected model: provider + model key + model id + config name. */
interface ModelSelection {
  configName: string;   // "providerId:modelKey"
  providerId: string;
  selectionKey: string; // model key
  modelId: string;      // actual API model id
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function isUserCancel(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as any).name === "ExitPromptError" ||
    (err as any).code === "ERR_USE_AFTER_CLOSE";
}

function createInitPromptAdapter(): CredentialPromptAdapter {
  return {
    select: async (request) => {
      return select({
        message: request.message,
        choices: request.options.map((option) => ({
          name: option.description ? `${option.label} — ${option.description}` : option.label,
          value: option.value,
        })),
      });
    },
    secret: async (request) => {
      const value = await input({
        message: request.message,
      });
      if (!request.allowEmpty && value.trim() === "") return "";
      return value;
    },
  };
}

/**
 * Check whether a provider preset is already configured (has key / credentials).
 */
function isProviderConfigured(preset: ProviderPreset, configuredProviders: Map<string, ProviderEntry>): boolean {
  if (configuredProviders.has(preset.id)) return true;
  if (preset.localServer) return false;
  if (isManagedProvider(preset.id)) {
    return hasManagedCredential(preset.id) || detectManagedCredentialCandidates(preset.id).length > 0;
  }
  return Boolean(process.env[preset.envVar]);
}

function createWizardPickerSession(
  configuredProviders: Map<string, ProviderEntry>,
  currentSelection?: ModelSelection,
): any {
  const config = new Config({});

  for (const [providerId, entry] of configuredProviders) {
    if (entry.base_url && entry.model) {
      config.upsertModelRaw(`${providerId}:${entry.model}`, {
        provider: providerId,
        model: entry.model,
        api_key: entry.api_key ?? "local",
        base_url: entry.base_url,
        context_length: entry.context_length,
        supports_web_search: false,
      });
      continue;
    }

    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === providerId);
    if (!preset || preset.localServer) continue;

    const placeholderKey =
      providerId === "openai-codex"
        ? "oauth:openai-codex"
        : providerId === "copilot"
          ? "oauth:copilot"
          : "wizard-configured";

    for (const model of preset.models) {
      config.upsertModelRaw(
        `${providerId}:${model.key}`,
        buildProviderPresetRawConfig(providerId, model, placeholderKey),
      );
    }
  }

  let currentModelConfig: Record<string, unknown> | undefined;
  if (currentSelection) {
    try {
      currentModelConfig = config.getModel(currentSelection.configName) as unknown as Record<string, unknown>;
    } catch {
      currentModelConfig = {
        provider: currentSelection.providerId,
        model: currentSelection.modelId,
      };
    }
  }

  return {
    config,
    currentModelConfigName: currentSelection?.configName,
    primaryAgent: { modelConfig: currentModelConfig ?? { provider: "", model: "" } },
  };
}

function createInitialWizardProviders(): Map<string, ProviderEntry> {
  const providers = new Map<string, ProviderEntry>();

  for (const preset of PROVIDER_PRESETS) {
    if (preset.localServer) continue;
    if (isManagedProvider(preset.id)) {
      if (hasManagedCredential(preset.id) || detectManagedCredentialCandidates(preset.id).length > 0) {
        providers.set(preset.id, { api_key_env: preset.envVar });
      }
      continue;
    }
    if (process.env[preset.envVar]) {
      providers.set(preset.id, { api_key_env: preset.envVar });
    }
  }

  return providers;
}

function resolveWizardModelSelection(target: string): ModelSelection {
  const parsed = parseProviderModelTarget(target);
  if (!parsed) {
    throw new Error(`Unexpected model picker value: ${target}`);
  }

  const presetModel = PROVIDER_PRESETS
    .find((preset) => preset.id === parsed.provider)
    ?.models.find((model) => model.key === parsed.model);
  const modelId = presetModel?.id ?? parsed.model;

  return {
    configName: `${parsed.provider}:${parsed.model}`,
    providerId: parsed.provider,
    selectionKey: parsed.model,
    modelId,
  };
}

function describeWizardModelSelection(selection: ModelSelection): string {
  const description = describeModel({
    providerId: selection.providerId,
    selectionKey: selection.selectionKey,
    modelId: selection.modelId,
    configName: selection.configName,
  });
  return description.scopedDetailedLabel || selection.configName;
}

function buildWizardModelPickerTree(
  configuredProviders: Map<string, ProviderEntry>,
  currentSelection?: ModelSelection,
  opts?: {
    allowedProviderIds?: Iterable<string>;
    includeDoneAction?: boolean;
    includeLocalDiscoverActions?: boolean;
  },
): ModelPickerTreeNode[] {
  const tree = buildModelPickerTree({
    session: createWizardPickerSession(configuredProviders, currentSelection),
    allowedProviderIds: opts?.allowedProviderIds,
    includeAddProviderAction: false,
    includeLocalDiscoverActions: opts?.includeLocalDiscoverActions,
  });

  if (opts?.includeDoneAction && currentSelection) {
    tree.push({
      kind: "action",
      id: "__done__",
      value: "__done__",
      label: `Done — use ${describeWizardModelSelection(currentSelection)}`,
      isCurrent: false,
      credentialState: "not_required",
      keyMissing: false,
    });
  }

  return tree;
}

async function stepSelectModelTreeValue(
  nodes: ModelPickerTreeNode[],
  message: string,
): Promise<string | undefined> {
  const stack: Array<{ message: string; nodes: ModelPickerTreeNode[] }> = [{ message, nodes }];

  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const choices = [
      ...(stack.length > 1 ? [{ name: "← Back", value: "__back__" }] : []),
      ...current.nodes.map((node) => ({
        name: labelModelPickerNode(node),
        value: node.id,
      })),
    ];

    const picked = await select({
      message: current.message,
      choices,
    });

    if (picked === "__back__") {
      stack.pop();
      continue;
    }

    const selectedNode = current.nodes.find((node) => node.id === picked);
    if (!selectedNode) continue;
    if (selectedNode.children && selectedNode.children.length > 0) {
      stack.push({
        message: selectedNode.label,
        nodes: selectedNode.children,
      });
      continue;
    }
    return selectedNode.value;
  }

  return undefined;
}

async function stepPickTierModelFromTree(
  configuredProviders: Map<string, ProviderEntry>,
  tierName: "high" | "medium" | "low",
): Promise<ModelSelection | undefined> {
  const allowedProviderIds = new Set(configuredProviders.keys());
  if (allowedProviderIds.size === 0) return undefined;

  const tree = buildWizardModelPickerTree(configuredProviders, undefined, {
    allowedProviderIds,
    includeLocalDiscoverActions: false,
  });
  if (tree.length === 0) return undefined;

  const picked = await stepSelectModelTreeValue(
    tree,
    `  ${tierName} tier: Select model`,
  );
  if (!picked) return undefined;

  return resolveWizardModelSelection(picked);
}

function describeTierEntry(entry: ModelTierEntry): string {
  const description = describeModel({
    providerId: entry.provider,
    selectionKey: entry.selection_key,
    modelId: entry.model_id,
    configName: `${entry.provider}:${entry.selection_key}`,
  });
  return description.scopedDetailedLabel || `${entry.provider}:${entry.selection_key}`;
}

// ------------------------------------------------------------------
// Step: Configure a single provider (reused from old wizard)
// ------------------------------------------------------------------

async function stepConfigureProvider(provider: ProviderPreset): Promise<ProviderConfigResult> {
  // ── OpenAI Codex (OAuth) ──
  if (provider.id === "openai-codex") {
    console.log(`  ${provider.name}: Logging in with your ChatGPT account...\n`);
    const { browserLogin, deviceCodeLogin, saveOAuthTokens, hasOAuthTokens } = await import("./auth/openai-oauth.js");
    if (hasOAuthTokens()) {
      const reuse = await confirm({
        message: "Existing OAuth login found. Use it?",
        default: true,
      });
      if (!reuse) {
        const method = await select({
          message: "Login method",
          choices: [
            { name: "Browser login (recommended)", value: "browser" },
            { name: "Device code (SSH / headless)", value: "device" },
          ],
        });
        const tokens = method === "browser" ? await browserLogin() : await deviceCodeLogin();
        saveOAuthTokens(tokens);
        console.log("\n  Login successful!\n");
      }
    } else {
      const method = await select({
        message: "Login method",
        choices: [
          { name: "Browser login (recommended)", value: "browser" },
          { name: "Device code (SSH / headless)", value: "device" },
        ],
      });
      const tokens = method === "browser" ? await browserLogin() : await deviceCodeLogin();
      saveOAuthTokens(tokens);
      console.log("\n  Login successful!\n");
    }
    return {
      providerId: provider.id,
      providerEntry: { api_key_env: "_OPENAI_CODEX_OAUTH" },
    };
  }

  // ── GitHub Copilot (device flow) ──
  if (provider.id === "copilot") {
    console.log(`  ${provider.name}: Logging in with your GitHub account...\n`);
    const { deviceCodeLoginCLI, saveGitHubTokens, hasGitHubTokens } = await import("./auth/github-copilot-oauth.js");
    if (hasGitHubTokens()) {
      const reuse = await confirm({
        message: "Existing GitHub Copilot login found. Use it?",
        default: true,
      });
      if (!reuse) {
        const tokens = await deviceCodeLoginCLI();
        saveGitHubTokens(tokens);
        console.log("\n  Login successful!\n");
      }
    } else {
      const tokens = await deviceCodeLoginCLI();
      saveGitHubTokens(tokens);
      console.log("\n  Login successful!\n");
    }
    return {
      providerId: provider.id,
      providerEntry: { api_key_env: "_COPILOT_OAUTH" },
    };
  }

  // ── Local inference servers (Ollama, oMLX, LM Studio) ──
  if (provider.localServer && provider.defaultBaseUrl) {
    console.log(`  Default: ${provider.defaultBaseUrl} (press Enter to use)\n`);
    const baseUrl = await input({
      message: `${provider.name}: Server URL`,
      default: provider.defaultBaseUrl,
    });

    // Try without key first; if no models found, ask for API key and retry
    console.log(`  Connecting to ${baseUrl} ...`);
    let apiKey = "local";
    let discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
    if (discovered.length === 0) {
      const keyInput = await input({
        message: `${provider.name}: API key (Enter to skip if none required)`,
      });
      if (keyInput.trim()) {
        apiKey = keyInput.trim();
        discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
      }
    }

    let modelId: string;
    let contextLength: number | undefined;

    if (discovered.length > 0) {
      console.log(`  Found ${discovered.length} model(s)\n`);
      modelId = await select({
        message: `${provider.name}: Select model`,
        choices: discovered.map((m) => ({
          name: m.contextLength
            ? `${m.id} (${Math.round(m.contextLength / 1024)}K ctx)`
            : m.id,
          value: m.id,
        })),
      });
      contextLength = discovered.find((m) => m.id === modelId)?.contextLength;
    } else {
      console.log(
        "  Could not reach server or no models loaded.\n" +
        "  Please make sure the server is running and has at least one model loaded.\n",
      );
      modelId = await input({
        message: `${provider.name}: Enter model name manually`,
      });
    }

    if (!contextLength) {
      const ctxInput = await input({
        message: `${provider.name}: Context length (tokens, e.g. 32768)`,
        default: "32768",
      });
      contextLength = parseInt(ctxInput, 10) || 32768;
    }

    const entry: ProviderEntry = { base_url: baseUrl, model: modelId, context_length: contextLength };
    if (apiKey !== "local") entry.api_key = apiKey;

    return { providerId: provider.id, providerEntry: entry };
  }

  // ── Managed credential providers (Kimi, GLM, MiniMax) ──
  if (isManagedProvider(provider.id)) {
    const result = await ensureManagedProviderCredential(
      provider.id,
      createInitPromptAdapter(),
      { mode: "init", allowReplaceExisting: true },
    );
    if (result.status === "skipped") {
      return { providerId: provider.id, providerEntry: { api_key_env: result.envVar }, skipped: true };
    }

    console.log(`  ✓ Saved to ~/.fermi/.env as ${result.envVar}\n`);
    return {
      providerId: provider.id,
      providerEntry: { api_key_env: result.envVar },
    };
  }

  // ── Standard API key providers ──
  const envVarName = provider.envVar;
  const envValue = process.env[envVarName];

  if (envValue) {
    const choice = await select({
      message: `${provider.name}: ${envVarName} detected in environment`,
      choices: [
        { name: "Use it", value: "use" },
        { name: "Paste a different key for Fermi", value: "paste" },
      ],
    });
    if (choice === "paste") {
      const key = await input({ message: `${provider.name}: Paste API key` });
      if (key.trim()) {
        setDotenvKey(envVarName, key.trim());
        console.log(`  ✓ Saved to ~/.fermi/.env\n`);
      }
    }
  } else {
    const key = await input({
      message: `${provider.name}: Paste API key (Enter to skip, set ${envVarName} later)`,
    });
    if (key.trim()) {
      setDotenvKey(envVarName, key.trim());
      console.log(`  ✓ Saved to ~/.fermi/.env\n`);
    }
  }

  return {
    providerId: provider.id,
    providerEntry: { api_key_env: envVarName },
  };
}

// ------------------------------------------------------------------
// Step: Provider & Model Picker (interactive loop)
// ------------------------------------------------------------------

async function stepProviderModelPicker(): Promise<{
  selection: ModelSelection;
  providers: Map<string, ProviderEntry>;
}> {
  const providers = createInitialWizardProviders();
  let currentSelection: ModelSelection | undefined;

  while (true) {
    const tree = buildWizardModelPickerTree(providers, currentSelection, {
      includeDoneAction: currentSelection !== undefined,
      includeLocalDiscoverActions: true,
    });
    const picked = await stepSelectModelTreeValue(
      tree,
      currentSelection
        ? `Current: ${describeWizardModelSelection(currentSelection)}`
        : "Select a model",
    );

    if (!picked) continue;
    if (picked === "__done__") {
      if (currentSelection) return { selection: currentSelection, providers };
      continue;
    }

    if (picked.endsWith(":__discover__")) {
      const providerId = picked.split(":")[0];
      const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === providerId);
      if (!preset) {
        throw new Error(`Unknown local provider preset: ${providerId}`);
      }
      console.log();
      const result = await stepConfigureProvider(preset);
      if (!result.skipped) {
        providers.set(result.providerId, result.providerEntry);
        if (result.providerEntry.model) {
          currentSelection = {
            configName: `${result.providerId}:${result.providerEntry.model}`,
            providerId: result.providerId,
            selectionKey: result.providerEntry.model,
            modelId: result.providerEntry.model,
          };
        }
      }
      continue;
    }

    const modelSelection = resolveWizardModelSelection(picked);
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === modelSelection.providerId);
    if (preset && !isProviderConfigured(preset, providers)) {
      console.log();
      const result = await stepConfigureProvider(preset);
      if (result.skipped) continue;
      providers.set(result.providerId, result.providerEntry);
    }

    currentSelection = modelSelection;
  }
}

// ------------------------------------------------------------------
// Step: Thinking level selection
// ------------------------------------------------------------------

async function stepSelectThinkingLevel(modelId: string, label: string): Promise<string | undefined> {
  const levels = getThinkingLevels(modelId);
  if (levels.length === 0) return undefined;

  // Build choices: "off" first (if not already in the list), then the model's levels
  const choices: Array<{ name: string; value: string }> = [];
  if (!levels.includes("off") && !levels.includes("none")) {
    choices.push({ name: "off", value: "off" });
  }
  for (const level of levels) {
    choices.push({ name: level, value: level });
  }

  const selected = await select({
    message: `${label}: Thinking level`,
    choices,
  });

  return selected;
}

// ------------------------------------------------------------------
// Step: Configure sub-agent tiers
// ------------------------------------------------------------------

async function stepConfigureTiers(
  mainProviders: Map<string, ProviderEntry>,
): Promise<Record<string, ModelTierEntry> | undefined> {
  const wantTiers = await confirm({
    message: "Configure sub-agent model tiers? (Skip = all inherit main model)",
    default: false,
  });

  if (!wantTiers) return undefined;

  const tiers: Record<string, ModelTierEntry> = {};

  for (const tierName of ["high", "medium", "low"] as const) {
    const skipTier = await confirm({
      message: `  ${tierName} tier: Configure? (No = inherit main model)`,
      default: false,
    });

    if (!skipTier) continue;

    const picked = await stepPickTierModelFromTree(mainProviders, tierName);
    if (!picked) {
      console.log("    No configured providers with models available. Skipping.\n");
      continue;
    }

    // Thinking level for this tier model
    const thinkingLevel = await stepSelectThinkingLevel(picked.modelId, `  ${tierName} tier`);

    tiers[tierName] = createModelTierEntry({
      provider: picked.providerId,
      selectionKey: picked.selectionKey,
      modelId: picked.modelId,
    }, thinkingLevel);
  }

  return Object.keys(tiers).length > 0 ? tiers : undefined;
}

// ------------------------------------------------------------------
// Main wizard — state machine with back support
// ------------------------------------------------------------------

const enum Step {
  CHECK_EXISTING,
  SELECT_MODEL,
  THINKING_LEVEL,
  CONFIGURE_TIERS,
  WRITE,
}

export async function runInitWizard(): Promise<WizardResult> {
  const homeDir = getFermiHomeDir();

  // Check if settings.json already exists with providers
  const existingSettings = loadGlobalSettings(homeDir);
  const hasExisting = Boolean(
    existingSettings.providers && Object.keys(existingSettings.providers).length > 0,
  ) || hasAnyManagedCredential();

  console.log();
  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║       Welcome to Fermi Setup!        ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log("  (Ctrl+C to go back, double Ctrl+C to quit)\n");

  let step: Step = hasExisting ? Step.CHECK_EXISTING : Step.SELECT_MODEL;

  // State accumulated across steps
  let modelSelection: ModelSelection | undefined;
  let configuredProviders = new Map<string, ProviderEntry>();
  let thinkingLevel: string | undefined;
  let tierConfig: Record<string, ModelTierEntry> | undefined;

  while (step !== Step.WRITE) {
    try {
      switch (step) {
        case Step.CHECK_EXISTING: {
          console.log("  Existing configuration found.");
          const useExisting = await confirm({
            message: "Use existing configuration?",
            default: true,
          });
          if (useExisting) {
            console.log("\n  ✓ Using existing configuration.\n");
            return { homeDir };
          }
          step = Step.SELECT_MODEL;
          break;
        }

        case Step.SELECT_MODEL: {
          const result = await stepProviderModelPicker();
          modelSelection = result.selection;
          configuredProviders = result.providers;
          step = Step.THINKING_LEVEL;
          break;
        }

        case Step.THINKING_LEVEL: {
          if (modelSelection) {
            thinkingLevel = await stepSelectThinkingLevel(
              modelSelection.modelId,
              "Main model",
            );
          }
          step = Step.CONFIGURE_TIERS;
          break;
        }

        case Step.CONFIGURE_TIERS: {
          tierConfig = await stepConfigureTiers(configuredProviders);
          step = Step.WRITE;
          break;
        }
      }
    } catch (err) {
      if (!isUserCancel(err)) throw err;

      // Back navigation
      switch (step) {
        case Step.CHECK_EXISTING:
          console.log("\n  Setup cancelled.\n");
          throw err;
        case Step.SELECT_MODEL:
          if (hasExisting) {
            step = Step.CHECK_EXISTING;
          } else {
            console.log("\n  Setup cancelled.\n");
            throw err;
          }
          break;
        case Step.THINKING_LEVEL:
          step = Step.SELECT_MODEL;
          break;
        case Step.CONFIGURE_TIERS:
          step = Step.THINKING_LEVEL;
          break;
      }
      console.log();
    }
  }

  // ------------------------------------------------------------------
  // Build and save settings
  // ------------------------------------------------------------------

  const providers: Record<string, ProviderEntry> = {};
  configuredProviders.forEach((entry, id) => {
    providers[id] = entry;
  });

  const settings: FermiSettings = {
    default_model: modelSelection?.configName,
    thinking_level: thinkingLevel && thinkingLevel !== "off" && thinkingLevel !== "none"
      ? thinkingLevel
      : undefined,
    providers: Object.keys(providers).length > 0 ? providers : undefined,
    model_tiers: tierConfig,
  };

  saveSettings(settings, globalSettingsPath(homeDir));

  // Save model selection state
  if (modelSelection) {
    saveModelSelectionState({
      config_name: modelSelection.configName,
      provider: modelSelection.providerId,
      selection_key: modelSelection.selectionKey,
      model_id: modelSelection.modelId,
      thinking_level: thinkingLevel,
    });
  }

  // Ensure user override directories and global memory file
  mkdirSync(join(homeDir, "agent_templates"), { recursive: true });
  mkdirSync(join(homeDir, "skills"), { recursive: true });
  const globalAgentsMd = join(homeDir, "AGENTS.md");
  if (!existsSync(globalAgentsMd)) {
    writeFileSync(globalAgentsMd, "");
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------

  console.log();
  console.log("  ✓ Configuration saved");
  console.log(`    Settings: ${globalSettingsPath(homeDir)}`);
  console.log();

  if (modelSelection) {
    console.log(`  Default model: ${describeWizardModelSelection(modelSelection)}`);
  }
  if (thinkingLevel && thinkingLevel !== "off" && thinkingLevel !== "none") {
    console.log(`  Thinking level: ${thinkingLevel}`);
  }
  if (tierConfig) {
    for (const [tier, entry] of Object.entries(tierConfig)) {
      console.log(`  ${tier} tier: ${describeTierEntry(entry)}${entry.thinking_level ? ` (thinking: ${entry.thinking_level})` : ""}`);
    }
  }

  console.log();
  configuredProviders.forEach((entry, id) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id);
    if (entry.base_url) {
      console.log(`  ✓ ${preset?.name ?? id} (local: ${entry.base_url})`);
    } else if (entry.api_key_env) {
      const hasKey = isManagedProvider(id)
        ? hasManagedCredential(id)
        : Boolean(process.env[entry.api_key_env]);
      console.log(`  ${hasKey ? "✓" : "✗"} ${preset?.name ?? id} (${entry.api_key_env}${hasKey ? "" : " — not set"})`);
    }
  });

  console.log();
  console.log("  Run 'fermi' to start.");
  console.log();

  return { homeDir };
}
