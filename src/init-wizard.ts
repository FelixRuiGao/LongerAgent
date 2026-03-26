/**
 * Initialization wizard for LongerAgent.
 *
 * Provides an interactive first-run setup experience using @inquirer/prompts.
 * Saves provider configuration to ~/.longeragent/tui-preferences.json.
 * Supports Ctrl+C / ESC to go back to the previous step.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { checkbox, select, input, confirm } from "@inquirer/prompts";
import { getLongerAgentHomeDir } from "./home-path.js";
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "./provider-presets.js";
import { fetchModelsFromServer } from "./model-discovery.js";
import { setDotenvKey } from "./dotenv.js";
import type { GlobalTuiPreferences, LocalProviderConfig } from "./persistence.js";
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

// ------------------------------------------------------------------
// Wizard result
// ------------------------------------------------------------------

export interface WizardResult {
  homeDir: string;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function isUserCancel(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as any).name === "ExitPromptError" ||
    (err as any).code === "ERR_USE_AFTER_CLOSE";
}

/**
 * Load existing preferences from tui-preferences.json (if present).
 */
function loadExistingPreferences(homeDir: string): GlobalTuiPreferences | null {
  const prefsPath = join(homeDir, "tui-preferences.json");
  if (!existsSync(prefsPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(prefsPath, "utf-8"));
    return {
      version: raw.version ?? 1,
      modelConfigName: raw.model_config_name ?? undefined,
      modelProvider: raw.model_provider ?? undefined,
      modelSelectionKey: raw.model_selection_key ?? undefined,
      modelId: raw.model_id ?? undefined,
      thinkingLevel: raw.thinking_level ?? "default",
      accentColor: raw.accent_color ?? undefined,
      disabledSkills: Array.isArray(raw.disabled_skills) ? raw.disabled_skills : undefined,
      providerEnvVars: raw.provider_env_vars ?? undefined,
      localProviders: raw.local_providers ?? undefined,
      contextRatio: typeof raw.context_ratio === "number" ? raw.context_ratio : undefined,
    } satisfies GlobalTuiPreferences;
  } catch {
    return null;
  }
}

/**
 * Save preferences to tui-preferences.json (atomic write).
 */
function savePreferences(homeDir: string, prefs: GlobalTuiPreferences): void {
  mkdirSync(homeDir, { recursive: true });
  const file = join(homeDir, "tui-preferences.json");
  const tmp = file + ".tmp";
  writeFileSync(
    tmp,
    JSON.stringify({
      version: prefs.version ?? 1,
      model_config_name: prefs.modelConfigName ?? null,
      model_provider: prefs.modelProvider ?? null,
      model_selection_key: prefs.modelSelectionKey ?? null,
      model_id: prefs.modelId ?? null,
      thinking_level: prefs.thinkingLevel ?? "default",
      accent_color: prefs.accentColor ?? null,
      disabled_skills: prefs.disabledSkills ?? null,
      provider_env_vars: prefs.providerEnvVars ?? null,
      local_providers: prefs.localProviders ?? null,
      context_ratio: prefs.contextRatio ?? null,
    }, null, 2),
  );
  renameSync(tmp, file);
}

// ------------------------------------------------------------------
// Provider configuration results
// ------------------------------------------------------------------

interface ProviderConfigResult {
  providerId: string;
  envVar?: string;
  localProvider?: LocalProviderConfig;
  skipped?: boolean;
  /** Model config name (provider:modelKey) for default selection. */
  defaultModelConfigName?: string;
}

// ------------------------------------------------------------------
// Step functions
// ------------------------------------------------------------------

/**
 * Build a deduplicated top-level choice list.
 * Grouped presets (kimi, minimax, glm) appear once using their groupLabel.
 * The value is either a preset ID or a group key prefixed with "group:".
 */
