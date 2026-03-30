#!/usr/bin/env node

/**
 * CLI entry point for LongerAgent.
 *
 * Usage:
 *
 *   longeragent                       # auto-detect config
 *   longeragent init                  # run initialization wizard
 *   longeragent --templates ./tpls    # explicit templates path
 *   longeragent --verbose             # enable debug logging
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import { Config, resolveAssetPaths, getBundledAssetsDir } from "./config.js";
import { Agent } from "./agents/agent.js";
import { Session } from "./session.js";
import { loadTemplates } from "./templates/loader.js";
import { loadSkillsMulti } from "./skills/loader.js";
import { SessionStore, fixStorage } from "./persistence.js";
import { loadMcpServers } from "./mcp-config.js";
import { loadDotenv } from "./dotenv.js";
import { getLongerAgentHomeDir } from "./home-path.js";
import { checkForUpdates } from "./update-check.js";
import { VERSION } from "./version.js";
import {
  buildDefaultRegistry,
  registerSkillCommands,
  reRegisterSkillCommands,
} from "./commands.js";
import type { PersistedModelSelection } from "./model-selection.js";
import { applyPersistedModelSelectionToSession } from "./model-restore.js";
import { hasAnyManagedCredential, isManagedProvider } from "./managed-provider-credentials.js";
import type { Session as TuiSession } from "./ui/contracts.js";
import { setAccent } from "./tui/theme.js";

// ------------------------------------------------------------------
// Primary agent resolution
// ------------------------------------------------------------------

function identifyPrimaryAgent(
  agents: Record<string, Agent>,
  name = "main",
): Agent {
  const agent = agents[name];
  if (agent) return agent;

  // Fallback: first agent alphabetically
  const names = Object.keys(agents).sort();
  if (names.length > 0) {
    const firstName = names[0];
    console.warn(
      `Warning: '${name}' agent not found, using '${firstName}' instead.`,
    );
    return agents[firstName];
  }

  console.error("Error: no agent templates found.");
  process.exit(1);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("longeragent")
    .version(VERSION, "-V, --version", "Output the current version")
    .description("A terminal AI coding agent built for long sessions")
    .option("--templates <path>", "Path to agent_templates directory")
    .option("--verbose", "Enable debug logging");

  // Subcommands
  let ranSubcommand = false;
  program
    .command("init")
    .description("Initialize LongerAgent configuration")
    .action(async () => {
      ranSubcommand = true;
      const { runInitWizard } = await import("./init-wizard.js");
      await runInitWizard();
    });

  program
    .command("oauth [action]")
    .description("Manage OpenAI ChatGPT OAuth login (login/status/logout)")
    .action(async (action?: string) => {
      ranSubcommand = true;
      const { oauthCommand } = await import("./auth/openai-oauth.js");
      await oauthCommand(action);
    });

  program
    .command("fix")
    .description("Check and repair session storage (missing project.json / meta.json)")
    .action(() => {
      ranSubcommand = true;
      console.log("Checking session storage...\n");
      const result = fixStorage();
      console.log(`Projects checked: ${result.projectsChecked}`);
      console.log(`Projects fixed:   ${result.projectsFixed}`);
      console.log(`Sessions checked: ${result.sessionsChecked}`);
      console.log(`Sessions fixed:   ${result.sessionsFixed}`);
      if (result.warnings.length > 0) {
        console.log(`\nWarnings:`);
        for (const w of result.warnings) {
          console.log(`  - ${w}`);
        }
      }
      if (result.projectsFixed === 0 && result.sessionsFixed === 0) {
        console.log("\nAll good — no repairs needed.");
      } else {
        console.log(`\nDone — repaired ${result.projectsFixed + result.sessionsFixed} items.`);
      }
    });

  // Default action — prevents Commander from showing help and exiting
  // when no subcommand is provided.
  program.action(() => {});

  // Load ~/.longeragent/.env before dispatching any subcommand so `init`
  // can detect previously saved keys and offer the expected reuse flow.
  loadDotenv(getLongerAgentHomeDir());

  await program.parseAsync(argv);

  // If a subcommand ran, exit — don't continue into TUI
  if (ranSubcommand) return;

  const opts = program.opts<{
    templates?: string;
    verbose?: boolean;
  }>();

  // Start update check in background (non-blocking)
  const showUpdateNotice = checkForUpdates(VERSION);

  // Logging
  if (opts.verbose) {
    const origDebug = console.debug;
    console.debug = (...args: unknown[]) => origDebug("[DEBUG]", ...args);
  }

  // Session store (also used for loading preferences)
  let store: SessionStore;
  try {
    store = new SessionStore({ projectPath: process.cwd() });
  } catch (e) {
    console.error(
      `Error: Failed to initialize session storage.\n` +
      `Reason: ${e}\n` +
      `Possible causes:\n` +
      `  - File permission issues`,
    );
    process.exit(1);
  }

  // Load global preferences (provider env vars, model selection, etc.)
  let globalPreferences = store.loadGlobalPreferences();

  // If no providers configured, run initialization wizard
  const hasLegacyCloudProviders = Boolean(
    globalPreferences.providerEnvVars
      && Object.keys(globalPreferences.providerEnvVars).some((providerId) => !isManagedProvider(providerId)),
  );
  const hasProviders = hasLegacyCloudProviders
    || (globalPreferences.localProviders && Object.keys(globalPreferences.localProviders).length > 0)
    || hasAnyManagedCredential();

  if (!hasProviders) {
    console.log("No providers configured. Starting setup wizard...\n");
    try {
      const { runInitWizard } = await import("./init-wizard.js");
      await runInitWizard();
      // Re-load preferences after wizard completes
      globalPreferences = store.loadGlobalPreferences();
    } catch {
      console.error(
        "Error: no providers configured.\n" +
        "  Run 'longeragent init' to set up providers.",
      );
      process.exit(1);
    }
  }

  // Resolve asset paths: templates, prompts, skills
  const paths = resolveAssetPaths({
    templatesFlag: opts.templates,
  });

  // Build Config from preferences
  const mcpServers = loadMcpServers(paths.homeDir);
  const config = new Config({
    providerEnvVars: globalPreferences.providerEnvVars ?? {},
    localProviders: globalPreferences.localProviders ?? {},
    mcpServers,
  });

  // Refresh OAuth tokens if any model uses them (before building providers)
  const oauthEntries = config.listModelEntries().filter(
    (e) => e.apiKeyRaw === "oauth:openai-codex",
  );
  if (oauthEntries.length > 0) {
    try {
      const { ensureFreshToken } = await import("./auth/openai-oauth.js");
      await ensureFreshToken();
    } catch (err) {
      console.warn(
        `Warning: OAuth token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.warn("Run 'longeragent oauth' to re-authenticate.\n");
    }
  }

  // Initialise MCP client manager (if mcp.json configured)
  let mcpManager: unknown = null;
  if (config.mcpServerConfigs.length > 0) {
    try {
      // Dynamic import to keep MCP optional
      const { MCPClientManager } = await import("./mcp-client.js");
      mcpManager = new MCPClientManager(config.mcpServerConfigs);
    } catch {
      console.warn(
        "Warning: mcp.json configured but MCP client module not available. " +
          "Install with: npm install @modelcontextprotocol/sdk",
      );
    }
  }

  // Bundled assets (always available from the installed package)
  const bundledDir = getBundledAssetsDir();
  const bundledTemplates = join(bundledDir, "agent_templates");
  const bundledPrompts = join(bundledDir, "prompts");

  // Build ordered prompts dirs: user override first, bundled second
  const promptsDirs: string[] = [];
  if (paths.promptsPath) promptsDirs.push(paths.promptsPath);
  promptsDirs.push(bundledPrompts);

  // Load agent templates (bundled + user override, with layered prompt assembly)
  const agents = loadTemplates(
    bundledTemplates,
    config,
    mcpManager as any,
    promptsDirs,
    paths.templatesPath ?? undefined,
  );
  const primary = identifyPrimaryAgent(agents);

  // Load skills (user overrides layered on top of bundled defaults).
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

  // Build Session
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

  // Restore model selection from preferences
  try {
    if (
      globalPreferences.modelConfigName
      || (globalPreferences.modelProvider && (globalPreferences.modelSelectionKey || globalPreferences.modelId))
    ) {
      applyPersistedModelSelectionToSession(
        session,
        {
          modelConfigName: globalPreferences.modelConfigName,
          modelProvider: globalPreferences.modelProvider,
          modelSelectionKey: globalPreferences.modelSelectionKey,
          modelId: globalPreferences.modelId,
        } satisfies PersistedModelSelection,
      );
    }
  } catch (err) {
    console.warn(
      `Warning: failed to restore saved model preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  session.applyGlobalPreferences(globalPreferences);
  if (globalPreferences.accentColor) {
    setAccent(globalPreferences.accentColor);
  }

  // Commands
  const commandRegistry = buildDefaultRegistry();
  registerSkillCommands(commandRegistry, session.skills);

  // Show update notice (if background check found a newer version)
  showUpdateNotice();

  // Launch TUI
  const { launchTui } = await import("./tui/launch.js");
  await launchTui(session as unknown as TuiSession, commandRegistry, store, {
    verbose: opts.verbose,
  });
}

function normalizeEntryPath(pathValue: string | undefined): string | null {
  if (!pathValue) return null;
  try {
    return realpathSync(resolve(pathValue));
  } catch {
    return null;
  }
}

const entryPath = normalizeEntryPath(process.argv[1]);
const modulePath = normalizeEntryPath(fileURLToPath(import.meta.url));
if (entryPath && modulePath && entryPath === modulePath) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
