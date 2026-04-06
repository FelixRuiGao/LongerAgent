#!/usr/bin/env node

/**
 * CLI entry point for Vigil.
 *
 * Usage:
 *
 *   vigil                       # auto-detect config
 *   vigil init                  # run initialization wizard
 *   vigil --templates ./tpls    # explicit templates path
 *   vigil --verbose             # enable debug logging
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
import { getVigilHomeDir } from "./home-path.js";
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
import { setAccent } from "./accent.js";

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
    .name("vigil")
    .version(VERSION, "-V, --version", "Output the current version")
    .description("A terminal AI coding agent built for long sessions")
    .option("--templates <path>", "Path to agent_templates directory")
    .option("--verbose", "Enable debug logging");

  // Subcommands
  let ranSubcommand = false;
  program
    .command("init")
    .description("Initialize Vigil configuration")
    .action(async () => {
      ranSubcommand = true;
      const { runInitWizard } = await import("./init-wizard.js");
      await runInitWizard();
    });

  program
    .command("oauth [action] [service]")
    .description("Manage OAuth login for Codex or Copilot (login/status/logout)")
    .action(async (action?: string, service?: string) => {
      ranSubcommand = true;
      const { oauthCommand } = await import("./auth/openai-oauth.js");
      await oauthCommand(action, service);
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

  // Load ~/.vigil/.env before dispatching any subcommand so `init`
  // can detect previously saved keys and offer the expected reuse flow.
  loadDotenv(getVigilHomeDir());

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
        "  Run 'vigil init' to set up providers.",
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
      console.warn("Run 'vigil oauth' to re-authenticate.\n");
    }
  }

  // Startup credentials check for any model using GitHub Copilot OAuth.
  // The GitHub App user token is non-expiring, so there's nothing to refresh
  // — we just verify that credentials are present and warn the user if not.
  const copilotEntries = config.listModelEntries().filter(
    (e) => e.apiKeyRaw === "oauth:copilot",
  );
  if (copilotEntries.length > 0) {
    const { hasGitHubTokens } = await import(
      "./auth/github-copilot-oauth.js"
    );
    if (!hasGitHubTokens()) {
      console.warn("Warning: GitHub Copilot credentials missing.");
      console.warn("Run 'vigil oauth' to log in.\n");
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

  // Launch TUI (OpenTUI-based). The OpenTUI entry point performs its own
  // runtime bootstrap via `bootstrapOpenTuiRuntime()`; the session/registry
  // prepared above is kept to honor CLI-level side effects such as the init
  // wizard, OAuth token refresh, and accent restoration.
  void session;
  void commandRegistry;
  void store;
  // Dynamic path to keep opentui-src out of src/'s rootDir typecheck scope.
  // At runtime, tsx/bun/node resolves this relative to the current file.
  const opentuiEntry = "../opentui-src/main.js";
  const mod = (await import(opentuiEntry)) as { launchTui: () => Promise<void> };
  await mod.launchTui();
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
