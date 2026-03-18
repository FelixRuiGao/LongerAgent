import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { Config, resolveAssetPaths, getBundledAssetsDir } from "../src/config.js";
import { Agent } from "../src/agents/agent.js";
import { Session } from "../src/session.js";
import { loadTemplates } from "../src/templates/loader.js";
import { loadSkillsMulti } from "../src/skills/loader.js";
import { SessionStore } from "../src/persistence.js";
import { loadMcpServers } from "../src/mcp-config.js";
import { loadDotenv } from "../src/dotenv.js";
import { getLongerAgentHomeDir } from "../src/home-path.js";
import {
  buildDefaultRegistry,
  registerSkillCommands,
  resolveModelSelection,
} from "../src/commands.js";
import type { CommandRegistry } from "../src/commands.js";
import type { PersistedModelSelection } from "../src/model-selection.js";
import {
  hasAnyManagedCredential,
  isManagedProvider,
} from "../src/managed-provider-credentials.js";

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
  loadDotenv(getLongerAgentHomeDir());

  const verbose = opts?.verbose ?? false;
  const store = new SessionStore({ projectPath: process.cwd() });
  let globalPreferences = store.loadGlobalPreferences();

  const hasLegacyCloudProviders = Boolean(
    globalPreferences.providerEnvVars
      && Object.keys(globalPreferences.providerEnvVars).some(
        (providerId) => !isManagedProvider(providerId),
      ),
  );
  const hasProviders = hasLegacyCloudProviders
    || (globalPreferences.localProviders
      && Object.keys(globalPreferences.localProviders).length > 0)
    || hasAnyManagedCredential();

  if (!hasProviders) {
    throw new Error(
      "No providers configured. Run `longeragent init` first, then retry the OpenTUI prototype.",
    );
  }

  const paths = resolveAssetPaths({
    templatesFlag: opts?.templates,
  });
  const mcpServers = loadMcpServers(paths.homeDir);
  const config = new Config({
    providerEnvVars: globalPreferences.providerEnvVars ?? {},
    localProviders: globalPreferences.localProviders ?? {},
    mcpServers,
  });

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

  let mcpManager: unknown = null;
  if (config.mcpServerConfigs.length > 0) {
    try {
      const { MCPClientManager } = await import("../src/mcp-client.js");
      mcpManager = new MCPClientManager(config.mcpServerConfigs);
    } catch {
      console.warn(
        "Warning: mcp.json configured but MCP client module not available. Install @modelcontextprotocol/sdk if needed.",
      );
    }
  }

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

  const contextRatio = globalPreferences.contextRatio ?? 1.0;
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

  try {
    if (globalPreferences.modelConfigName) {
      try {
        session.switchModel(globalPreferences.modelConfigName);
        session.setPersistedModelSelection?.({
          modelConfigName: globalPreferences.modelConfigName,
          modelProvider: globalPreferences.modelProvider,
          modelSelectionKey: globalPreferences.modelSelectionKey,
          modelId: globalPreferences.modelId,
        } satisfies PersistedModelSelection);
      } catch {
        if (
          globalPreferences.modelProvider
          && (globalPreferences.modelSelectionKey || globalPreferences.modelId)
        ) {
          const restored = resolveModelSelection(
            session,
            `${globalPreferences.modelProvider}:${globalPreferences.modelSelectionKey ?? globalPreferences.modelId}`,
          );
          session.switchModel(restored.selectedConfigName);
          session.setPersistedModelSelection?.({
            modelConfigName: restored.selectedConfigName,
            modelProvider: restored.modelProvider,
            modelSelectionKey: restored.modelSelectionKey,
            modelId: restored.modelId,
          } satisfies PersistedModelSelection);
        }
      }
    } else if (
      globalPreferences.modelProvider
      && (globalPreferences.modelSelectionKey || globalPreferences.modelId)
    ) {
      const restored = resolveModelSelection(
        session,
        `${globalPreferences.modelProvider}:${globalPreferences.modelSelectionKey ?? globalPreferences.modelId}`,
      );
      session.switchModel(restored.selectedConfigName);
      session.setPersistedModelSelection?.({
        modelConfigName: restored.selectedConfigName,
        modelProvider: restored.modelProvider,
        modelSelectionKey: restored.modelSelectionKey,
        modelId: restored.modelId,
      } satisfies PersistedModelSelection);
    }
  } catch (err) {
    console.warn(
      `Warning: failed to restore saved model preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  session.applyGlobalPreferences(globalPreferences);

  const commandRegistry = buildDefaultRegistry();
  registerSkillCommands(commandRegistry, session.skills);

  return {
    session,
    store,
    commandRegistry,
    verbose,
  };
}
