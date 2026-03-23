/**
 * Extensible slash-command system.
 *
 * Usage:
 *
 *   const registry = buildDefaultRegistry();
 *   const cmd = registry.lookup("/help");
 *   if (cmd) {
 *     await cmd.handler(ctx, "");
 *   }
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore, LocalProviderConfig } from "./persistence.js";
import { loadLog, validateAndRepairLog } from "./persistence.js";
import { fetchModelsFromServer } from "./model-discovery.js";
import {
  getThinkingLevels,
} from "./config.js";
import {
  PROVIDER_PRESETS,
  findProviderPreset,
} from "./provider-presets.js";
import {
  resolveModelSelection as resolveModelSelectionCore,
  parseProviderModelTarget,
  runtimeModelName,
} from "./model-selection.js";
import {
  isManagedProvider,
} from "./managed-provider-credentials.js";
import {
  ensureManagedProviderCredential,
  type CredentialPromptAdapter,
  type PromptSecretRequest,
  type PromptSelectRequest,
} from "./provider-credential-flow.js";
import { resolveSkillContent, type SkillMeta } from "./skills/loader.js";
import { ACCENT_PRESETS, DEFAULT_ACCENT, setAccent, theme } from "./tui/theme.js";
import { buildModelPickerTree, toCommandPickerOptions } from "./model-picker-tree.js";
import { formatCurrentModelScopedLabel, getCurrentModelDescriptor } from "./model-presentation.js";
import { hasOAuthTokens, isTokenExpiring, readOAuthAccessToken, clearOAuthTokens } from "./auth/openai-oauth.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/**
 * Callback used by command handlers to display a message to the user.
 * The TUI layer supplies the concrete implementation.
 */
export type ShowMessageFn = (text: string) => void;

/**
 * Context passed to every command handler.
 *
 * Uses a generic interface so command handlers don't need direct TUI imports.
 */
export interface CommandContext {
  /** The active Session instance (typed as `any` to avoid circular deps). */
  session: any;

  /** Display a message in the conversation area. */
  showMessage: ShowMessageFn;

  /** The SessionStore for persistence (may be undefined). */
  store?: SessionStore;

  /** Auto-save the current session (TUI provides the implementation). */
  autoSave: () => void;

  /** Reset TUI state (cancel workers, clear spinners, etc.). */
  resetUiState: () => void;

  /** The command registry itself, so /help can enumerate commands. */
  commandRegistry: CommandRegistry;

  /** Request TUI-layer graceful exit. */
  exit?: () => Promise<void> | void;

  /** Inject content as a user message and trigger a new turn. */
  onTurnRequested?: (content: string) => void;

  /** Trigger a manual summarize request through the TUI turn pipeline. */
  onManualSummarizeRequested?: (instruction: string) => void;

  /** Trigger a manual compact request through the TUI execution pipeline. */
  onManualCompactRequested?: (instruction: string) => void;

  /** Prompt the user to choose one option during command execution. */
  promptSelect?: (request: PromptSelectRequest) => Promise<string | undefined>;

  /** Prompt the user for a secret value during command execution. */
  promptSecret?: (request: PromptSecretRequest) => Promise<string | undefined>;

  /** Show the inline OAuth login overlay and return tokens (or null on cancel). */
  requestOAuthLogin?: () => Promise<import("./auth/openai-oauth.js").OAuthTokens | null>;
}

/**
 * An option entry for command overlays.
 */
export interface CommandOption {
  /** Display label shown in the overlay. */
  label: string;
  /** Value submitted as the command argument when selected. */
  value: string;
  /** Child options for hierarchical selection (e.g., provider → model). */
  children?: CommandOption[];
  /** Checked state for checkbox picker mode. */
  checked?: boolean;
}

/** Context available when building dynamic picker options for a slash command. */
export interface CommandOptionsContext {
  session: any;
  store?: SessionStore;
}

/**
 * A single slash command.
 */
export interface SlashCommand {
  /** The command name, e.g. "/resume". */
  name: string;
  /** Short description shown in /help output. */
  description: string;
  /** Async handler invoked when the command is executed. */
  handler: (ctx: CommandContext, args: string) => Promise<void>;
  /**
   * Optional callback that returns dynamic overlay options for this command.
   * When present, typing the command shows an option picker overlay.
   * Receives session/store context so it can compute dynamic picker options.
   */
  options?: (ctx: CommandOptionsContext) => CommandOption[];
  /** When true, TUI uses a checkbox multi-select picker instead of single-select. */
  checkboxMode?: boolean;
}

