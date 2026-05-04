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

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionStore, LocalProviderConfig, ModelSelectionState, FermiSettings, ProviderEntry, ModelTierEntry } from "./persistence.js";
import { randomSessionId, saveModelSelectionState, saveSettings, globalSettingsPath, loadGlobalSettings } from "./persistence.js";
import { applySessionRestore, findSessionById } from "./session-resume.js";
import { setDotenvKey } from "./dotenv.js";
import { fetchModelsFromServer } from "./model-discovery.js";
import {
  getThinkingLevels,
  getTierEligibleThinkingLevels,
} from "./config.js";
import {
  PROVIDER_PRESETS,
  findProviderPreset,
} from "./provider-presets.js";
import {
  resolveModelSelection as resolveModelSelectionCore,
  type ResolvedModelSelection,
  createModelTierEntry,
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
import { ACCENT_PRESETS, DEFAULT_ACCENT, setAccent, theme } from "./accent.js";
import { buildModelPickerTree, toCommandPickerOptions, type ModelPickerTreeContext } from "./model-picker-tree.js";
import { describeModel, formatCurrentModelScopedLabel, getCurrentModelDescriptor } from "./model-presentation.js";
import { hasOAuthTokens, isTokenExpiring, readOAuthAccessToken, clearOAuthTokens } from "./auth/openai-oauth.js";
import { hasGitHubTokens, clearGitHubTokens } from "./auth/github-copilot-oauth.js";

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

  /**
   * Brief, non-persistent UI hint shown in the input area's bottom-left
   * corner (TUI) — for short, no-copy-value confirmations like "Copied" or
   * "Wait until the agent finishes." Falls back to `showMessage` when not
   * wired (e.g. tests, server mode).
   */
  showHint?: (message: string) => void;

  /** The SessionStore for persistence (may be undefined). */
  store?: SessionStore;

  /** Fermi home directory override, used by tests to avoid real user config. */
  fermiHomeDir?: string;

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

  /** Trigger a targeted summarize request through the TUI turn pipeline. */
  onManualSummarizeRequested?: (opts: { targetContextIds?: string[]; focusPrompt?: string }) => void;

  /** Trigger a manual compact request through the TUI execution pipeline. */
  onManualCompactRequested?: (instruction: string) => void;

  /** Copy text to the system clipboard. Returns true on success. */
  copyToClipboard?: (text: string) => boolean;

  /** True while the agent is producing output for the current turn. */
  isProcessing?: () => boolean;

  /** Prompt the user to choose one option during command execution. */
  promptSelect?: (request: PromptSelectRequest) => Promise<string | undefined>;

  /** Prompt the user for a secret value during command execution. */
  promptSecret?: (request: PromptSecretRequest) => Promise<string | undefined>;

  /**
   * Show the hierarchical command picker (with drill-down children support).
   * Returns the selected leaf value, or undefined if cancelled.
   */
  promptCommandPicker?: (options: CommandOption[]) => Promise<string | undefined>;

  /**
   * Show the inline OAuth login overlay for the given provider and return
   * on completion (resolved value is non-null on success, null on cancel).
   * The returned token type varies by provider; callers typically only care
   * that it's non-null.
   */
  requestOAuthLogin?: (
    provider: "codex" | "copilot",
  ) => Promise<unknown | null>;
}

/**
 * An option entry for command overlays.
 */
export interface CommandOption {
  /** Display label shown in the overlay. */
  label: string;
  /** Value submitted as the command argument when selected. */
  value: string;
  /** Right-aligned detail text shown alongside the label (e.g., "+42 -18"). */
  detail?: string;
  /** Non-submittable row used for headings or notices. */
  disabled?: boolean;
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
  /** The command name, e.g. "/session". */
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
  /** Alternative names that also match during search. */
  aliases?: string[];
  /** Optional display title for the picker; the command name is still submitted. */
  pickerTitle?: string;
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

  /** Look up a command by its exact name or alias. */
  lookup(name: string): SlashCommand | undefined {
    const direct = this._commands.get(name);
    if (direct) return direct;
    // Fallback: check aliases
    for (const cmd of this._commands.values()) {
      if (cmd.aliases?.includes(name)) return cmd;
    }
    return undefined;
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

function formatSummarizeLabel(t: { kind: string; turnIndex: number; preview: string }): string {
  const prefix = t.kind === "summary" ? "(Summary)" : `Turn ${t.turnIndex}`;
  return `${prefix}: ${t.preview}`;
}

async function cmdSummarize(ctx: CommandContext, _args: string): Promise<void> {
  if (!ctx.onManualSummarizeRequested) {
    ctx.showMessage("Manual summarize is not available in this UI.");
    return;
  }

  const session = ctx.session;
  const targets: Array<{ kind: "turn" | "summary"; turnIndex: number; preview: string; timestamp: number; contextId?: string }> =
    session.getSummarizeTargets?.() ?? [];
  if (targets.length === 0) {
    ctx.showMessage("No turns available to summarize.");
    return;
  }

  if (!ctx.promptSelect) {
    ctx.showMessage("Interactive summarize is not available in this UI.");
    return;
  }

  // Step 1: Pick range start
  const startOptions = targets.map((t, i) => ({
    label: formatSummarizeLabel(t),
    value: String(i),
  }));
  const startPick = await ctx.promptSelect({
    message: "Summarize from:",
    options: startOptions,
  });
  if (!startPick) return;
  const startIdx = parseInt(startPick, 10);

  // Step 2: Pick range end (only items at or after start)
  const endOptions = targets.slice(startIdx).map((t, i) => ({
    label: formatSummarizeLabel(t),
    value: String(startIdx + i),
  }));
  const endPick = await ctx.promptSelect({
    message: "Summarize to:",
    options: endOptions,
  });
  if (!endPick) return;
  const endIdx = parseInt(endPick, 10);

  // Step 3: Optional focus prompt
  let focusPrompt: string | undefined;
  if (ctx.promptSecret) {
    const input = await ctx.promptSecret({
      message: "Focus prompt (optional, Enter to skip):",
      allowEmpty: true,
    });
    if (input?.trim()) {
      focusPrompt = input.trim();
    }
  }

  // Step 4: Compute context IDs from selected range
  const selected = targets.slice(startIdx, endIdx + 1);
  const contextIds: string[] = [];

  // Collect turn ranges for getContextIdsForTurnRange
  const turnItems = selected.filter(t => t.kind === "turn");
  if (turnItems.length > 0) {
    const minTurn = turnItems[0].turnIndex;
    const maxTurn = turnItems[turnItems.length - 1].turnIndex;
    const turnContextIds = session.getContextIdsForTurnRange?.(minTurn, maxTurn) ?? [];
    contextIds.push(...turnContextIds);
  }

  // Collect summary contextIds directly
  const seen = new Set(contextIds);
  for (const t of selected) {
    if (t.kind === "summary" && t.contextId && !seen.has(t.contextId)) {
      contextIds.push(t.contextId);
      seen.add(t.contextId);
    }
  }

  if (contextIds.length === 0) {
    ctx.showMessage("No context groups found in the selected range.");
    return;
  }

  ctx.onManualSummarizeRequested({ targetContextIds: contextIds, focusPrompt });
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
  const trimmed = args.trim();

  if (!trimmed) {
    if (sessions.length === 0) {
      ctx.showMessage("No previous sessions in this project.");
      return;
    }
    const lines = ["Sessions", "", ...buildSessionTableRows(sessions)];
    lines.push("", "Use /session <sessionId> to load a session.");
    ctx.showMessage(lines.join("\n"));
    return;
  }

  // Resolve the requested session within the current project. Numeric index
  // (1-based) acts as a shortcut from the picker; otherwise match by UUID
  // (which equals the directory basename).
  const numericIdx = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) - 1 : Number.NaN;
  const target = Number.isInteger(numericIdx)
    ? sessions[numericIdx]
    : sessions.find((s) => s.sessionId === trimmed || basename(s.path) === trimmed);

  if (!target) {
    // Not in this project — check if it lives elsewhere so we can give an
    // actionable hint instead of a bare "not found".
    const elsewhere = findSessionById(trimmed);
    if (elsewhere && elsewhere.projectPath) {
      ctx.showMessage(
        `This session belongs to ${elsewhere.projectPath}. Exit and run:\n` +
          `cd ${elsewhere.projectPath}\n` +
          `fermi --resume ${trimmed}`,
      );
      return;
    }
    ctx.showMessage(`Session not found: ${trimmed}`);
    return;
  }

  // Auto-save current first
  ctx.autoSave();
  ctx.resetUiState();

  const result = applySessionRestore(ctx.session, store, target.path);
  for (const w of result.warnings) ctx.showMessage(w);
  if (!result.ok && result.error) {
    ctx.showMessage(result.error);
  }
}

function formatRelativeTime(value: string | undefined, now: number): string {
  const ms = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) return "unknown";
  const deltaSeconds = Math.max(0, Math.round((now - ms) / 1000));
  if (deltaSeconds < 60) return deltaSeconds <= 1 ? "just now" : `${deltaSeconds}s ago`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 min ago" : `${minutes} mins ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function sessionTitle(session: {
  sessionId?: string;
  path: string;
  title?: string;
  summary?: string;
}): string {
  const customTitle = session.title?.trim();
  if (customTitle) return customTitle;
  const autoSummary = session.summary?.replace(/\s+/g, " ").trim();
  if (autoSummary) return autoSummary;
  return session.sessionId || basename(session.path);
}

