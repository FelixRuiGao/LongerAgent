#!/usr/bin/env bun

/**
 * CLI entry point for Fermi.
 *
 * Usage:
 *
 *   fermi                       # auto-detect config
 *   fermi init                  # run initialization wizard
 *   fermi --templates ./tpls    # explicit templates path
 *   fermi --verbose             # enable debug logging
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
import {
  SessionStore,
  fixStorage,
  loadGlobalSettings,
  loadLocalSettings,
  mergeSettings,
  loadModelSelectionState,
  settingsToConfigInputs,
} from "./persistence.js";
import { loadDotenv } from "./dotenv.js";
import { getFermiHomeDir } from "./home-path.js";
import { checkForUpdates } from "./update-check.js";
import { VERSION } from "./version.js";
import {
  buildDefaultRegistry,
  registerSkillCommands,
  reRegisterSkillCommands,
} from "./commands.js";
import type { PersistedModelSelection } from "./model-selection.js";
import { applyPersistedModelSelectionToSession } from "./model-restore.js";
import { hasAnyManagedCredential } from "./managed-provider-credentials.js";
import { setAccent } from "./accent.js";
import { findSessionById } from "./session-resume.js";

/**
 * Handle `fermi --resume <id>` before Commander parses argv.
 *
 * Looks the session up across all projects in the Fermi home. If it lives
 * under a different cwd, prompts the user to switch (Y) or quit (N). On
 * success, stashes the resolved session dir in an env var so that
 * `launchTui()` can call `applySessionRestore` after bootstrap. The flag and
 * its argument are spliced out of argv so Commander never sees them.
 */