export class CommandExitSignal extends Error {
  code: number;

  constructor(code = 0) {
    super(`Command requested exit (${code})`);
    this.name = "CommandExitSignal";
    this.code = code;
  }
}

export function isCommandExitSignal(err: unknown): err is CommandExitSignal {
  return err instanceof CommandExitSignal ||
    ((err as { name?: unknown; code?: unknown } | null | undefined)?.name === "CommandExitSignal" &&
      typeof (err as { code?: unknown } | null | undefined)?.code === "number");
}

// ------------------------------------------------------------------
// CommandRegistry
// ------------------------------------------------------------------

export class CommandRegistry {
  private _commands = new Map<string, SlashCommand>();

  /** Register a command. Overwrites any existing command with the same name. */
  register(cmd: SlashCommand): void {
    this._commands.set(cmd.name, cmd);
  }

  /** Remove a command by its exact name. Returns true if it existed. */
  unregister(name: string): boolean {
    return this._commands.delete(name);
  }

  /** Look up a command by its exact name. */
  lookup(name: string): SlashCommand | undefined {
    return this._commands.get(name);
  }

  /** Return all registered commands sorted alphabetically by name. */
  getAll(): SlashCommand[] {
    return Array.from(this._commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Return command names that start with the given prefix (for completion). */
  getCompletions(prefix: string): string[] {
    const results: string[] = [];
    for (const name of Array.from(this._commands.keys())) {
      if (name.startsWith(prefix)) {
        results.push(name);
      }
    }
    return results.sort();
  }
}

// ------------------------------------------------------------------
// Built-in command handlers
// ------------------------------------------------------------------

async function cmdHelp(ctx: CommandContext, _args: string): Promise<void> {
  const lines: string[] = ["Commands:"];
  for (const cmd of ctx.commandRegistry.getAll()) {
    lines.push(`  ${cmd.name}  ${cmd.description}`);
  }

  lines.push("");
  lines.push("Shortcuts:");
  lines.push("  Enter        Send message");
  lines.push("  Option+Enter Insert newline");
  lines.push("  Ctrl+N       Insert newline");
  lines.push("  Ctrl+G       Toggle markdown raw view");
  lines.push("  Cmd+Delete   Delete to line start (Ghostty/kitty protocol)");
  lines.push("  Alt+Backspace/Ctrl+W Delete previous word");
  lines.push("  Ctrl+C       Cancel / Exit");
  lines.push("  @filename    Attach file");

  ctx.showMessage(lines.join("\n"));
}

async function cmdNew(ctx: CommandContext, _args: string): Promise<void> {
  ctx.autoSave();

  // Clear session dir — a new directory will be created lazily on first save.
  // This avoids creating an empty session file when the user doesn't send any messages.
  if (ctx.store) {
    ctx.store.clearSession();
  }

  // Full session reset — store is updated, then conversation re-initialized
  // with correct paths. Equivalent to constructing a fresh Session.
  await ctx.session.resetForNewSession(ctx.store);
  ctx.resetUiState();
}

async function cmdSummarize(ctx: CommandContext, args: string): Promise<void> {
  if (!ctx.onManualSummarizeRequested) {
    ctx.showMessage("Manual summarize is not available in this UI.");
    return;
  }
  ctx.onManualSummarizeRequested(args.trim());
}

async function cmdCompact(ctx: CommandContext, args: string): Promise<void> {
  if (!ctx.onManualCompactRequested) {
    ctx.showMessage("Manual compact is not available in this UI.");
    return;
  }
  ctx.onManualCompactRequested(args.trim());
}

async function cmdResume(ctx: CommandContext, args: string): Promise<void> {
  const store = ctx.store;
  if (!store) {
    ctx.showMessage("Session persistence not available.");
    return;
  }

  const sessions = store.listSessions();
  if (sessions.length === 0) {
    ctx.showMessage("No saved sessions found.");
    return;
  }

  const trimmed = args.trim();
  if (!trimmed) {
    // List sessions
    const lines: string[] = ["Recent Sessions:"];
    const shown = sessions.slice(0, 10);
    for (let i = 0; i < shown.length; i++) {
      const s = shown[i];
      const created = s.created
        ? s.created.slice(0, 19).replace("T", " ")
        : "?";
      const displayName = truncateDisplayText(s.title || s.summary || "(empty)", 25);
      lines.push(`  ${i + 1}  ${created}  ${s.turns}t  ${displayName}`);
    }
    lines.push("");
    lines.push("Use /resume <number> to load a session.");
    ctx.showMessage(lines.join("\n"));
    return;
  }

  // Load specific session
  const idx = parseInt(trimmed, 10) - 1;
  if (isNaN(idx)) {
    ctx.showMessage(`Invalid session number: ${trimmed}`);
    return;
  }
  if (idx < 0 || idx >= sessions.length) {
    ctx.showMessage(`Session number out of range (1-${sessions.length}).`);
    return;
  }

  // Auto-save current first
  ctx.autoSave();

  const target = sessions[idx];
  const session = ctx.session;
  const logJsonPath = join(target.path, "log.json");
  const hasLogJson = existsSync(logJsonPath);

  if (!hasLogJson) {
    ctx.showMessage("No log.json found for this session.");
    return;
  }

  let logData;
  try {
    logData = loadLog(target.path);
  } catch (e) {
    ctx.showMessage(
      `Failed to load log: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // Validate and repair
  const { entries: repairedEntries, repaired, warnings } = validateAndRepairLog(logData.entries);
  if (repaired) {
    for (const w of warnings) {
      ctx.showMessage(`[repair] ${w}`);
    }
  }

  ctx.resetUiState();

  try {
    session.restoreFromLog(logData.meta, repairedEntries, logData.idAllocator);
  } catch (e) {
    ctx.showMessage(
      `Failed to restore session: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // Point store at the loaded session
  store.sessionDir = target.path;
  if (typeof session.setStore === "function") {
    session.setStore(store);
  }
}

function buildResumeOptionLabel(
  index: number,
  created: string | undefined,
  turns: number | undefined,
  summary: string | undefined,
): string {
  const date = (created || "").slice(0, 16);
  const normalized = (summary || "").replace(/\s+/g, " ").trim();
  return `${index + 1}. ${date}  ${turns ?? 0} turns  ${normalized}`;
}

function truncateDisplayText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return Array.from(normalized).slice(0, maxChars).join("");
}

function resumeOptions(ctx: CommandOptionsContext): CommandOption[] {
  const store = ctx.store;
  if (!store) return [];
  const sessions = store.listSessions();
  return sessions.map((s, i) => ({
    label: buildResumeOptionLabel(i, s.created, s.turns, s.title || s.summary),
    value: String(i + 1),
  }));
}

async function cmdQuit(ctx: CommandContext, _args: string): Promise<void> {
  if (ctx.exit) {
    await ctx.exit();
    return;
  }

  ctx.autoSave();
  try {
    if (typeof ctx.session.close === "function") {
      await ctx.session.close();
    }
  } catch {
    // ignore
  }
  // Non-TUI callers decide how to handle shutdown.
  throw new CommandExitSignal(0);
}

function currentSessionModelDisplayName(session: any): string {
  return getCurrentModelDescriptor(session)?.compactScopedDetailedLabel ?? "";
}

function persistGlobalPreferences(ctx: CommandContext): void {
  if (!ctx.store || typeof ctx.store.saveGlobalPreferences !== "function") return;
  if (typeof ctx.session.getGlobalPreferences !== "function") return;
  try {
    const current = ctx.session.getGlobalPreferences();
    const existing = typeof ctx.store.loadGlobalPreferences === "function"
      ? ctx.store.loadGlobalPreferences()
      : undefined;
    ctx.store.saveGlobalPreferences({
      ...existing,
      ...current,
      providerEnvVars: current.providerEnvVars ?? existing?.providerEnvVars,
      localProviders: current.localProviders ?? existing?.localProviders,
      contextRatio: current.contextRatio ?? existing?.contextRatio,
    });
  } catch {
    // Ignore preference persistence failures during command execution.
  }
}

function thinkingOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const model = session.currentModelName ?? "";
  const levels = getThinkingLevels(model);
  const current = session.thinkingLevel ?? "default";

  const opts: CommandOption[] = [];
  // "default" is always available as reset option
  opts.push({
    label: current === "default" ? "default  (current)" : "default",
    value: "default",
  });
  for (const level of levels) {
    const isCurrent = current === level;
    opts.push({
      label: isCurrent ? `${level}  (current)` : level,
      value: level,
    });
  }
  return opts;
}

async function cmdThinking(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const model = session.currentModelName;
  const displayModel = currentSessionModelDisplayName(session);
  const levels = getThinkingLevels(model);
  const trimmed = args.trim().toLowerCase();

  if (!trimmed) {
    // No arg: show info (fallback for non-overlay usage)
    const current = session.thinkingLevel;
    if (!levels.length) {
      ctx.showMessage(`Model '${displayModel}' does not support configurable thinking levels.`);
    } else {
      ctx.showMessage(
        `Thinking level: ${current}\n` +
        `Available levels for ${displayModel}: ${levels.join(", ")}`,
      );
    }
    return;
  }

  if (trimmed === "default") {
    session.thinkingLevel = "default";
    persistGlobalPreferences(ctx);
    ctx.showMessage("Thinking level reset to provider default.");
    return;
  }

  if (levels.length && !levels.includes(trimmed)) {
    ctx.showMessage(
      `Invalid level '${trimmed}' for ${displayModel}.\n` +
      `Available: ${levels.join(", ")}`,
    );
    return;
  }

  session.thinkingLevel = trimmed;
  persistGlobalPreferences(ctx);
  ctx.showMessage(`Thinking level set to: ${trimmed}`);
}

function cacheHitOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const enabled = session.cacheHitEnabled ?? true;
  return [
    { label: enabled ? "ON  (current)" : "ON", value: "on" },
    { label: enabled ? "OFF" : "OFF  (current)", value: "off" },
  ];
}

async function cmdCacheHit(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const trimmed = args.trim().toLowerCase();

  if (trimmed === "on") {
    session.cacheHitEnabled = true;
  } else if (trimmed === "off") {
    session.cacheHitEnabled = false;
  } else {
    // No argument toggles the current setting.
    session.cacheHitEnabled = !session.cacheHitEnabled;
  }

  persistGlobalPreferences(ctx);

  const state = session.cacheHitEnabled ? "ON" : "OFF";
  const provider = session.primaryAgent?.modelConfig?.provider ?? "";
  let note = "";
  if (provider === "anthropic") {
    note = session.cacheHitEnabled
      ? " (cache_control markers will be sent)"
      : " (cache_control markers disabled)";
  } else if (provider === "openrouter") {
    note = " (Cache is automatic via OpenRouter for supported models)";
  } else {
    note = " (Cache is automatic for this provider)";
  }

  ctx.showMessage(`Prompt caching: ${state}${note}`);
}

// ------------------------------------------------------------------
// /model command
// ------------------------------------------------------------------

function parseModelArgs(args: string): { target: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const target = tokens[0] ?? "";
  const rest = tokens.slice(1);
  const inlineKeySyntax = rest.some((t) => t.startsWith("key=") || t.startsWith("api_key="));
  if (inlineKeySyntax || rest.length === 1) {
    throw new Error(
      "Inline API keys in `/model` are no longer supported.\n" +
      "Use `/model` to select the model and follow the prompt to import or paste a key,\n" +
      "or run 'longeragent init' to configure providers.",
    );
  }
  if (rest.length > 0) {
    throw new Error(
      "Invalid /model arguments.\n" +
      "Use a config name or provider:model (for example `openai:gpt-5.4`).",
    );
  }
  return { target };
}

function createCommandPromptAdapter(ctx: CommandContext): CredentialPromptAdapter | null {
  if (!ctx.promptSelect || !ctx.promptSecret) return null;
  return {
    select: (request) => ctx.promptSelect!(request),
    secret: (request) => ctx.promptSecret!(request),
  };
}

export function resolveModelSelection(
  session: any,
  target: string,
) {
  return resolveModelSelectionCore(session, target);
}

/**
 * Build options for /model picker.
 *
 * Supports three structures:
 * - Two-level: provider → model (for ungrouped providers like anthropic, openai)
 * - Three-level via group field: group → sub-provider → model (kimi, glm, minimax)
 * - Three-level via vendor prefix: openrouter → vendor → model
 */
function modelOptions(ctx: CommandOptionsContext): CommandOption[] {
  return toCommandPickerOptions(buildModelPickerTree({ session: ctx.session })) as CommandOption[];
}

/**
 * /model command: switch model by creating a new session.
 *
 * The selected value is either a config name or a provider:model target.
 */
async function cmdModel(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const trimmed = args.trim();

  if (!trimmed) {
    const current = currentSessionModelDisplayName(session) || "unknown";
    ctx.showMessage(
      `Current model: ${current}\n` +
      "Use /model to select a new model.\n" +
      "For models marked 'key missing', run 'longeragent init' or select the model to import/paste a key.",
    );
    return;
  }

  if (!session.switchModel) {
    ctx.showMessage("Model switching is not supported in this session.");
    return;
  }

  try {
    const { target } = parseModelArgs(trimmed);

    // ── Local provider discovery: "ollama:__discover__" ──
    if (target.endsWith(":__discover__")) {
      await cmdModelLocalDiscover(ctx, target.split(":")[0]);
      return;
    }

    // ── Codex OAuth check: ensure valid token before resolving ──
    const parsedForCodex = parseProviderModelTarget(target);
    if (parsedForCodex?.provider === "openai-codex") {
      const existingToken = readOAuthAccessToken();
      const needsLogin = !hasOAuthTokens()
        || (existingToken && isTokenExpiring(existingToken));
      if (needsLogin && ctx.requestOAuthLogin) {
        const tokens = await ctx.requestOAuthLogin();
        if (!tokens) {
          ctx.showMessage("Model switch cancelled.");
          return;
        }
      } else if (needsLogin) {
        ctx.showMessage(
          "OpenAI OAuth token is missing or expired.\n" +
          "Run 'longeragent oauth' to log in.",
        );
        return;
      }
    }

    let resolvedSelection;
    try {
      resolvedSelection = resolveModelSelection(session, target);
    } catch (err) {
      const parsed = parseProviderModelTarget(target);
      const adapter = createCommandPromptAdapter(ctx);
      if (parsed && isManagedProvider(parsed.provider) && adapter) {
        const result = await ensureManagedProviderCredential(
          parsed.provider,
          adapter,
          { mode: "model", allowReplaceExisting: false },
        );
        if (result.status === "skipped") {
          ctx.showMessage("Model switch cancelled.");
          return;
        }
        resolvedSelection = resolveModelSelection(session, target);
      } else {
        throw err;
      }
    }
    const { selectedConfigName, selectedHint } = resolvedSelection;

    // Save current session before switching
    ctx.resetUiState();
    ctx.autoSave();
    if (ctx.store) {
      ctx.store.clearSession();
    }

    // Switch model, then create fresh session
    session.switchModel(selectedConfigName);
    session.setPersistedModelSelection?.({
      modelConfigName: selectedConfigName,
      modelProvider: resolvedSelection.modelProvider,
      modelSelectionKey: resolvedSelection.modelSelectionKey,
      modelId: resolvedSelection.modelId,
    });
    await session.resetForNewSession(ctx.store);
    persistGlobalPreferences(ctx);

    void selectedHint;
  } catch (e) {
    ctx.showMessage(`Failed to switch model: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Local provider discovery sub-flow for /model.
 * Scans the server, lets user pick a model, registers it, and switches.
 */
async function cmdModelLocalDiscover(ctx: CommandContext, providerId: string): Promise<void> {
  const session = ctx.session;
  const preset = findProviderPreset(providerId);
  if (!preset?.localServer) {
    ctx.showMessage(`'${providerId}' is not a local provider.`);
    return;
  }
  if (!ctx.promptSelect) {
    ctx.showMessage("Interactive model discovery is not available in this UI.");
    return;
  }

  const defaultUrl = preset.defaultBaseUrl ?? "http://localhost:11434/v1";

  // Let user confirm or change the URL
  const urlChoice = await ctx.promptSelect({
    message: `${preset.name}: Server URL`,
    options: [
      { label: `Use default (${defaultUrl})`, value: defaultUrl },
      { label: "Enter custom URL...", value: "__custom__" },
    ],
  });
  if (!urlChoice) return;

  let baseUrl = urlChoice;
  if (urlChoice === "__custom__") {
    const custom = await ctx.promptSecret?.({
      message: `${preset.name}: Enter server URL`,
    });
    if (!custom?.trim()) return;
    baseUrl = custom.trim();
  }

  // Discover models — try without key first, then ask if needed
  ctx.showMessage(`Scanning ${baseUrl} ...`);
  let apiKey = "local";
  let discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
  if (discovered.length === 0) {
    // May be an auth issue — ask for API key
    const keyInput = await ctx.promptSecret?.({
      message: `${preset.name}: API key (Enter to skip if none required)`,
      allowEmpty: true,
    });
    if (keyInput?.trim()) {
      apiKey = keyInput.trim();
      discovered = await fetchModelsFromServer(baseUrl, 5000, apiKey);
    }
  }
  if (discovered.length === 0) {
    ctx.showMessage(
      `No models found at ${baseUrl}.\n` +
      "Make sure the server is running and has at least one model loaded.",
    );
    return;
  }

  // Let user pick a model
  const modelChoice = await ctx.promptSelect({
    message: `${preset.name}: ${discovered.length} model(s) found`,
    options: discovered.map((m) => ({
      label: m.contextLength
        ? `${m.id} (${Math.round(m.contextLength / 1024)}K ctx)`
        : m.id,
      value: m.id,
    })),
  });
  if (!modelChoice) return;

  let contextLength = discovered.find((m) => m.id === modelChoice)?.contextLength;
  if (!contextLength) {
    // Most local servers don't report context length via /v1/models.
    // Prompt the user to specify it (same as init wizard).
    const ctxChoice = await ctx.promptSelect({
      message: `${preset.name}: Context length not reported by server`,
      options: [
        { label: "8K", value: "8192" },
        { label: "32K", value: "32768" },
        { label: "64K", value: "65536" },
        { label: "128K", value: "131072" },
        { label: "Enter custom...", value: "__custom__" },
      ],
    });
    if (!ctxChoice) return;
    if (ctxChoice === "__custom__") {
      const ctxInput = await ctx.promptSecret?.({
        message: `${preset.name}: Context length (tokens)`,
      });
      contextLength = parseInt(ctxInput ?? "", 10) || 32768;
    } else {
      contextLength = parseInt(ctxChoice, 10);
    }
  }

  // Register the model in config
  const config = session.config;
  const rtName = runtimeModelName(providerId, modelChoice);
  config.upsertModelRaw(rtName, {
    provider: providerId,
    model: modelChoice,
    api_key: apiKey,
    base_url: baseUrl,
    context_length: contextLength,
    supports_web_search: false,
  });

  // Persist localProvider config so it survives restarts
  if (ctx.store && typeof ctx.store.loadGlobalPreferences === "function") {
    const existing = ctx.store.loadGlobalPreferences();
    const localCfg: LocalProviderConfig = { baseUrl, model: modelChoice, contextLength };
    if (apiKey !== "local") localCfg.apiKey = apiKey;
    const localProviders: Record<string, LocalProviderConfig> = {
      ...(existing?.localProviders ?? {}),
      [providerId]: localCfg,
    };
    ctx.store.saveGlobalPreferences({
      ...existing,
      localProviders,
    });
  }

  // Switch to the new model
  ctx.resetUiState();
  ctx.autoSave();
  if (ctx.store) {
    ctx.store.clearSession();
  }

  session.switchModel(rtName);
  session.setPersistedModelSelection?.({
    modelConfigName: rtName,
    modelProvider: providerId,
    modelSelectionKey: modelChoice,
    modelId: modelChoice,
  });
  await session.resetForNewSession(ctx.store);
  persistGlobalPreferences(ctx);

}

// ------------------------------------------------------------------
// /theme command
// ------------------------------------------------------------------

function themeOptions(_ctx: CommandOptionsContext): CommandOption[] {
  const current = theme.accent;
  return ACCENT_PRESETS.map((preset) => {
    const isCurrent = preset.value === current;
    return {
      label: isCurrent ? `${preset.label}  (current)` : preset.label,
      value: preset.value,
    };
  });
}

async function cmdTheme(ctx: CommandContext, args: string): Promise<void> {
  const trimmed = args.trim();

  if (!trimmed) {
    ctx.showMessage(
      `Current accent: ${theme.accent}\n` +
      "Use /theme to select a new accent color.",
    );
    return;
  }

  // Accept preset label (case-insensitive) or raw hex value
  const preset = ACCENT_PRESETS.find(
    (p) => p.value === trimmed || p.label.toLowerCase() === trimmed.toLowerCase(),
  );
  const color = preset ? preset.value : trimmed;

  // Basic hex validation
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    ctx.showMessage(`Invalid color: "${trimmed}". Use a preset name or a hex color like #3b82f6.`);
    return;
  }

  setAccent(color);
  ctx.session.accentColor = color;
  persistGlobalPreferences(ctx);

  const label = preset ? `${preset.label} (${color})` : color;
  ctx.showMessage(`Accent color set to: ${label}`);
}

// ------------------------------------------------------------------
// /rename — set a custom session title
// ------------------------------------------------------------------

async function cmdRename(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  if (!session || (session._turnCount ?? 0) === 0) {
    ctx.showMessage("Start a conversation first before renaming.");
    return;
  }

  const trimmed = args.trim();
  if (trimmed) {
    session.setTitle?.(trimmed);
    ctx.autoSave();
    ctx.showMessage(`Session renamed to: ${trimmed}`);
    return;
  }

  // Interactive: prompt for new title
  if (!ctx.promptSecret) {
    ctx.showMessage("Usage: /rename <new title>");
    return;
  }
  const currentName = session.getDisplayName?.() || "";
  const input = await ctx.promptSecret({
    message: `Rename session (current: ${currentName}):`,
    allowEmpty: true,
  });
  if (input === undefined) return; // cancelled
  const value = input.trim();
  if (value) {
    session.setTitle?.(value);
    ctx.autoSave();
    ctx.showMessage(`Session renamed to: ${value}`);
  } else {
    session.setTitle?.("");
    ctx.autoSave();
    ctx.showMessage("Session title cleared (using auto-generated name).");
  }
}

// ------------------------------------------------------------------
// /codex command
// ------------------------------------------------------------------

function codexOptions(): CommandPickerOption[] {
  const token = readOAuthAccessToken();
  const loggedIn = hasOAuthTokens() && token && !isTokenExpiring(token);
  const options: CommandPickerOption[] = [];
  if (loggedIn) {
    options.push({ label: "status", value: "status", description: "Show login status" });
    options.push({ label: "logout", value: "logout", description: "Clear saved tokens" });
  } else {
    options.push({ label: "login", value: "login", description: "Log in to OpenAI ChatGPT" });
  }
  return options;
}

async function cmdCodex(ctx: CommandContext, args: string): Promise<void> {
  const sub = args.trim().toLowerCase();

  if (sub === "login" || sub === "") {
    const token = readOAuthAccessToken();
    const loggedIn = hasOAuthTokens() && token && !isTokenExpiring(token);
    if (loggedIn && sub !== "login") {
      ctx.showMessage("Already logged in to OpenAI ChatGPT.");
      return;
    }
    if (ctx.requestOAuthLogin) {
      const tokens = await ctx.requestOAuthLogin();
      if (!tokens) {
        ctx.showMessage("Login cancelled.");
      }
    } else {
      ctx.showMessage("OAuth login is not available in this environment.");
    }
    return;
  }

  if (sub === "logout") {
    clearOAuthTokens();
    ctx.showMessage("OpenAI ChatGPT tokens cleared.");
    return;
  }

  if (sub === "status") {
    const token = readOAuthAccessToken();
    if (!token || !hasOAuthTokens()) {
      ctx.showMessage("Not logged in.");
      return;
    }
    if (isTokenExpiring(token)) {
      ctx.showMessage("Logged in (token expiring soon).");
    } else {
      ctx.showMessage("Logged in.");
    }
    return;
  }

  ctx.showMessage(`Unknown /codex subcommand: ${sub}`);
}

// ------------------------------------------------------------------
// Registry builder
// ------------------------------------------------------------------

/**
 * Build the default command registry with all built-in commands.
 */
export function buildDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register({ name: "/help", description: "Show commands and shortcuts", handler: cmdHelp });
  registry.register({ name: "/compact", description: "Manually compact the active context", handler: cmdCompact });
  registry.register({ name: "/new", description: "Start a new session", handler: cmdNew });
  registry.register({ name: "/resume", description: "Resume a previous session", handler: cmdResume, options: resumeOptions });
  registry.register({ name: "/summarize", description: "Manually summarize older context", handler: cmdSummarize });
  registry.register({ name: "/model", description: "Switch model", handler: cmdModel, options: modelOptions });
  registry.register({ name: "/quit", description: "Exit the application", handler: cmdQuit });
  registry.register({ name: "/exit", description: "Exit the application", handler: cmdQuit });
  registry.register({ name: "/thinking", description: "Set thinking level", handler: cmdThinking, options: thinkingOptions });
  registry.register({ name: "/cachehit", description: "Prompt caching", handler: cmdCacheHit, options: cacheHitOptions });
  registry.register({ name: "/theme", description: "Change accent color", handler: cmdTheme, options: themeOptions });
  registry.register({ name: "/skills", description: "Manage installed skills", handler: cmdSkills, options: skillsOptions, checkboxMode: true });
  registry.register({ name: "/mcp", description: "Show MCP server status and tools", handler: cmdMcp });
  registry.register({ name: "/rename", description: "Rename current session", handler: cmdRename });
  registry.register({ name: "/codex", description: "OpenAI ChatGPT login", handler: cmdCodex, options: codexOptions });
  return registry;
}

// ------------------------------------------------------------------
// /mcp command
// ------------------------------------------------------------------

async function cmdMcp(ctx: CommandContext): Promise<void> {
  const session = ctx.session;
  const mcpManager = session.mcpManager;

  if (!mcpManager) {
    ctx.showMessage(
      "No MCP servers configured.\n" +
      "Add servers to ~/.longeragent/mcp.json to enable MCP tools.",
    );
    return;
  }

  try {
    if (typeof session.ensureMcpReady === "function") {
      await session.ensureMcpReady();
    } else if (typeof mcpManager.connectAll === "function") {
      await mcpManager.connectAll();
    }
  } catch (err) {
    ctx.showMessage(
      "Failed to connect MCP servers.\n" +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const allTools = mcpManager.getAllTools();

  if (allTools.length === 0) {
    ctx.showMessage(
      "MCP configured but no tools discovered.\n" +
      "Make sure your MCP servers are running and exposing tools.",
    );
    return;
  }

  // Group tools by server (parse mcp__server__tool naming)
  const byServer = new Map<string, string[]>();
  for (const tool of allTools) {
    const parts = tool.name.split("__");
    const server = parts.length >= 3 ? parts[1] : "unknown";
    if (!byServer.has(server)) byServer.set(server, []);
    const originalName = parts.length >= 3 ? parts.slice(2).join("__") : tool.name;
    byServer.get(server)!.push(originalName);
  }

  const lines: string[] = [`MCP: ${byServer.size} server(s), ${allTools.length} tool(s)\n`];
  for (const [server, tools] of byServer) {
    lines.push(`  ${server} (${tools.length} tools)`);
    for (const t of tools) {
      lines.push(`    - ${t}`);
    }
  }

  ctx.showMessage(lines.join("\n"));
}

// ------------------------------------------------------------------
// /skills command
// ------------------------------------------------------------------

function skillsOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  if (!session?.getAllSkillNames) return [];
  const allSkills = session.getAllSkillNames();
  if (allSkills.length === 0) return [];

  return allSkills.map((s: { name: string; description: string; enabled: boolean }) => ({
    label: `${s.name}  ${s.description.length > 50 ? s.description.slice(0, 47) + "..." : s.description}`,
    value: s.name,
    checked: s.enabled,
  }));
}

async function cmdSkills(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  if (!session?.getAllSkillNames) {
    ctx.showMessage("Skills system not available.");
    return;
  }

  const trimmed = args.trim();
  if (!trimmed) {
    // No args — show list
    const allSkills = session.getAllSkillNames();
    if (allSkills.length === 0) {
      ctx.showMessage("No skills installed.");
      return;
    }
    const lines = ["Installed skills:"];
    for (const s of allSkills) {
      lines.push(`  ${s.enabled ? "[x]" : "[ ]"} ${s.name} — ${s.description}`);
    }
    ctx.showMessage(lines.join("\n"));
    return;
  }

  // Checkbox picker submits comma-separated enabled skill names
  // Parse: all items were submitted, enabled ones are in the args
  const enabledNames = new Set(trimmed.split(",").map((s: string) => s.trim()).filter(Boolean));
  const allSkills = session.getAllSkillNames();
  const oldSkills = session.skills;

  for (const s of allSkills) {
    session.setSkillEnabled(s.name, enabledNames.has(s.name));
  }
  session.reloadSkills();

  // Re-register slash commands
  reRegisterSkillCommands(ctx.commandRegistry, oldSkills, session.skills);

  const enabledCount = enabledNames.size;
  const totalCount = allSkills.length;
  ctx.showMessage(`Skills updated: ${enabledCount}/${totalCount} enabled.`);
  persistGlobalPreferences(ctx);
}

// ------------------------------------------------------------------
// Skill command registration
// ------------------------------------------------------------------

/**
 * Register slash commands for user-invocable skills.
 *
 * Each skill with `userInvocable === true` gets a `/skill-name` command.
 * When invoked, the skill content is injected and a turn is triggered.
 */
export function registerSkillCommands(
  registry: CommandRegistry,
  skills: ReadonlyMap<string, SkillMeta>,
): void {
  for (const skill of skills.values()) {
    if (!skill.userInvocable) continue;

    const captured = skill; // capture for closure
    registry.register({
      name: "/" + captured.name,
      description: captured.description,
      handler: async (ctx: CommandContext, args: string) => {
        const content = resolveSkillContent(captured, args);
        const tagged = `[SKILL: ${captured.name}]\n\n${content}`;
        ctx.showMessage(`Loaded skill: ${captured.name}`);
        if (ctx.onTurnRequested) {
          ctx.onTurnRequested(tagged);
        }
      },
    });
  }
}

/**
 * Unregister old skill commands, then register new ones.
 * Used after reloadSkills() to keep slash commands in sync.
 */
export function reRegisterSkillCommands(
  registry: CommandRegistry,
  oldSkills: ReadonlyMap<string, SkillMeta>,
  newSkills: ReadonlyMap<string, SkillMeta>,
): void {
  for (const skill of oldSkills.values()) {
    registry.unregister("/" + skill.name);
  }
  registerSkillCommands(registry, newSkills);
}