function buildSessionTableRows(
  sessions: Array<{ sessionId?: string; path: string; created?: string; lastActiveAt?: string; summary?: string; title?: string }>,
): string[] {
  const now = Date.now();
  const createdValues = sessions.map((s) => formatRelativeTime(s.created, now));
  const activeValues = sessions.map((s) => formatRelativeTime(s.lastActiveAt, now));
  const createdHeader = "Created";
  const activeHeader = "Active";
  const titleHeader = "Title";
  const createdWidth = Math.max(createdHeader.length, ...createdValues.map((v) => v.length));
  const activeWidth = Math.max(activeHeader.length, ...activeValues.map((v) => v.length));
  const gap = "  ";
  const rows = [
    `${createdHeader.padEnd(createdWidth)}${gap}${activeHeader.padEnd(activeWidth)}${gap}${titleHeader}`,
  ];
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i]!;
    rows.push(
      `${(createdValues[i] ?? "").padEnd(createdWidth)}${gap}${(activeValues[i] ?? "").padEnd(activeWidth)}${gap}${sessionTitle(s)}`,
    );
  }
  return rows;
}

function resumeOptions(ctx: CommandOptionsContext): CommandOption[] {
  const store = ctx.store;
  if (!store) return [];
  const sessions = store.listSessions();
  if (sessions.length === 0) return [];
  const rows = buildSessionTableRows(sessions);
  return [
    { label: rows[0] ?? "Created  Active  Title", value: "", disabled: true },
    ...sessions.map((s, i) => ({
      label: rows[i + 1] ?? sessionTitle(s),
      value: s.sessionId,
    })),
  ];
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

/**
 * Persist model selection state to state/model-selection.json.
 * Reads the current model selection from the session and the thinking level,
 * then writes them to the new state file.
 */
function persistModelSelection(ctx: CommandContext): void {
  try {
    const session = ctx.session;
    // Use getGlobalPreferences() which exposes the persisted model selection
    const prefs = typeof session.getGlobalPreferences === "function"
      ? session.getGlobalPreferences()
      : undefined;
    if (!prefs) return;
    const state: ModelSelectionState = {
      config_name: prefs.modelConfigName ?? undefined,
      provider: prefs.modelProvider ?? undefined,
      selection_key: prefs.modelSelectionKey ?? undefined,
      model_id: prefs.modelId ?? undefined,
      thinking_level: prefs.thinkingLevel && prefs.thinkingLevel !== "none"
        ? prefs.thinkingLevel
        : undefined,
    };
    saveModelSelectionState(state, ctx.fermiHomeDir);
  } catch {
    // Ignore persistence failures during command execution.
  }
}

/**
 * Persist a partial settings update to global settings.json.
 * Reads existing settings, merges the patch, and writes back.
 */
function persistSettingsPatch(patch: Partial<FermiSettings>, homeDir?: string): void {
  try {
    const existing = loadGlobalSettings(homeDir);
    saveSettings({ ...existing, ...patch }, globalSettingsPath(homeDir));
  } catch {
    // Ignore persistence failures during command execution.
  }
}

/**
 * Prompt the user to select a thinking level for the current model.
 * Called after model switch to let the user choose a thinking level
 * (replaces the removed /thinking command).
 *
 * Returns the selected level string, or undefined if the model doesn't
 * support thinking or the user cancelled.
 */
async function promptThinkingLevel(ctx: CommandContext): Promise<string | undefined> {
  const session = ctx.session;
  const model = session.currentModelName ?? "";
  const levels = getThinkingLevels(model);
  if (levels.length === 0) return undefined;

  // If only one level (e.g. "on" for models with non-configurable thinking),
  // auto-apply without prompting.
  if (levels.length === 1) {
    session.thinkingLevel = levels[0];
    return levels[0];
  }

  if (!ctx.promptSelect) {
    // Non-interactive environment — keep current/default thinking level.
    return undefined;
  }

  const current = session.thinkingLevel ?? "";
  const options = levels.map((level) => ({
    label: current === level ? `${level}  (current)` : level,
    value: level,
  }));

  const choice = await ctx.promptSelect({
    message: "Select thinking level",
    options,
  });
  if (!choice) return undefined;

  session.thinkingLevel = choice;
  return choice;
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
      "or run 'fermi init' to configure providers.",
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
  return modelOptionsWithTree(ctx);
}

/**
 * Flatten the hierarchical model picker tree to leaf-only options.
 * Used when the UI doesn't support drill-down children.
 */
function flatModelOptions(ctx: CommandOptionsContext): CommandOption[] {
  return flatModelOptionsWithTree(ctx);
}

type ModelPickerOverrides = Omit<ModelPickerTreeContext, "session">;

function modelOptionsWithTree(
  ctx: CommandOptionsContext,
  overrides?: ModelPickerOverrides,
): CommandOption[] {
  return toCommandPickerOptions(buildModelPickerTree({
    session: ctx.session,
    ...overrides,
  })) as CommandOption[];
}

function flatModelOptionsWithTree(
  ctx: CommandOptionsContext,
  overrides?: ModelPickerOverrides,
): CommandOption[] {
  const tree = buildModelPickerTree({
    session: ctx.session,
    ...overrides,
  });
  const flat: CommandOption[] = [];
  function walk(nodes: Array<{ label: string; value: string; children?: any[] }>) {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        walk(node.children);
      } else {
        flat.push({ label: node.label, value: node.value });
      }
    }
  }
  walk(toCommandPickerOptions(tree));
  return flat;
}