async function maybeHandleResumeFlag(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--resume");
  if (idx < 0) return;

  const id = argv[idx + 1];
  if (!id || id.startsWith("--")) {
    console.error("Error: --resume requires a session ID.");
    console.error("Usage: fermi --resume <sessionId>");
    process.exit(1);
  }

  const found = findSessionById(id);
  if (!found) {
    console.error(`Error: session not found: ${id}`);
    process.exit(1);
  }

  const cwd = process.cwd();
  if (found.projectPath && found.projectPath !== cwd) {
    let willCd: boolean;
    try {
      const { confirm } = await import("@inquirer/prompts");
      willCd = await confirm({
        message: `This session lives in ${found.projectPath}.\n  Switch to that directory and resume?`,
        default: true,
      });
    } catch {
      process.exit(130); // user Ctrl+C
    }
    if (!willCd) process.exit(0);
    try {
      process.chdir(found.projectPath);
    } catch (e) {
      console.error(`Error: failed to chdir to ${found.projectPath}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  process.env["FERMI_RESUME_SESSION_DIR"] = found.sessionDir;
  argv.splice(idx, 2);
}

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
  // ── --resume <id> short-circuit ──
  // Locate the session globally; if it lives under a different project, ask
  // before chdir'ing. Has to run before Commander parses the rest of argv,
  // so the session-resolved cwd is in effect for everything below.
  await maybeHandleResumeFlag(argv);

  // Server mode short-circuit — bypass commander/TUI entirely.
  // The GUI (Electron main process) spawns this with `--server --work-dir <path>`.
  if (argv.includes("--server")) {
    const args = argv.slice(2);
    const getFlag = (name: string): string | undefined => {
      const idx = args.indexOf(name);
      return idx >= 0 ? args[idx + 1] : undefined;
    };
    const workDir = getFlag("--work-dir") ?? process.cwd();
    const sessionId = getFlag("--session-id");
    const selectedModel = getFlag("--model");
    const selectedAgent = getFlag("--agent");
    const templates = getFlag("--templates");
    const { runServerMode } = await import("./server/server-mode.js");
    try {
      await runServerMode({ workDir, sessionId, selectedModel, selectedAgent, templates });
    } catch (err) {
      process.stderr.write(
        `[fermi --server] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    return;
  }

  const program = new Command();
  program
    .name("fermi")
    .version(VERSION, "-V, --version", "Output the current version")
    .description("A terminal AI coding agent built for long sessions")
    .option("--templates <path>", "Path to agent_templates directory")
    .option("--verbose", "Enable debug logging");

  // Subcommands
  let ranSubcommand = false;
  program
    .command("init")
    .description("Initialize Fermi configuration")
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

  // Load ~/.fermi/.env before dispatching any subcommand so `init`
  // can detect previously saved keys and offer the expected reuse flow.
  loadDotenv(getFermiHomeDir());

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

  // ── Load settings (global + local merge) ──
  const homeDir = getFermiHomeDir();
  let globalSettings = loadGlobalSettings(homeDir);
  const localSettings = loadLocalSettings(process.cwd(), store.projectDir);
  let settings = mergeSettings(globalSettings, localSettings);

  // If no providers configured, run initialization wizard
  const { providerEnvVars, localProviders, mcpServers } = settingsToConfigInputs(settings);
  let hasProviders =
    Object.keys(providerEnvVars).length > 0
    || Object.keys(localProviders).length > 0
    || hasAnyManagedCredential();

  if (!hasProviders) {
    console.log("No providers configured. Starting setup wizard...\n");
    try {
      const { runInitWizard } = await import("./init-wizard.js");
      await runInitWizard();
      // Re-load settings after wizard completes
      globalSettings = loadGlobalSettings(homeDir);
      settings = mergeSettings(globalSettings, localSettings);
    } catch {
      console.error(
        "Error: no providers configured.\n" +
        "  Run 'fermi init' to set up providers.",
      );
      process.exit(1);
    }
  }

  // Resolve asset paths: templates, prompts, skills
  const paths = resolveAssetPaths({
    templatesFlag: opts.templates,
    projectPath: process.cwd(),
  });

  // ── Build Config from settings ──
  const configInputs = settingsToConfigInputs(settings);
  const config = new Config({
    providerEnvVars: configInputs.providerEnvVars,
    localProviders: configInputs.localProviders,
    mcpServers: configInputs.mcpServers,
    modelTiers: settings.model_tiers,
    agentModels: settings.agent_models,
    subAgentInheritMcp: settings.sub_agent_inherit_mcp,
    subAgentInheritHooks: settings.sub_agent_inherit_hooks,
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
      console.warn("Run 'fermi oauth' to re-authenticate.\n");
    }
  }

  // Startup credentials check for any model using GitHub Copilot OAuth.
  const copilotEntries = config.listModelEntries().filter(
    (e) => e.apiKeyRaw === "oauth:copilot",
  );
  if (copilotEntries.length > 0) {
    const { hasGitHubTokens } = await import(
      "./auth/github-copilot-oauth.js"
    );
    if (!hasGitHubTokens()) {
      console.warn("Warning: GitHub Copilot credentials missing.");
      console.warn("Run 'fermi oauth' to log in.\n");
    }
  }

  // Initialise MCP client manager
  let mcpManager: unknown = null;
  if (config.mcpServerConfigs.length > 0) {
    try {
      const { MCPClientManager } = await import("./mcp-client.js");
      mcpManager = new MCPClientManager(config.mcpServerConfigs);
    } catch {
      console.warn(
        "Warning: MCP servers configured but MCP client module not available. " +
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

  // Load agent templates (bundled + user-global + project-local, with layered prompt assembly)
  const agents = loadTemplates(
    bundledTemplates,
    config,
    mcpManager as any,
    promptsDirs,
    paths.templatesPath ?? undefined,
    paths.projectTemplatesPath ?? undefined,
  );
  const primary = identifyPrimaryAgent(agents);

  // Load skills (four-layer: bundled > global > project > workspace)
  const bundledSkills = join(bundledDir, "skills");
  const skillRoots: string[] = [];
  if (existsSync(bundledSkills) && statSync(bundledSkills).isDirectory()) {
    skillRoots.push(bundledSkills);
  }
  skillRoots.push(...paths.skillRoots);
  const skills = loadSkillsMulti(skillRoots);

  // ── Load hooks (four-layer: global > project > workspace) ──
  let hooksLoaded: import("./hooks/index.js").HookManifest[] = [];
  try {
    const { loadHooksMulti } = await import("./hooks/index.js");
    hooksLoaded = loadHooksMulti(paths.hookRoots);
  } catch { /* hooks module optional */ }

  // ── Build Session ──
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

  // ── Register hooks with session ──
  if (hooksLoaded.length > 0) {
    session.hookRuntime.setHooks(hooksLoaded);
  }

  // ── Restore model selection ──
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