function buildProviderChoices(): Array<{ name: string; value: string }> {
  const choices: Array<{ name: string; value: string }> = [];
  const seenGroups = new Set<string>();

  for (const p of PROVIDER_PRESETS) {
    if (p.group) {
      if (seenGroups.has(p.group)) continue;
      seenGroups.add(p.group);
      // Check if any preset in this group has a detected key
      const groupPresets = PROVIDER_PRESETS.filter((pp) => pp.group === p.group);
      const anyKeyDetected = groupPresets.some((pp) =>
        isManagedProvider(pp.id)
          ? hasManagedCredential(pp.id) || detectManagedCredentialCandidates(pp.id).length > 0
          : Boolean(process.env[pp.envVar])
      );
      const suffix = anyKeyDetected ? " ✓ key detected" : "";
      choices.push({
        name: `${p.groupLabel ?? p.group}${suffix}`,
        value: `group:${p.group}`,
      });
    } else {
      const suffix = p.localServer
        ? ""
        : (
          isManagedProvider(p.id)
            ? (hasManagedCredential(p.id) || detectManagedCredentialCandidates(p.id).length > 0)
            : Boolean(process.env[p.envVar])
        )
          ? " ✓ key detected"
          : "";
      choices.push({
        name: `${p.name}${suffix}`,
        value: p.id,
      });
    }
  }
  return choices;
}

async function stepSelectProviders(): Promise<string[]> {
  const topLevel = await checkbox({
    message: "Select providers (space to toggle, enter to confirm)",
    choices: buildProviderChoices(),
    required: true,
  });

  // Expand group selections into concrete preset IDs via sub-select
  const resolved: string[] = [];
  for (const selection of topLevel) {
    if (selection.startsWith("group:")) {
      const groupKey = selection.slice("group:".length);
      const members = PROVIDER_PRESETS.filter((p) => p.group === groupKey);
      if (members.length === 1) {
        resolved.push(members[0].id);
      } else {
        const subChoice = await checkbox({
          message: `${members[0].groupLabel ?? groupKey}: Select variants`,
          choices: members.map((m) => ({
            name: `${m.subLabel ?? m.name}${
              isManagedProvider(m.id)
                ? (hasManagedCredential(m.id) || detectManagedCredentialCandidates(m.id).length > 0)
                  ? " ✓ key detected"
                  : ""
                : process.env[m.envVar]
                  ? " ✓ key detected"
                  : ""
            }`,
            value: m.id,
          })),
          required: true,
        });
        resolved.push(...subChoice);
      }
    } else {
      resolved.push(selection);
    }
  }
  return resolved;
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
    // Select model
    const selectedModelKey = await select({
      message: `${provider.name}: Select model`,
      choices: provider.models.map((m) => ({
        name: m.label,
        value: m.key,
      })),
    });
    return {
      providerId: provider.id,
      envVar: "_OPENAI_CODEX_OAUTH",
      defaultModelConfigName: `${provider.id}:${selectedModelKey}`,
    };
  }

  // ── Local inference servers (oMLX, LM Studio) ──
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

    const localProvider: LocalProviderConfig = { baseUrl, model: modelId, contextLength };
    if (apiKey !== "local") localProvider.apiKey = apiKey;

    return {
      providerId: provider.id,
      localProvider,
      defaultModelConfigName: `${provider.id}:${modelId}`,
    };
  }

  if (isManagedProvider(provider.id)) {
    const result = await ensureManagedProviderCredential(
      provider.id,
      createInitPromptAdapter(),
      { mode: "init", allowReplaceExisting: true },
    );
    if (result.status === "skipped") {
      return { providerId: provider.id, skipped: true };
    }

    console.log(`  ✓ Saved to ~/.longeragent/.env as ${result.envVar}\n`);

    let defaultModelConfigName: string | undefined;
    if (provider.models.length > 0) {
      const selectedModelKey = await select({
        message: `${provider.name}: Select default model`,
        choices: provider.models.map((m) => ({
          name: m.label,
          value: m.key,
        })),
      });
      defaultModelConfigName = `${provider.id}:${selectedModelKey}`;
    }

    return {
      providerId: provider.id,
      envVar: result.envVar,
      defaultModelConfigName,
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
        { name: "Paste a different key for LongerAgent", value: "paste" },
      ],
    });
    if (choice === "paste") {
      const key = await input({ message: `${provider.name}: Paste API key` });
      if (key.trim()) {
        setDotenvKey(envVarName, key.trim());
        console.log(`  ✓ Saved to ~/.longeragent/.env\n`);
      }
    }
  } else {
    const key = await input({
      message: `${provider.name}: Paste API key (Enter to skip, set ${envVarName} later)`,
    });
    if (key.trim()) {
      setDotenvKey(envVarName, key.trim());
      console.log(`  ✓ Saved to ~/.longeragent/.env\n`);
    }
  }

  // Model selection
  let defaultModelConfigName: string | undefined;
  if (provider.models.length > 0) {
    const selectedModelKey = await select({
      message: `${provider.name}: Select default model`,
      choices: provider.models.map((m) => ({
        name: m.label,
        value: m.key,
      })),
    });
    defaultModelConfigName = `${provider.id}:${selectedModelKey}`;
  }

  return { providerId: provider.id, envVar: envVarName, defaultModelConfigName };
}