async function ensureModelSelectionReady(
  ctx: CommandContext,
  target: string,
): Promise<ResolvedModelSelection | undefined> {
  const parsedTarget = parseProviderModelTarget(target);

  if (parsedTarget?.provider === "openai-codex") {
    const existingToken = readOAuthAccessToken();
    const needsLogin = !hasOAuthTokens()
      || (existingToken && isTokenExpiring(existingToken));
    if (needsLogin && ctx.requestOAuthLogin) {
      const tokens = await ctx.requestOAuthLogin("codex");
      if (!tokens) return undefined;
    } else if (needsLogin) {
      throw new Error(
        "OpenAI OAuth token is missing or expired.\n" +
        "Run 'fermi oauth' to log in.",
      );
    }
  }

  if (parsedTarget?.provider === "copilot" && !hasGitHubTokens()) {
    if (ctx.requestOAuthLogin) {
      const tokens = await ctx.requestOAuthLogin("copilot");
      if (!tokens) return undefined;
    } else {
      throw new Error(
        "Not logged in to GitHub Copilot.\n" +
        "Run 'fermi oauth' to log in.",
      );
    }
  }

  try {
    return resolveModelSelection(ctx.session, target);
  } catch (err) {
    const adapter = createCommandPromptAdapter(ctx);
    if (parsedTarget && isManagedProvider(parsedTarget.provider) && adapter) {
      const result = await ensureManagedProviderCredential(
        parsedTarget.provider,
        adapter,
        { mode: "model", allowReplaceExisting: false, homeDir: ctx.fermiHomeDir },
      );
      if (result.status === "skipped") return undefined;
      return resolveModelSelection(ctx.session, target);
    }
    throw err;
  }
}

