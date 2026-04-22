import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { Config, resolveAssetPaths, getBundledAssetsDir } from "../src/config.js";
import { Agent } from "../src/agents/agent.js";
import { Session } from "../src/session.js";
import { loadTemplates } from "../src/templates/loader.js";
import { loadSkillsMulti } from "../src/skills/loader.js";
import {
  SessionStore,
  loadGlobalSettings,
  loadLocalSettings,
  mergeSettings,
  loadModelSelectionState,
  settingsToConfigInputs,
} from "../src/persistence.js";
import { loadDotenv } from "../src/dotenv.js";
import { getVigilHomeDir } from "../src/home-path.js";
import {
  buildDefaultRegistry,
  registerSkillCommands,
} from "../src/commands.js";
import type { CommandRegistry } from "../src/commands.js";
import type { PersistedModelSelection } from "../src/model-selection.js";
import { applyPersistedModelSelectionToSession } from "../src/model-restore.js";
import {
  hasAnyManagedCredential,
} from "../src/managed-provider-credentials.js";
import { setAccent } from "../src/accent.js";

function identifyPrimaryAgent(
  agents: Record<string, Agent>,
  name = "main",
): Agent {
  const agent = agents[name];
  if (agent) return agent;

  const names = Object.keys(agents).sort();
  if (names.length > 0) {
    return agents[names[0]!];
  }

  throw new Error("No agent templates found.");
}

export interface OpenTuiRuntime {
  session: Session;
  store: SessionStore;
  commandRegistry: CommandRegistry;
  verbose: boolean;
}

export async function bootstrapOpenTuiRuntime(opts?: {
  templates?: string;
  verbose?: boolean;
}): Promise<OpenTuiRuntime> {
  const homeDir = getVigilHomeDir();
  loadDotenv(homeDir);

  const verbose = opts?.verbose ?? false;
  const projectPath = process.cwd();
  const store = new SessionStore({ projectPath });

  // ── Load settings (global + local merge) ──
  const globalSettings = loadGlobalSettings(homeDir);
  const localSettings = loadLocalSettings(projectPath);
  const settings = mergeSettings(globalSettings, localSettings);

  // Check if any providers are configured
  const { providerEnvVars, localProviders, mcpServers } = settingsToConfigInputs(settings);
  const hasProviders =
    Object.keys(providerEnvVars).length > 0
    || Object.keys(localProviders).length > 0
    || hasAnyManagedCredential();

  if (!hasProviders) {
    throw new Error(
      "No providers configured. Run `vigil init` first, then retry the OpenTUI prototype.",
    );
  }

  // ── Build Config ──
  const paths = resolveAssetPaths({
    templatesFlag: opts?.templates,
  });
  const config = new Config({
    providerEnvVars,
    localProviders,
    mcpServers,
    modelTiers: settings.model_tiers,
  });

  // ── OAuth token refresh ──
  const oauthEntries = config.listModelEntries().filter(
    (entry) => entry.apiKeyRaw === "oauth:openai-codex",
  );
  if (oauthEntries.length > 0) {
    try {
      const { ensureFreshToken } = await import("../src/auth/openai-oauth.js");
      await ensureFreshToken();
    } catch (err) {
      console.warn(
        `Warning: OAuth token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── MCP client ──
  let mcpManager: unknown = null;
  if (config.mcpServerConfigs.length > 0) {
    try {
      const { MCPClientManager } = await import("../src/mcp-client.js");
      mcpManager = new MCPClientManager(config.mcpServerConfigs);
    } catch {
      console.warn(
        "Warning: MCP servers configured but MCP client module not available. Install @modelcontextprotocol/sdk if needed.",
      );
    }
  }

  // ── Templates ──
  const bundledDir = getBundledAssetsDir();
  const bundledTemplates = join(bundledDir, "agent_templates");
  const bundledPrompts = join(bundledDir, "prompts");
  const promptsDirs: string[] = [];
  if (paths.promptsPath) promptsDirs.push(paths.promptsPath);
  promptsDirs.push(bundledPrompts);

  const agents = loadTemplates(
    bundledTemplates,
    config,
    mcpManager as never,
    promptsDirs,
    paths.templatesPath ?? undefined,
  );
  const primary = identifyPrimaryAgent(agents);

  // ── Skills ──
  const bundledSkills = join(bundledDir, "skills");
  const skillRoots: string[] = [];
  if (existsSync(bundledSkills) && statSync(bundledSkills).isDirectory()) {
    skillRoots.push(bundledSkills);
  }
  const userSkillsPath = paths.skillsPath;
  if (
    userSkillsPath &&
    userSkillsPath !== bundledSkills &&
    existsSync(userSkillsPath) &&
    statSync(userSkillsPath).isDirectory()
  ) {
    skillRoots.push(userSkillsPath);
  }
  const skills = loadSkillsMulti(skillRoots);

  // ── Session ──
  const contextRatio = settings.context_ratio ?? 1.0;
  const session = new Session({
    primaryAgent: primary as never,
    config,
    agentTemplates: agents as never,
    skills: skills as never,
    skillRoots,
    progress: undefined,
    mcpManager: mcpManager as never,
    promptsDirs,
    store: store as never,
    contextRatio,
  });

  // ── Restore model selection ──
  // Priority: settings.default_model > state/model-selection.json
  const modelState = loadModelSelectionState(homeDir);
  const effectiveModelConfigName = settings.default_model ?? modelState.config_name;
  try {
    if (effectiveModelConfigName) {
      applyPersistedModelSelectionToSession(
        session,
        {
          modelConfigName: effectiveModelConfigName,
          modelProvider: modelState.provider,
          modelSelectionKey: modelState.selection_key,
          modelId: modelState.model_id,
        } satisfies PersistedModelSelection,
      );
    }
  } catch (err) {
    console.warn(
      `Warning: failed to restore saved model preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Apply settings to session ──
  session.applySettings(settings, modelState);
  if (settings.accent_color) {
    setAccent(settings.accent_color);
  }

  // ── Shiki syntax highlighter (disable with VIGIL_SHIKI=0) ──
  if (process.env.VIGIL_SHIKI !== "0") {
    import("./shiki-highlighter.js").then(async ({ initShikiHighlighter }) => {
      await initShikiHighlighter();
    }).catch(() => {
      // Shiki unavailable — silently fall back to hljs.
      import("./patch-opentui-markdown.js").then(({ setUseShikiHighlighter }) => {
        setUseShikiHighlighter(false);
      });
    });
  } else {
    import("./patch-opentui-markdown.js").then(({ setUseShikiHighlighter }) => {
      setUseShikiHighlighter(false);
    });
  }

  const commandRegistry = buildDefaultRegistry();
  registerSkillCommands(commandRegistry, session.skills);

  return {
    session,
    store,
    commandRegistry,
    verbose,
  };
}