// ------------------------------------------------------------------
// Main wizard — state machine with back support
// ------------------------------------------------------------------

const enum Step { CHECK_EXISTING, SELECT_PROVIDERS, CONFIGURE_PROVIDERS, SELECT_DEFAULT, WRITE }

export async function runInitWizard(): Promise<WizardResult> {
  const homeDir = getLongerAgentHomeDir();
  const existing = loadExistingPreferences(homeDir);
  const hasLegacyCloudProviders = Boolean(
    existing?.providerEnvVars
      && Object.keys(existing.providerEnvVars).some((providerId) => !isManagedProvider(providerId)),
  );
  const hasExisting = existing &&
    (hasLegacyCloudProviders
    || (existing.localProviders && Object.keys(existing.localProviders).length > 0)
    || hasAnyManagedCredential());

  console.log();
  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║    Welcome to LongerAgent Setup!     ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log("  (Ctrl+C to go back, double Ctrl+C to quit)\n");

  let step: Step = hasExisting ? Step.CHECK_EXISTING : Step.SELECT_PROVIDERS;
  let selectedProviderIds: string[] = [];
  let results: ProviderConfigResult[] = [];
  let providerIdx = 0;
  let defaultModelConfigName = "";

  while (step !== Step.WRITE) {
    try {
      switch (step) {
        case Step.CHECK_EXISTING: {
          console.log(`  Existing configuration found.`);
          const useExisting = await confirm({
            message: "Use existing configuration?",
            default: true,
          });
          if (useExisting) {
            console.log("\n  ✓ Using existing configuration.\n");
            return { homeDir };
          }
          step = Step.SELECT_PROVIDERS;
          break;
        }

        case Step.SELECT_PROVIDERS: {
          selectedProviderIds = await stepSelectProviders();
          results = [];
          providerIdx = 0;
          step = Step.CONFIGURE_PROVIDERS;
          break;
        }

        case Step.CONFIGURE_PROVIDERS: {
          const selectedProviders = PROVIDER_PRESETS.filter((p) =>
            selectedProviderIds.includes(p.id),
          );
          if (providerIdx >= selectedProviders.length) {
            step = Step.SELECT_DEFAULT;
            break;
          }
          console.log();
          const result = await stepConfigureProvider(selectedProviders[providerIdx]);
          results.push(result);
          providerIdx++;
          if (providerIdx >= selectedProviders.length) {
            step = Step.SELECT_DEFAULT;
          }
          break;
        }

        case Step.SELECT_DEFAULT: {
          // Collect all possible default model config names
          const candidates = results
            .filter((r) => r.defaultModelConfigName)
            .map((r) => r.defaultModelConfigName!);

          if (candidates.length <= 1) {
            defaultModelConfigName = candidates[0] ?? "";
          } else {
            defaultModelConfigName = await select({
              message: "Select default model",
              choices: candidates.map((c) => ({ name: c, value: c })),
            });
          }
          step = Step.WRITE;
          break;
        }
      }
    } catch (err) {
      if (!isUserCancel(err)) throw err;

      switch (step) {
        case Step.CHECK_EXISTING:
          console.log("\n  Setup cancelled.\n");
          throw err;
        case Step.SELECT_PROVIDERS:
          if (hasExisting) {
            step = Step.CHECK_EXISTING;
          } else {
            console.log("\n  Setup cancelled.\n");
            throw err;
          }
          break;
        case Step.CONFIGURE_PROVIDERS:
          if (providerIdx > 0) {
            results.pop();
            providerIdx--;
          } else {
            step = Step.SELECT_PROVIDERS;
          }
          break;
        case Step.SELECT_DEFAULT: {
          results.pop();
          providerIdx = Math.max(0, providerIdx - 1);
          step = Step.CONFIGURE_PROVIDERS;
          break;
        }
      }
      console.log();
    }
  }

  // Build preferences from results
  const providerEnvVars: Record<string, string> = {};
  const localProviders: Record<string, LocalProviderConfig> = {};

  for (const r of results) {
    if (r.localProvider) {
      localProviders[r.providerId] = r.localProvider;
    } else if (r.envVar && !isManagedProvider(r.providerId)) {
      providerEnvVars[r.providerId] = r.envVar;
    }
  }

  // Parse default model config name into provider + model
  let modelProvider: string | undefined;
  let modelSelectionKey: string | undefined;
  let modelId: string | undefined;
  if (defaultModelConfigName) {
    const colonIdx = defaultModelConfigName.indexOf(":");
    if (colonIdx > 0) {
      modelProvider = defaultModelConfigName.slice(0, colonIdx);
      modelSelectionKey = defaultModelConfigName.slice(colonIdx + 1);
      modelId = modelSelectionKey;
    }
  }

  // Merge with existing preferences (keep accent color, thinking level, etc.)
  const prefs: GlobalTuiPreferences = {
    version: 1,
    thinkingLevel: existing?.thinkingLevel ?? "default",
    accentColor: existing?.accentColor,
    disabledSkills: existing?.disabledSkills,
    providerEnvVars,
    localProviders: Object.keys(localProviders).length > 0 ? localProviders : undefined,
    contextRatio: existing?.contextRatio,
    modelConfigName: defaultModelConfigName || undefined,
    modelProvider,
    modelSelectionKey,
    modelId,
  };

  // Save preferences
  savePreferences(homeDir, prefs);

  // Ensure user override directories and global memory file
  mkdirSync(join(homeDir, "agent_templates"), { recursive: true });
  mkdirSync(join(homeDir, "skills"), { recursive: true });
  const globalAgentsMd = join(homeDir, "AGENTS.md");
  if (!existsSync(globalAgentsMd)) {
    writeFileSync(globalAgentsMd, "");
  }

  // Summary
  console.log();
  console.log("  ✓ Configuration saved");
  console.log(`    Preferences: ${join(homeDir, "tui-preferences.json")}`);
  console.log();
  if (defaultModelConfigName) {
    console.log(`  Default model: ${defaultModelConfigName}`);
  }

  for (const r of results) {
    const preset = PROVIDER_PRESETS.find((p) => p.id === r.providerId);
    if (r.skipped) {
      console.log(`  - ${preset?.name ?? r.providerId} (skipped)`);
      continue;
    }
    if (r.localProvider) {
      console.log(`  ✓ ${preset?.name ?? r.providerId} (no API key needed)`);
    } else if (isManagedProvider(r.providerId) && r.envVar && process.env[r.envVar]) {
      console.log(`  ✓ ${preset?.name ?? r.providerId} (${r.envVar})`);
    } else if (r.envVar && process.env[r.envVar]) {
      console.log(`  ✓ ${r.envVar}`);
    } else if (r.envVar) {
      console.log(`  ✗ ${r.envVar} (not set)`);
    }
  }

  const missing = results.filter((r) =>
    r.envVar && !r.localProvider && !r.skipped && !process.env[r.envVar]
  );
  if (missing.length > 0) {
    console.log();
    console.log("  Set the missing keys before starting:");
    for (const r of missing) {
      console.log(`    export ${r.envVar}="your-key-here"`);
    }
  }

  console.log();
  console.log("  Run 'longeragent' to start.");
  console.log();

  return { homeDir };
}