async function pickResolvedModelSelection(
  ctx: CommandContext,
  opts?: {
    initialTarget?: string;
    treeOverrides?: ModelPickerOverrides;
    flatMessage?: string;
  },
): Promise<ResolvedModelSelection | undefined> {
  let target = opts?.initialTarget?.trim() ?? "";

  while (true) {
    if (!target) {
      if (ctx.promptCommandPicker) {
        target = (await ctx.promptCommandPicker(
          modelOptionsWithTree({ session: ctx.session, store: ctx.store }, opts?.treeOverrides),
        )) ?? "";
      } else if (ctx.promptSelect) {
        const choice = await ctx.promptSelect({
          message: opts?.flatMessage ?? "Select model",
          options: flatModelOptionsWithTree({ session: ctx.session, store: ctx.store }, opts?.treeOverrides),
        });
        target = choice ?? "";
      } else {
        throw new Error("Interactive model selection is not available in this UI.");
      }
      if (!target) return undefined;
    }

    if (target === "__add_provider__") {
      await cmdAddProvider(ctx);
      target = "";
      continue;
    }

    if (target.endsWith(":__discover__")) {
      await cmdModelLocalDiscover(ctx, target.split(":")[0]);
      target = "";
      continue;
    }

    return ensureModelSelectionReady(ctx, target);
  }
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
      "For models marked 'key missing', run 'fermi init' or select the model to import/paste a key.",
    );
    return;
  }

  if (!session.switchModel) {
    ctx.showMessage("Model switching is not supported in this session.");
    return;
  }

  try {
    const { target } = parseModelArgs(trimmed);
    const resolvedSelection = await pickResolvedModelSelection(ctx, {
      initialTarget: target,
      flatMessage: "Select model",
    });
    if (!resolvedSelection) {
      ctx.showMessage("Model switch cancelled.");
      return;
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

    // Prompt for thinking level if the new model supports it
    await promptThinkingLevel(ctx);
    persistModelSelection(ctx);

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

  // Persist local provider config to settings.json so it survives restarts
  {
    const existing = loadGlobalSettings(ctx.fermiHomeDir);
    const providerEntry: ProviderEntry = {
      base_url: baseUrl,
      model: modelChoice,
      context_length: contextLength,
    };
    if (apiKey !== "local") providerEntry.api_key = apiKey;
    persistSettingsPatch({
      providers: {
        ...(existing.providers ?? {}),
        [providerId]: providerEntry,
      },
    }, ctx.fermiHomeDir);
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

  // Prompt for thinking level if the new model supports it
  await promptThinkingLevel(ctx);
  persistModelSelection(ctx);

}

/**
 * "Add provider..." sub-flow for /model and /tier pickers.
 * Prompts user to select a provider type, configure credentials,
 * and registers the provider in settings.json + runtime config.
 * Returns true if a provider was successfully added.
 */
async function cmdAddProvider(ctx: CommandContext): Promise<boolean> {
  if (!ctx.promptSelect) {
    ctx.showMessage("Interactive provider setup is not available in this UI.");
    return false;
  }
  const session = ctx.session;
  const config = session.config;

  // Build list of provider types the user can add
  const seen = new Set<string>();
  const options: Array<{ label: string; value: string }> = [];

  for (const preset of PROVIDER_PRESETS) {
    // For grouped providers, show group label once
    const groupKey = preset.group ?? preset.id;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);

    const label = preset.group && preset.groupLabel
      ? preset.groupLabel
      : preset.name;

    // Skip if already configured (has models in config)
    const alreadyHasModels = config.modelNames.some((n: string) => {
      if (preset.group) {
        return PROVIDER_PRESETS
          .filter((p) => p.group === preset.group)
          .some((p) => n.startsWith(p.id + ":"));
      }
      return n.startsWith(preset.id + ":");
    });
    const suffix = alreadyHasModels ? "  (configured)" : "";

    options.push({ label: `${label}${suffix}`, value: preset.id });
  }

  const providerId = await ctx.promptSelect({
    message: "Select provider to add",
    options,
  });
  if (!providerId) return false;

  const preset = findProviderPreset(providerId);
  if (!preset) return false;

  // ── OAuth providers ──
  if (preset.id === "openai-codex") {
    if (!ctx.requestOAuthLogin) {
      ctx.showMessage("OAuth login is not available in this UI.");
      return false;
    }
    const tokens = await ctx.requestOAuthLogin("codex");
    if (!tokens) return false;
    // Register models in config
    const existing = loadGlobalSettings(ctx.fermiHomeDir);
    persistSettingsPatch({
      providers: {
        ...(existing.providers ?? {}),
        [preset.id]: { api_key_env: "_OPENAI_CODEX_OAUTH" },
      },
    }, ctx.fermiHomeDir);
    // Register preset models in runtime config
    for (const model of preset.models) {
      config.upsertModelRaw(`${preset.id}:${model.key}`, {
        provider: preset.id,
        model: model.id,
        api_key: "oauth:openai-codex",
        ...(model.config ?? {}),
      });
    }
    return true;
  }

  if (preset.id === "copilot") {
    if (!ctx.requestOAuthLogin) {
      ctx.showMessage("OAuth login is not available in this UI.");
      return false;
    }
    const tokens = await ctx.requestOAuthLogin("copilot");
    if (!tokens) return false;
    const existing = loadGlobalSettings(ctx.fermiHomeDir);
    persistSettingsPatch({
      providers: {
        ...(existing.providers ?? {}),
        [preset.id]: { api_key_env: "_COPILOT_OAUTH" },
      },
    }, ctx.fermiHomeDir);
    for (const model of preset.models) {
      config.upsertModelRaw(`${preset.id}:${model.key}`, {
        provider: preset.id,
        model: model.id,
        api_key: "oauth:copilot",
        ...(model.config ?? {}),
      });
    }
    return true;
  }

  // ── Local servers ──
  if (preset.localServer) {
    await cmdModelLocalDiscover(ctx, preset.id);
    return config.modelNames.some((n: string) => n.startsWith(preset.id + ":"));
  }

  // ── Managed providers (Kimi/GLM/MiniMax) ──
  if (isManagedProvider(providerId)) {
    // For grouped providers, let user select the specific endpoint
    const groupMembers = PROVIDER_PRESETS.filter((p) => (p.group ?? p.id) === (preset.group ?? preset.id));
    let targetPreset = preset;
    if (groupMembers.length > 1 && ctx.promptSelect) {
      const subChoice = await ctx.promptSelect({
        message: `${preset.groupLabel ?? preset.name}: Select endpoint`,
        options: groupMembers.map((p) => ({
          label: p.subLabel ?? p.name,
          value: p.id,
        })),
      });
      if (!subChoice) return false;
      targetPreset = findProviderPreset(subChoice) ?? preset;
    }

    if (!ctx.promptSecret) return false;
    const adapter: CredentialPromptAdapter = {
      select: (req) => ctx.promptSelect!(req),
      secret: (req) => ctx.promptSecret!(req),
    };
    const result = await ensureManagedProviderCredential(targetPreset.id, adapter, {
      mode: "model",
      homeDir: ctx.fermiHomeDir,
    });
    if (!result) return false;

    // Register preset models in runtime config
    for (const model of targetPreset.models) {
      config.upsertModelRaw(`${targetPreset.id}:${model.key}`, {
        provider: targetPreset.id,
        model: model.id,
        api_key: `\${${result.envVar}}`,
        ...(model.config ?? {}),
      });
    }
    return true;
  }

  // ── Standard API key providers ──
  if (!ctx.promptSecret) {
    ctx.showMessage("API key input is not available in this UI.");
    return false;
  }

  const envVarName = preset.envVar;
  const existingKey = process.env[envVarName];

  let apiKey: string | undefined;
  if (existingKey) {
    const action = await ctx.promptSelect({
      message: `${preset.name}: API key found in $${envVarName}`,
      options: [
        { label: `Use existing key`, value: "use" },
        { label: "Enter a different key", value: "new" },
      ],
    });
    if (!action) return false;
    if (action === "use") {
      apiKey = existingKey;
    } else {
      const input = await ctx.promptSecret({ message: `${preset.name}: Paste API key` });
      if (!input?.trim()) return false;
      apiKey = input.trim();
    }
  } else {
    const input = await ctx.promptSecret({ message: `${preset.name}: Paste API key` });
    if (!input?.trim()) return false;
    apiKey = input.trim();
  }

  // Save key to .env
  setDotenvKey(envVarName, apiKey, ctx.fermiHomeDir);
  process.env[envVarName] = apiKey;

  // Register in settings.json
  const existing = loadGlobalSettings(ctx.fermiHomeDir);
  persistSettingsPatch({
    providers: {
      ...(existing.providers ?? {}),
      [preset.id]: { api_key_env: envVarName },
    },
  }, ctx.fermiHomeDir);

  // Register preset models in runtime config
  for (const model of preset.models) {
    config.upsertModelRaw(`${preset.id}:${model.key}`, {
      provider: preset.id,
      model: model.id,
      api_key: `\${${envVarName}}`,
      ...(model.config ?? {}),
    });
  }

  return true;
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
  persistSettingsPatch({ accent_color: color }, ctx.fermiHomeDir);

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

function codexOptions(): CommandOption[] {
  const token = readOAuthAccessToken();
  const loggedIn = hasOAuthTokens() && token && !isTokenExpiring(token);
  const options: CommandOption[] = [];
  if (loggedIn) {
    options.push({ label: "status", value: "status" });
    options.push({ label: "logout", value: "logout" });
  } else {
    options.push({ label: "login", value: "login" });
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
      const tokens = await ctx.requestOAuthLogin("codex");
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
// /copilot command
// ------------------------------------------------------------------

function copilotOptions(): CommandOption[] {
  const options: CommandOption[] = [];
  if (hasGitHubTokens()) {
    options.push({ label: "status", value: "status" });
    options.push({ label: "logout", value: "logout" });
  } else {
    options.push({ label: "login", value: "login" });
  }
  return options;
}

async function cmdCopilot(ctx: CommandContext, args: string): Promise<void> {
  const sub = args.trim().toLowerCase();

  if (sub === "login" || sub === "") {
    if (hasGitHubTokens() && sub !== "login") {
      ctx.showMessage("Already logged in to GitHub Copilot.");
      return;
    }
    if (ctx.requestOAuthLogin) {
      const result = await ctx.requestOAuthLogin("copilot");
      if (!result) {
        ctx.showMessage("Login cancelled.");
      }
    } else {
      ctx.showMessage("OAuth login is not available in this environment.");
    }
    return;
  }

  if (sub === "logout") {
    clearGitHubTokens();
    // Drop the per-account model-visibility cache so a future login for a
    // different plan doesn't inherit the wrong hidden-model set.
    try {
      const { clearCopilotModelsCache } = await import(
        "./providers/copilot-models-cache.js"
      );
      clearCopilotModelsCache();
    } catch {
      // ignore
    }
    ctx.showMessage("GitHub Copilot tokens cleared.");
    return;
  }

  if (sub === "status") {
    if (!hasGitHubTokens()) {
      ctx.showMessage("Not logged in.");
      return;
    }
    ctx.showMessage("Logged in.");
    return;
  }

  ctx.showMessage(`Unknown /copilot subcommand: ${sub}`);
}

// ------------------------------------------------------------------
// /tier command — configure sub-agent model tiers
// ------------------------------------------------------------------

function describeTierModel(session: any, entry: ModelTierEntry): string {
  const configName =
    typeof session?.config?.findModelConfigName === "function"
      ? session.config.findModelConfigName(entry.provider, entry.model_id)
      : undefined;
  const desc = describeModel({
    providerId: entry.provider,
    selectionKey: entry.selection_key,
    modelId: entry.model_id,
    configName: configName ?? `${entry.provider}:${entry.selection_key}`,
  });
  return desc.scopedDetailedLabel || `${entry.provider}:${entry.selection_key}`;
}

function tierOptions(ctx: CommandOptionsContext): CommandOption[] {
  const tiers = ctx.session?.config?.modelTiers ?? {};
  const levels: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
  const opts: CommandOption[] = [];

  for (const level of levels) {
    const entry = tiers[level];
    if (entry) {
      const label = describeTierModel(ctx.session, entry);
      const thinkingSuffix = entry.thinking_level ? ` [${entry.thinking_level}]` : "";
      opts.push({
        label: `${level}: ${label}${thinkingSuffix}`,
        value: level,
      });
    } else {
      opts.push({
        label: `${level}: (inherits main model)`,
        value: level,
      });
    }
  }

  opts.push({ label: "Clear all tiers", value: "clear" });
  return opts;
}

async function cmdTier(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  const tiers: { high?: ModelTierEntry; medium?: ModelTierEntry; low?: ModelTierEntry } =
    session.config?.modelTiers ?? {};
  const trimmed = args.trim().toLowerCase();

  if (!trimmed) {
    // No arg — show current tiers
    const levels: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
    const lines = ["Model tiers:"];
    for (const level of levels) {
      const entry = tiers[level];
      if (entry) {
        const label = describeTierModel(session, entry);
        const thinkingSuffix = entry.thinking_level ? ` [${entry.thinking_level}]` : "";
        lines.push(`  ${level}: ${label}${thinkingSuffix}`);
      } else {
        lines.push(`  ${level}: (inherits main model)`);
      }
    }
    lines.push("");
    lines.push("Use /tier to configure a tier.");
    ctx.showMessage(lines.join("\n"));
    return;
  }

  // Handle "clear" — remove all tiers
  if (trimmed === "clear") {
    persistSettingsPatch({ model_tiers: {} }, ctx.fermiHomeDir);
    // Update runtime config
    if (session.config?._modelTiers !== undefined) {
      (session.config as any)._modelTiers = {};
    }
    ctx.showMessage("All model tiers cleared. Sub-agents will inherit the main model.");
    return;
  }

  // Handle tier level selection
  const validLevels: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
  if (!validLevels.includes(trimmed as any)) {
    ctx.showMessage(`Invalid tier: "${trimmed}". Use high, medium, low, or clear.`);
    return;
  }
  const level = trimmed as "high" | "medium" | "low";

  // Prompt for action: assign model or clear this tier
  if (!ctx.promptSelect) {
    ctx.showMessage("Interactive tier configuration is not available in this UI.");
    return;
  }

  const currentEntry = tiers[level];
  const actionOptions: CommandOption[] = [
    { label: "Assign model...", value: "assign" },
  ];
  if (currentEntry) {
    actionOptions.push({ label: "Clear this tier", value: "clear_one" });
  }

  const action = await ctx.promptSelect({
    message: `${level} tier`,
    options: actionOptions,
  });
  if (!action) return;

  if (action === "clear_one") {
    const updatedTiers = { ...tiers };
    delete updatedTiers[level];
    persistSettingsPatch({ model_tiers: updatedTiers }, ctx.fermiHomeDir);
    if (session.config?._modelTiers !== undefined) {
      (session.config as any)._modelTiers = updatedTiers;
    }
    ctx.showMessage(`Tier '${level}' cleared. Sub-agents at this level will inherit the main model.`);
    return;
  }

  const resolvedSelection = await pickResolvedModelSelection(ctx, {
    flatMessage: `Select model for ${level} tier`,
  });
  if (!resolvedSelection) {
    ctx.showMessage(`Tier '${level}' configuration cancelled.`);
    return;
  }
  const selectedConfigName = resolvedSelection.selectedConfigName;

  // Get the resolved model's actual model ID for thinking level check
  let resolvedModelId: string;
  try {
    const mc = session.config.getModel(selectedConfigName);
    resolvedModelId = mc.model;
  } catch {
    resolvedModelId = selectedConfigName;
  }

  // Determine thinking level for the chosen model. Required when the model
  // supports thinking; "none" otherwise. Picker offers tier-eligible levels
  // only (native "off" / "none" filtered out). Cancelling aborts the save.
  let thinkingLevel: string;

  if (getThinkingLevels(resolvedModelId).length === 0) {
    thinkingLevel = "none";
  } else {
    const eligible = getTierEligibleThinkingLevels(resolvedModelId);
    if (eligible.length === 0) {
      ctx.showMessage(
        `Tier '${level}' cancelled: model '${resolvedModelId}' has no eligible thinking levels (only off/none).`,
      );
      return;
    }
    const thinkingChoice = await ctx.promptSelect({
      message: `Thinking level for ${level} tier (required)`,
      options: eligible.map((l) => ({ label: l, value: l })),
    });
    if (!thinkingChoice) {
      ctx.showMessage(`Tier '${level}' configuration cancelled (thinking level required).`);
      return;
    }
    thinkingLevel = thinkingChoice;
  }

  // Build the tier entry
  const tierEntry = createModelTierEntry({
    provider: resolvedSelection.modelProvider,
    selectionKey: resolvedSelection.modelSelectionKey,
    modelId: resolvedSelection.modelId,
  }, thinkingLevel);

  // Persist
  const updatedTiers = { ...tiers, [level]: tierEntry };
  persistSettingsPatch({ model_tiers: updatedTiers }, ctx.fermiHomeDir);

  // Update runtime config
  if (session.config?._modelTiers !== undefined) {
    (session.config as any)._modelTiers = updatedTiers;
  }

  const displayLabel = describeTierModel(session, tierEntry);
  ctx.showMessage(`Tier '${level}' set to: ${displayLabel} [${thinkingLevel}]`);
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
  registry.register({ name: "/session", description: "Resume a previous session", handler: cmdResume, options: resumeOptions, pickerTitle: "Sessions", aliases: ["/resume"] });
  registry.register({ name: "/summarize", description: "Manually summarize older context", handler: cmdSummarize });
  registry.register({ name: "/model", description: "Switch model", handler: cmdModel, options: modelOptions });
  registry.register({ name: "/tier", description: "Configure sub-agent model tiers", handler: cmdTier, options: tierOptions });
  registry.register({ name: "/quit", description: "Exit the application", handler: cmdQuit, aliases: ["/exit"] });
  registry.register({ name: "/skills", description: "Manage installed skills", handler: cmdSkills, options: skillsOptions, checkboxMode: true });
  registry.register({ name: "/mcp", description: "Show MCP server status and tools", handler: cmdMcp });
  registry.register({ name: "/rename", description: "Rename current session", handler: cmdRename });
  registry.register({ name: "/codex", description: "OpenAI ChatGPT login", handler: cmdCodex, options: codexOptions });
  registry.register({ name: "/copilot", description: "GitHub Copilot login", handler: cmdCopilot, options: copilotOptions });
  registry.register({ name: "/raw", description: "Toggle markdown raw/rendered mode", handler: cmdRaw, aliases: ["/md"] });
  registry.register({ name: "/agents", description: "Show agent list", handler: cmdAgents });
  registry.register({ name: "/permission", description: "Set permission mode", handler: cmdPermission, options: permissionOptions });
  registry.register({ name: "/rewind", description: "Rewind to a previous turn", handler: cmdRewind, options: rewindOptions, aliases: ["/undo"] });
  registry.register({ name: "/hooks", description: "Show registered hooks", handler: cmdHooks });
  registry.register({ name: "/copy", description: "Copy the agent's most recent text response", handler: cmdCopy });
  registry.register({ name: "/fork", description: "Fork the current session into a new branch", handler: cmdFork });
  return registry;
}

// ------------------------------------------------------------------
// /copy
// ------------------------------------------------------------------

async function cmdCopy(ctx: CommandContext): Promise<void> {
  const hint = ctx.showHint ?? ctx.showMessage;

  if (ctx.isProcessing?.()) {
    hint("Wait until the agent finishes.");
    return;
  }

  const log = ctx.session.log as ReadonlyArray<{ type: string; content?: unknown; discarded?: boolean }> | undefined;
  if (!Array.isArray(log)) {
    hint("No agent response to copy.");
    return;
  }

  let lastText: string | null = null;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry?.discarded) continue;
    if (entry?.type === "assistant_text" && typeof entry.content === "string" && entry.content.length > 0) {
      lastText = entry.content;
      break;
    }
  }

  if (lastText === null) {
    hint("No agent response to copy.");
    return;
  }

  if (!ctx.copyToClipboard) {
    hint("Clipboard is not available in this environment.");
    return;
  }

  const ok = ctx.copyToClipboard(lastText);
  hint(ok ? `Copied agent response (${lastText.length} chars).` : "Copy failed.");
}

// ------------------------------------------------------------------
// /fork
// ------------------------------------------------------------------

async function cmdFork(ctx: CommandContext): Promise<void> {
  const hint = ctx.showHint ?? ctx.showMessage;
  const session = ctx.session;
  const store = ctx.store;

  if (!store) {
    ctx.showMessage("Session persistence not available.");
    return;
  }

  if (session.currentTurnRunning) {
    hint("Cannot fork while a turn is running.");
    return;
  }

  const childSnapshots = (typeof session.getChildSessionSnapshots === "function"
    ? session.getChildSessionSnapshots()
    : []) as Array<{ lifecycle: string }>;
  const liveChildren = childSnapshots.filter(
    (s) => s.lifecycle === "running" || s.lifecycle === "blocked",
  );
  if (liveChildren.length > 0) {
    hint("Cannot fork while sub-agents are running.");
    return;
  }

  const sourceDir = store.sessionDir;
  if (!sourceDir) {
    ctx.showMessage("No active session to fork.");
    return;
  }

  // Save current state so we copy the latest log/meta to disk before cloning.
  ctx.autoSave();

  // Empty sessions have no log.json yet (saveLog skips when turnCount === 0).
  if (!existsSync(join(sourceDir, "log.json"))) {
    hint("Cannot fork an empty session.");
    return;
  }

  const origSessionId = basename(sourceDir);
  const newSessionId = randomSessionId();
  const newDir = join(store.projectDir, newSessionId);

  try {
    cpSync(sourceDir, newDir, { recursive: true });
  } catch (e) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    ctx.showMessage(`Fork failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Patch new meta.json + log.json: fresh ID, fresh timestamps, branch title.
  try {
    const nowIso = new Date().toISOString();
    const metaPath = join(newDir, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const origTitleSrc = (typeof meta.title === "string" && meta.title.length > 0)
      ? meta.title
      : (typeof meta.summary === "string" ? meta.summary : "");
    const branchTitle = origTitleSrc.startsWith("(branch) ")
      ? origTitleSrc
      : `(branch) ${origTitleSrc}`.trim();
    meta.session_id = newSessionId;
    meta.created_at = nowIso;
    meta.last_active_at = nowIso;
    meta.title = branchTitle;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const logPath = join(newDir, "log.json");
    const logData = JSON.parse(readFileSync(logPath, "utf-8"));
    logData.session_id = newSessionId;
    logData.created_at = nowIso;
    logData.updated_at = nowIso;
    logData.title = branchTitle;
    writeFileSync(logPath, JSON.stringify(logData, null, 2));
  } catch (e) {
    try { rmSync(newDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    ctx.showMessage(`Fork failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  ctx.resetUiState();

  const result = applySessionRestore(session, store, newDir);
  for (const w of result.warnings) ctx.showMessage(w);
  if (!result.ok && result.error) {
    ctx.showMessage(result.error);
    return;
  }

  // Ephemeral pointer back to the parent — visible in the conversation,
  // not persisted to log.json (saveLog filters meta.ephemeral entries).
  if (typeof session.appendStatusMessage === "function") {
    session.appendStatusMessage(
      `To continue the original session, enter /session ${origSessionId}`,
      "fork_origin",
      true,
    );
  }
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
      "Add servers to ~/.fermi/mcp.json to enable MCP tools.",
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

  // Show server statuses if available
  const statuses = typeof mcpManager.getServerStatuses === "function"
    ? mcpManager.getServerStatuses()
    : null;

  const lines: string[] = [`MCP: ${byServer.size} server(s), ${allTools.length} tool(s)\n`];
  for (const [server, tools] of byServer) {
    const status = statuses?.find((s: any) => s.name === server);
    const stateLabel = status ? ` [${status.state}]` : "";
    const errorLabel = status?.error ? ` (${status.error})` : "";
    lines.push(`  ${server}${stateLabel}${errorLabel} (${tools.length} tools)`);
    for (const t of tools) {
      lines.push(`    - ${t}`);
    }
  }

  // Show failed servers that have no tools
  if (statuses) {
    for (const s of statuses) {
      if (!byServer.has(s.name) && s.state === "failed") {
        lines.push(`  ${s.name} [failed] (${s.error ?? "unknown error"})`);
      }
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
  // Persist disabled skills list to settings.json
  const disabledSkills = allSkills
    .filter((s: { name: string }) => !enabledNames.has(s.name))
    .map((s: { name: string }) => s.name);
  persistSettingsPatch(
    { disabled_skills: disabledSkills.length > 0 ? disabledSkills : undefined },
    ctx.fermiHomeDir,
  );
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
  const sortedSkills = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const skill of sortedSkills) {
    if (!skill.userInvocable) continue;

    // Skip skills whose name conflicts with built-in commands
    const cmdName = "/" + skill.name;
    if (registry.lookup(cmdName)) {
      console.warn(`Skill "${skill.name}" skipped: conflicts with built-in command ${cmdName}`);
      continue;
    }

    const captured = skill; // capture for closure
    registry.register({
      name: cmdName,
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

// ------------------------------------------------------------------
// /raw command — toggle markdown raw/rendered mode
// ------------------------------------------------------------------

async function cmdRaw(ctx: CommandContext): Promise<void> {
  // The TUI intercepts this status message to toggle markdown mode.
  ctx.showMessage("__toggle_markdown_raw__");
}

// ------------------------------------------------------------------
// /agents command — open agent list modal
// ------------------------------------------------------------------

async function cmdAgents(ctx: CommandContext): Promise<void> {
  // The TUI intercepts this status message to open the agent list.
  ctx.showMessage("__open_agent_list__");
}

// ------------------------------------------------------------------
// /sidebar command — toggle sidebar mode (open/close/auto)
// ------------------------------------------------------------------

async function cmdSidebar(ctx: CommandContext, args: string): Promise<void> {
  const mode = args.trim().toLowerCase();
  if (mode === "open" || mode === "close" || mode === "auto") {
    ctx.showMessage(`__sidebar_mode__:${mode}`);
  } else {
    // Toggle: cycle auto → open → close → auto
    ctx.showMessage("__sidebar_toggle__");
  }
}

// ------------------------------------------------------------------
// /permission — set permission mode
// ------------------------------------------------------------------

const PERMISSION_MODES = ["read_only", "reversible", "yolo"] as const;
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  read_only: "Only read tools auto-allowed. All writes require approval.",
  reversible: "Read + reversible writes (edit_file, write_file) auto-allowed. Bash and other mutations require approval.",
  yolo: "Everything auto-allowed except catastrophic commands.",
};

function permissionOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const current = typeof session.permissionMode === "string" ? session.permissionMode : "reversible";
  return PERMISSION_MODES.map((mode) => ({
    label: `${mode}${mode === current ? " (current)" : ""} — ${PERMISSION_DESCRIPTIONS[mode]}`,
    value: mode,
  }));
}

async function cmdPermission(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;
  let mode = args.trim().toLowerCase();

  if (!mode) {
    if (ctx.promptCommandPicker) {
      const picked = await ctx.promptCommandPicker(permissionOptions({ session, store: ctx.store }));
      if (!picked) return;
      mode = picked;
    } else {
      const current = session.permissionMode ?? "reversible";
      ctx.showMessage(
        `Current permission mode: ${current}\n\n` +
        `Usage: /permission <mode>\n` +
        PERMISSION_MODES.map((m) => `  ${m} — ${PERMISSION_DESCRIPTIONS[m]}`).join("\n"),
      );
      return;
    }
  }

  if (!PERMISSION_MODES.includes(mode as any)) {
    ctx.showMessage(`Unknown mode "${mode}". Valid: ${PERMISSION_MODES.join(", ")}`);
    return;
  }

  session.permissionMode = mode;
  persistPermissionMode(ctx);
  ctx.showMessage(`Permission mode set to: ${mode}`);
}

function persistPermissionMode(ctx: CommandContext): void {
  try {
    if (!ctx.store) return;
    const session = ctx.session;
    const prefs = typeof session.getGlobalPreferences === "function"
      ? session.getGlobalPreferences()
      : undefined;
    if (!prefs) return;
    ctx.store.saveGlobalPreferences(prefs);
  } catch {
    // Ignore persistence failures.
  }
}

// ------------------------------------------------------------------
// /rewind — rewind to a previous turn
// ------------------------------------------------------------------

function formatRewindDetail(target: {
  fileCount: number;
  additions: number;
  deletions: number;
  filesReverted: boolean;
}): string {
  if (target.filesReverted) return "Changes reverted";
  if (target.fileCount === 0) return "No code changes";
  const parts: string[] = [];
  if (target.additions > 0) parts.push(`+${target.additions}`);
  if (target.deletions > 0) parts.push(`-${target.deletions}`);
  const n = target.fileCount;
  parts.push(`${n} file${n > 1 ? "s" : ""}`);
  return parts.join(" ");
}

function rewindOptions(ctx: CommandOptionsContext): CommandOption[] {
  const session = ctx.session;
  const targets: Array<{
    turnIndex: number;
    preview: string;
    fileCount: number;
    additions: number;
    deletions: number;
    filesReverted: boolean;
  }> = session.getRewindTargets?.() ?? [];
  const header: CommandOption = { label: "Message", value: "", detail: "Changes", disabled: true };
  const current: CommandOption = { label: "(Current)", value: "0:cancel", detail: "" };
  if (targets.length === 0) {
    return [
      header,
      current,
      { label: "No previous turns", value: "", detail: "", disabled: true },
    ];
  }

  const options: CommandOption[] = targets.map((t) => {
    const hasLiveMutations = t.fileCount > 0 && !t.filesReverted;
    const children: CommandOption[] = [];

    if (hasLiveMutations) {
      children.push(
        { label: "Restore code and conversation", value: `${t.turnIndex}:both` },
        { label: "Restore conversation", value: `${t.turnIndex}:conversation` },
        { label: "Restore code", value: `${t.turnIndex}:files` },
        { label: "Never mind", value: `${t.turnIndex}:cancel` },
      );
    } else {
      children.push(
        { label: "Restore conversation", value: `${t.turnIndex}:conversation` },
        { label: "Never mind", value: `${t.turnIndex}:cancel` },
      );
    }

    return {
      label: t.preview,
      detail: formatRewindDetail(t),
      value: String(t.turnIndex),
      children,
    };
  });

  return [header, current, ...options];
}

async function cmdRewind(ctx: CommandContext, args: string): Promise<void> {
  const session = ctx.session;

  if (!session.rewindConversation) {
    ctx.showMessage("Rewind is not supported in this session.");
    return;
  }

  // Resolve turnIndex and mode from either direct args or picker
  let turnIndex: number;
  let mode: "both" | "conversation" | "files" | "cancel";

  const raw = args.trim();
  if (raw) {
    // Direct args: "/rewind 3" (conversation-only) or "/rewind 3:files" (from picker)
    const colonIdx = raw.indexOf(":");
    if (colonIdx >= 0) {
      turnIndex = parseInt(raw.slice(0, colonIdx), 10);
      mode = raw.slice(colonIdx + 1) as "both" | "conversation" | "files" | "cancel";
    } else {
      turnIndex = parseInt(raw, 10);
      mode = "conversation";
    }
    if (isNaN(turnIndex)) {
      ctx.showMessage(`Invalid turn number: "${raw}"`);
      return;
    }
  } else if (ctx.promptCommandPicker) {
    const picked = await ctx.promptCommandPicker(rewindOptions({ session, store: ctx.store }));
    if (!picked) return;
    const colonIdx = picked.indexOf(":");
    if (colonIdx < 0) return;
    turnIndex = parseInt(picked.slice(0, colonIdx), 10);
    mode = picked.slice(colonIdx + 1) as "both" | "conversation" | "files" | "cancel";
    if (isNaN(turnIndex)) return;
  } else {
    ctx.showMessage("Usage: /rewind <turn_number>");
    return;
  }

  if (mode === "cancel") return;

  if (mode === "conversation") {
    const result = session.rewindConversation(turnIndex);
    if (result.error) {
      ctx.showMessage(`Rewind failed: ${result.error}`);
      return;
    }
    ctx.showMessage(`Rewound conversation to turn ${turnIndex}. Removed ${result.removed} log entries.`);
    ctx.autoSave();
    return;
  }

  // For "files" and "both" modes, we need to plan first
  if (!session.planRewind || !session.rewindFiles || !session.rewindBoth) {
    ctx.showMessage("File rewind is not supported in this session.");
    return;
  }

  const plan = await session.planRewind(turnIndex);
  const hasFiles = plan.applicable.length + plan.warnings.length > 0;
  const hasConflicts = plan.conflicts.length > 0;
  const hasBash = plan.bashEntries.length > 0;
  const hasBashConflicts = plan.bashEntries.some((e: { status: string }) => e.status === "conflict");

  if (!hasFiles && !hasConflicts && !hasBash) {
    if (mode === "both") {
      const result = session.rewindConversation(turnIndex);
      if (result.error) {
        ctx.showMessage(`Rewind failed: ${result.error}`);
        return;
      }
      ctx.showMessage(`Rewound conversation to turn ${turnIndex}. No file changes to revert.`);
    } else {
      ctx.showMessage("No file changes to revert.");
    }
    ctx.autoSave();
    return;
  }

  // Show file conflicts (plan-time, these won't change at execution time)
  if (hasConflicts) {
    const conflictList = plan.conflicts.map((c: { path: string; reason: string }) => `  ${c.path} (${c.reason})`).join("\n");
    ctx.showMessage(`Warning: ${plan.conflicts.length} file(s) cannot be auto-reverted:\n${conflictList}`);
  }
  // Note: bash conflicts are NOT shown here — they are re-evaluated at execution
  // time, so plan-time status may not reflect the final result.

  const formatBashResult = (result: { bashReverted?: string[]; bashSkipped?: string[] }): string => {
    const parts: string[] = [];
    if (result.bashReverted && result.bashReverted.length > 0) {
      parts.push(`Reverted ${result.bashReverted.length} shell operation(s):`);
      for (const desc of result.bashReverted) parts.push(`  ✓ ${desc}`);
    }
    if (result.bashSkipped && result.bashSkipped.length > 0) {
      parts.push(`Skipped ${result.bashSkipped.length} shell operation(s):`);
      for (const desc of result.bashSkipped) parts.push(`  ✗ ${desc}`);
    }
    return parts.join("\n");
  };

  if (mode === "files") {
    const result = await session.rewindFiles(plan);
    if (result.error) {
      ctx.showMessage(`File rewind failed: ${result.error}`);
      return;
    }
    const filePart = result.revertedPaths.length > 0
      ? `Reverted ${result.revertedPaths.length} file edit(s).`
      : "No file edits were reverted.";
    const bashPart = formatBashResult(result);
    ctx.showMessage([filePart, bashPart].filter(Boolean).join("\n"));
  } else {
    // mode === "both"
    const result = await session.rewindBoth(turnIndex, plan);
    if (result.error) {
      ctx.showMessage(`Rewind failed: ${result.error}`);
      return;
    }
    const filePart = result.revertedPaths.length > 0
      ? `Reverted ${result.revertedPaths.length} file edit(s).`
      : "";
    const convPart = `Removed ${result.removed} log entries.`;
    const bashPart = formatBashResult(result);
    const hasSkipped =
      plan.conflicts.length > 0 ||
      result.conflictPaths.length > 0 ||
      (result.bashSkipped?.length ?? 0) > 0;
    const warnPart = hasSkipped
      ? "Some disk changes could not be reverted. Inspect the working tree before continuing."
      : "";
    ctx.showMessage([`Rewound to turn ${turnIndex}. ${convPart} ${filePart}`.trim(), bashPart, warnPart].filter(Boolean).join("\n"));
  }

  ctx.autoSave();
}

// ------------------------------------------------------------------
// /hooks command
// ------------------------------------------------------------------

async function cmdHooks(ctx: CommandContext): Promise<void> {
  const session = ctx.session;
  const hookRuntime = session.hookRuntime;
  if (!hookRuntime) {
    ctx.showMessage("Hook system not available.");
    return;
  }

  const hooks = hookRuntime.hooks;
  if (!hooks || hooks.length === 0) {
    ctx.showMessage(
      "No hooks registered.\n\n" +
      "To add hooks, create a hook.json in:\n" +
      "  ~/.fermi/hooks/<name>/hook.json (global)\n" +
      "  {project}/.fermi/hooks/<name>/hook.json (project)",
    );
    return;
  }

  const lines = [`${hooks.length} hook(s) registered:\n`];
  for (const hook of hooks) {
    const scope = hook._scope ?? "unknown";
    const matcher = hook.matcher
      ? ` [${hook.matcher.toolNames?.join(",") ?? ""}${hook.matcher.agentIds?.join(",") ?? ""}]`
      : "";
    lines.push(
      `  ${hook.name} (${scope})\n` +
      `    event: ${hook.event}${matcher}\n` +
      `    command: ${hook.command}${hook.args?.length ? " " + hook.args.join(" ") : ""}\n` +
      `    failClosed: ${hook.failClosed ?? false}`,
    );
  }
  ctx.showMessage(lines.join("\n"));
}
