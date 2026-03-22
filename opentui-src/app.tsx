/** @jsxImportSource @opentui/react */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { execSync } from "node:child_process";

import type {
  CommandRegistry,
  CommandContext,
  ConversationEntry,
  Session as TuiSession,
} from "../src/tui/types.js";
import type { SessionStore } from "../src/persistence.js";
import { saveLog } from "../src/persistence.js";
import { projectToTuiEntries } from "../src/log-projection.js";
import { isCommandExitSignal } from "../src/commands.js";
import { ProgressReporter, type ProgressEvent } from "../src/progress.js";
import { scanCandidates } from "../src/file-attach.js";
import { classifyPastedText, TurnPasteCounter } from "../src/tui/input/paste.js";
import type {
  PendingAskUi,
  AgentQuestionAnswer,
  AgentQuestionDecision,
  AgentQuestionItem,
} from "../src/ask.js";
import type {
  PromptChoice,
  PromptSecretRequest,
  PromptSelectRequest,
} from "../src/provider-credential-flow.js";
import {
  acceptCommandPickerSelection,
  createCommandPicker,
  exitCommandPickerLevel,
  getCommandPickerLevel,
  getCommandPickerPath,
  getCommandPickerVisibleRange,
  isCommandPickerActive,
  moveCommandPickerSelection,
  setCommandPickerSelection,
  type CommandPickerState,
} from "../src/tui/command-picker.js";
import {
  createCheckboxPicker,
  getCheckboxPickerVisibleRange,
  isCheckboxPickerActive,
  moveCheckboxSelection,
  setCheckboxPickerSelection,
  submitCheckboxPicker,
  toggleCheckboxItem,
  type CheckboxPickerState,
} from "../src/tui/checkbox-picker.js";
import {
  RGBA,
  StyledText,
  SyntaxStyle,
  type InputRenderable,
  type KeyBinding,
  type ScrollBoxRenderable,
  type TextareaRenderable,
  getTreeSitterClient,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import "./forked/patch-opentui-markdown.js";
import { getCurrentModelDescriptor, type ModelDescriptor } from "../src/model-presentation.js";
import {
  buildFileReferenceLabel,
  createComposerTokenVisuals,
  displayWidthWithNewlines,
  ensureComposerTokenType,
  findFileReferenceQuery,
  getTextDiffRange,
  patchComposerExtmarksForDisplayWidth,
  replaceRangeWithComposerToken,
  serializeComposerText,
  type ComposerTokenVisuals,
} from "./composer-tokens.js";

type ActivityPhase =
  | "idle"
  | "working"
  | "thinking"
  | "generating"
  | "waiting"
  | "closing"
  | "error";

export interface OpenTuiAppProps {
  session: TuiSession;
  commandRegistry: CommandRegistry;
  store: SessionStore | null;
  verbose?: boolean;
  onExit: (farewell?: string) => Promise<void> | void;
}

// -- Fixed dark-only palette --------------------------------------------------
// Derived from the logo gradient: gold → orange → red → magenta → purple.
// Background is a near-black warm tone reminiscent of CRT phosphor afterglow.

const BG = "#0d0c0f";

const COLORS = {
  background: BG,
  panel: BG,
  userBg: "#1f1c26",       // lifted background for user messages
  // Structural
  border: "#2a2630",
  separator: "#2a2630",
  // Text hierarchy — cool-shifted to balance the warm background
  text: "#c8ced8",
  dim: "#636a76",
  muted: "#454a54",
  // Logo-derived accents (sampled from the gradient)
  accent: "#ffb703",       // logo line 1 — gold
  orange: "#fb8500",       // logo line 2
  red: "#f05030",          // logo line 3
  magenta: "#e81860",      // logo line 4
  purple: "#a010a0",       // logo line 6
  // Semantic colors not in the gradient
  yellow: "#e8c468",
  green: "#73a942",
  cyan: "#6aa8a0",
  thinking: "#8a7e90",
  toolTime: "#8a8078",     // tool call elapsed time
  // Phase indicators — each maps to a logo gradient stop
  readyStatus: "#fb8500",
  thinkingStatus: "#a010a0",
  workingStatus: "#e81860",
  generatingStatus: "#ffb703",
  waitingStatus: "#e8c468",
  closingStatus: "#4d4843",
  errorStatus: "#f05030",
} as const;

type OpenTuiPalette = typeof COLORS;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
// (terminal palette refresh removed — dark-only, fixed bg)
const CTRL_C_EXIT_WINDOW_MS = 2000;
const FIXED_CLOSE_DELAY_MS = 1500;
const INPUT_MAX_VISIBLE_LINES = 10;
function computePickerMaxVisible(terminalHeight: number): number {
  return Math.max(5, Math.floor(terminalHeight * 0.4 - 4));
}
const SIDEBAR_MIN_WIDTH = 30;
const SIDEBAR_MAX_WIDTH = 48;
const MIN_TERMINAL_WIDTH_FOR_SIDEBAR = 90;
const MIN_TERMINAL_WIDTH_FOR_LOGO_HEADER = 72;
const MIN_TERMINAL_HEIGHT_FOR_LOGO_HEADER = 28;
const APP_VERSION = "v0.1.3";
// (removed CONTEXT_PRIMARY_NEUTRAL / CONTEXT_SECONDARY_NEUTRAL — unused)
const CUSTOM_EMPTY_HINT =
  'Custom answer is empty. Please enter an answer first, or choose "Discuss further" instead.';
const GOODBYE_MESSAGES = [
  "Bye!",
  "Goodbye!",
  "See you later!",
  "Until next time!",
  "Take care!",
  "Happy coding!",
  "Catch you later!",
  "Peace out!",
  "So long!",
  "Off I go!",
  "Later, gator!",
] as const;

const MARKDOWN_TREE_SITTER_CLIENT = getTreeSitterClient();

const DISABLED_TEXTAREA_ACTION = "__disabled__" as unknown as KeyBinding["action"];

const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "n", ctrl: true, action: "newline" },
  { name: "up", action: DISABLED_TEXTAREA_ACTION },
  { name: "down", action: DISABLED_TEXTAREA_ACTION },
  { name: "backspace", meta: true, action: DISABLED_TEXTAREA_ACTION },
  { name: "backspace", super: true, action: DISABLED_TEXTAREA_ACTION },
  { name: "u", ctrl: true, action: DISABLED_TEXTAREA_ACTION },
];

interface CommandOverlayState {
  mode: "command" | "file";
  visible: boolean;
  items: string[];
  values: string[];
  selected: number;
}

interface OpenTuiTheme {
  colors: OpenTuiPalette;
  markdownStyle: SyntaxStyle;
}

const PROVIDER_MODEL_COLORS: Record<string, string> = {
  openai: "#10a37f",
  "openai-codex": "#10a37f",
  kimi: "#38bdf8",
  "kimi-cn": "#38bdf8",
  "kimi-code": "#38bdf8",
  minimax: "#f472b6",
  "minimax-cn": "#f472b6",
  glm: "#818cf8",
  "glm-intl": "#818cf8",
  "glm-code": "#818cf8",
  "glm-intl-code": "#818cf8",
  openrouter: "#c084fc",
  lmstudio: "#9ca3af",
  omlx: "#9ca3af",
  ollama: "#9ca3af",
  anthropic: "#e6c3a5",
};

function resolveModelNameColor(
  descriptor: ModelDescriptor | null,
  colors: OpenTuiPalette,
): string {
  if (!descriptor) return colors.accent;
  return PROVIDER_MODEL_COLORS[descriptor.providerId]
    ?? PROVIDER_MODEL_COLORS[descriptor.brandKey]
    ?? colors.accent;
}

function buildMarkdownStyle(colors: OpenTuiPalette): SyntaxStyle {
  // Code syntax colors — logo-gradient-derived
  const kw    = RGBA.fromHex("#e0a050");  // keywords: warm amber
  const str   = RGBA.fromHex("#8aad6a");  // strings: forest green
  const fn    = RGBA.fromHex("#d0a0d0");  // functions: soft lavender
  const typ   = RGBA.fromHex("#e8c468");  // types: golden
  const num   = RGBA.fromHex("#d08770");  // numbers: burnt orange
  const cmt   = RGBA.fromHex("#5a5565");  // comments: muted purple-gray
  const op    = RGBA.fromHex("#9098a8");  // operators/punctuation: cool gray
  const lit   = RGBA.fromHex("#6aa8a0");  // constants/builtins: teal

  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(colors.text) },
    conceal: { fg: RGBA.fromHex(colors.dim) },
    // Markdown
    "markup.heading": { fg: RGBA.fromHex(colors.accent), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex(colors.accent), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(colors.orange), bold: true },
    "markup.heading.3": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.4": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.5": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.6": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.strong": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.italic": { fg: RGBA.fromHex(colors.text), italic: true },
    "markup.raw": { fg: RGBA.fromHex(colors.yellow) },
    "markup.raw.block": { fg: RGBA.fromHex(colors.yellow) },
    "markup.link": { fg: RGBA.fromHex(colors.cyan) },
    "markup.link.label": { fg: RGBA.fromHex(colors.cyan), underline: true },
    "markup.link.url": { fg: RGBA.fromHex(colors.cyan), underline: true },
    "markup.quote": { fg: RGBA.fromHex(colors.dim), italic: true },
    "markup.list": { fg: RGBA.fromHex(colors.text) },
    // Code syntax — tree-sitter capture names
    "keyword": { fg: kw, bold: true },
    "keyword.return": { fg: kw, bold: true },
    "keyword.function": { fg: kw, bold: true },
    "keyword.import": { fg: kw, bold: true },
    "keyword.operator": { fg: op },
    "keyword.conditional": { fg: kw, bold: true },
    "keyword.repeat": { fg: kw, bold: true },
    "keyword.exception": { fg: kw, bold: true },
    "string": { fg: str },
    "string.special": { fg: str },
    "string.escape": { fg: num },
    "comment": { fg: cmt, italic: true },
    "comment.line": { fg: cmt, italic: true },
    "comment.block": { fg: cmt, italic: true },
    "function": { fg: fn },
    "function.call": { fg: fn },
    "function.method": { fg: fn },
    "function.builtin": { fg: fn },
    "method": { fg: fn },
    "variable": { fg: RGBA.fromHex("#b0b8c4") },
    "variable.builtin": { fg: lit },
    "variable.parameter": { fg: RGBA.fromHex("#b0b8c4") },
    "type": { fg: typ },
    "type.builtin": { fg: typ },
    "constructor": { fg: typ },
    "number": { fg: num },
    "number.float": { fg: num },
    "constant": { fg: lit },
    "constant.builtin": { fg: lit },
    "boolean": { fg: lit },
    "operator": { fg: op },
    "punctuation": { fg: op },
    "punctuation.bracket": { fg: op },
    "punctuation.delimiter": { fg: op },
    "punctuation.special": { fg: op },
    "property": { fg: RGBA.fromHex("#b0b8c4") },
    "attribute": { fg: typ },
    "tag": { fg: kw },
    "label": { fg: RGBA.fromHex(colors.accent) },
  });
}

const THEME: OpenTuiTheme = {
  colors: COLORS,
  markdownStyle: buildMarkdownStyle(COLORS),
};

interface PromptSelectState {
  message: string;
  options: PromptChoice[];
  selected: number;
}

interface PromptSecretState {
  message: string;
  allowEmpty: boolean;
}

interface PlanCheckpointUi {
  text: string;
  checked: boolean;
}

interface QuestionAnswerState {
  optionIndex: number;
  customText?: string;
}

const EMPTY_COMMAND_OVERLAY: CommandOverlayState = {
  mode: "command",
  visible: false,
  items: [],
  values: [],
  selected: 0,
};

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function getSidebarWidth(terminalWidth: number): number {
  return clamp(
    Math.floor(terminalWidth * 0.20),
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
  );
}

function getVisibleWindow(count: number, selected: number, maxVisible: number): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  if (count <= maxVisible) return { start: 0, end: count };
  const safeSelected = clamp(selected, 0, count - 1);
  const safeMaxVisible = Math.max(1, maxVisible);
  let start = clamp(safeSelected - Math.floor(safeMaxVisible / 2), 0, Math.max(0, count - safeMaxVisible));
  if (safeSelected >= start + safeMaxVisible) {
    start = safeSelected - safeMaxVisible + 1;
  }
  return { start, end: Math.min(count, start + safeMaxVisible) };
}

function countWrappedDisplayLines(text: string, contentWidth: number): number {
  const safeWidth = Math.max(1, contentWidth);
  const lines = text.split("\n");
  return lines.reduce((sum, line) => {
    const width = Math.max(1, displayWidthWithNewlines(line || " "));
    return sum + Math.max(1, Math.ceil(width / safeWidth));
  }, 0);
}

function isDeleteToVisualLineStartShortcut(
  event: {
    name: string;
    ctrl?: boolean;
    meta?: boolean;
    super?: boolean;
  },
): boolean {
  return (
    (event.name === "backspace" && (event.meta || event.super))
    || (event.name === "u" && event.ctrl && !event.meta && !event.super)
  );
}

function isCommandOverlayEligible(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.includes("\n")) return false;
  return !value.slice(1).includes(" ");
}

function isFileOverlayEligible(value: string, cursorOffset: number): boolean {
  return findFileReferenceQuery(value, cursorOffset) !== null;
}

function formatTokens(value: number | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

function shortenPath(fullPath: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home && fullPath.startsWith(home) ? "~" + fullPath.slice(home.length) : fullPath;
}

function formatContext(contextTokens: number, contextLimit?: number, cacheReadTokens?: number): string {
  if (contextLimit && contextLimit > 0) {
    const pct = ((contextTokens / contextLimit) * 100).toFixed(1);
    const cache = cacheReadTokens ? ` (${formatTokens(cacheReadTokens)} cached)` : "";
    return `${pct}%  ${formatTokens(contextTokens)} / ${formatTokens(contextLimit)}${cache}`;
  }
  return formatTokens(contextTokens);
}

function formatContextParts(
  contextTokens: number,
  contextLimit?: number,
  cacheReadTokens?: number,
): {
  primary: string;
  secondary: string;
} {
  if (contextLimit && contextLimit > 0) {
    const primary = `${((contextTokens / contextLimit) * 100).toFixed(1)}%  ${formatTokens(contextTokens)}`;
    const cache = cacheReadTokens ? ` (${formatTokens(cacheReadTokens)} cached)` : "";
    return {
      primary,
      secondary: ` / ${formatTokens(contextLimit)}${cache}`,
    };
  }

  return {
    primary: formatTokens(contextTokens),
    secondary: "",
  };
}

function formatCompactTokens(value: number | undefined): string {
  const safeValue = value ?? 0;
  if (safeValue >= 1_000_000) {
    const compact = safeValue / 1_000_000;
    return `${compact >= 100 ? compact.toFixed(0) : compact.toFixed(1)}M`;
  }
  if (safeValue >= 100_000) {
    return `${(safeValue / 1_000).toFixed(0)}k`;
  }
  if (safeValue >= 1_000) {
    return `${(safeValue / 1_000).toFixed(1)}k`;
  }
  return `${safeValue}`;
}

function formatUsagePercent(contextTokens: number, contextLimit?: number): string {
  if (!contextLimit || contextLimit <= 0) return "0.0%";
  return `${((contextTokens / contextLimit) * 100).toFixed(1)}%`;
}

function getUsageBlockSize(contextLimit?: number): number {
  if (!contextLimit || contextLimit <= 0) return 5_000;
  return contextLimit >= 400_000 ? 20_000 : 5_000;
}

function getUsageBarRows(
  contextTokens: number,
  contextLimit?: number,
  blocksPerRow = 20,
): Array<{ filled: string; empty: string }> {
  const safeBlocksPerRow = Math.max(1, blocksPerRow);
  const blockSize = getUsageBlockSize(contextLimit);
  const totalBlocks = contextLimit && contextLimit > 0
    ? Math.max(1, Math.ceil(contextLimit / blockSize))
    : safeBlocksPerRow;
  const filledBlocks = Math.max(0, Math.min(totalBlocks, Math.round((contextTokens ?? 0) / blockSize)));
  const rowCount = Math.max(1, Math.ceil(totalBlocks / safeBlocksPerRow));

  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const rowStart = rowIndex * safeBlocksPerRow;
    const rowTotal = Math.min(safeBlocksPerRow, totalBlocks - rowStart);
    const rowFilled = Math.max(0, Math.min(rowTotal, filledBlocks - rowStart));
    const emptyCount = Math.max(0, rowTotal - rowFilled);
    return {
      filled: Array.from({ length: rowFilled }, () => "▆").join(" "),
      empty: Array.from({ length: emptyCount }, () => "▆").join(" "),
    };
  });
}

function copyToClipboard(text: string, rendererCopy: (text: string) => boolean): boolean {
  try {
    execSync("pbcopy", { input: text, timeout: 2000 });
    return true;
  } catch {
    return rendererCopy(text);
  }
}

function diffLineColor(line: string, colors: OpenTuiPalette): string | undefined {
  const payloadIdx = line.indexOf("| ");
  const payload = payloadIdx >= 0 ? line.slice(payloadIdx + 2) : line;
  if (payload.startsWith("@@")) return colors.yellow;
  if (payload.startsWith("+++ ") || payload.startsWith("--- ")) return colors.dim;
  if (payload.startsWith("+")) return colors.green;
  if (payload.startsWith("-")) return colors.red;
  if (payload.startsWith("... [")) return colors.dim;
  return undefined;
}

function PlanPanelView(
  { checkpoints, active, colors }: { checkpoints: PlanCheckpointUi[]; active: boolean; colors: OpenTuiPalette },
): React.ReactElement | null {
  if (checkpoints.length === 0) return null;

  const done = checkpoints.filter((checkpoint) => checkpoint.checked).length;
  const firstUncheckedIndex = checkpoints.findIndex((checkpoint) => !checkpoint.checked);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (!active || firstUncheckedIndex < 0) {
      setPulse(false);
      return;
    }
    const timer = setInterval(() => {
      setPulse((current) => !current);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, firstUncheckedIndex]);

  return (
    <box
      border
      borderColor={colors.cyan}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      width="100%"
    >
      <text fg={colors.cyan} content={`Plan (${done}/${checkpoints.length})`} />
      {checkpoints.map((checkpoint, index) => (
        <box key={`plan-${index}`} flexDirection="row" width="100%">
          <text
            fg={checkpoint.checked ? colors.dim : index === firstUncheckedIndex ? colors.cyan : colors.text}
            content={`  ${checkpoint.checked
              ? "✓"
              : index === firstUncheckedIndex && pulse
                ? "●"
                : "○"
              } `}
          />
          <text
            fg={checkpoint.checked ? colors.dim : colors.text}
            content={checkpoint.text}
            wrapMode="word"
            flexGrow={1}
            flexShrink={1}
          />
        </box>
      ))}
    </box>
  );
}

const LOGO_LINES = [
  "░██    ░██ ░██████  ░██████  ░██████░██         ",
  "░██    ░██   ░██   ░██   ░██   ░██  ░██         ",
  "░██    ░██   ░██  ░██          ░██  ░██         ",
  "░██    ░██   ░██  ░██  █████   ░██  ░██         ",
  " ░██  ░██    ░██  ░██     ██   ░██  ░██         ",
  "  ░██░██     ░██   ░██  ░███   ░██  ░██         ",
  "   ░███    ░██████  ░█████░█ ░██████░██████████ ",
];
const LOGO_GRADIENT = ["#ffb703", "#fb8500", "#f05030", "#e81860", "#d01080", "#a010a0", "#5a0c92"];

function LogoBlock(
  { colors }: { colors: OpenTuiPalette },
): React.ReactElement {
  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="column" width="100%" paddingBottom={1}>
      {LOGO_LINES.map((line, i) => (
        <text key={`logo-${i}`} fg={LOGO_GRADIENT[i]} content={line} />
      ))}
    </box>
  );
}

function conversationEntryKey(entry: ConversationEntry, index: number): string {
  return entry.id ?? `entry-${index}`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function LiveTimer({ startedAt, color }: { startedAt: number; color: string }): React.ReactElement {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Date.now() - startedAt;
  return <text fg={color} content={` (${formatElapsed(elapsed)})`} flexShrink={0} />;
}

function ConversationEntryView(
  {
    entry,
    streaming,
    markdownMode,
    colors,
    markdownStyle,
    needsSpacing,
  }: {
    entry: ConversationEntry;
    streaming: boolean;
    markdownMode: "rendered" | "raw";
    colors: OpenTuiPalette;
    markdownStyle: SyntaxStyle;
    needsSpacing?: boolean;
  },
): React.ReactElement {
  switch (entry.kind) {
    case "user":
      return (
        <box>
          <box height={1} />
          <box backgroundColor={colors.userBg} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
            <text fg={colors.text} bold content={entry.text} wrapMode="word" width="100%" />
            {entry.queued ? <text fg={colors.orange} content=" [queued]" /> : null}
          </box>
          <box height={1} />
        </box>
      );
    case "assistant":
      return (
        <box paddingLeft={2} paddingTop={1}>
          {markdownMode === "raw" ? (
            <text fg={colors.text} content={entry.text} />
          ) : (
            <markdown
              content={entry.text}
              syntaxStyle={markdownStyle}
              treeSitterClient={MARKDOWN_TREE_SITTER_CLIENT}
              streaming={streaming}
              conceal={true}
              concealCode={false}
              width="100%"
              tableOptions={{
                borders: true,
                outerBorder: true,
                wrapMode: "word",
                selectable: true,
              }}
            />
          )}
        </box>
      );
    case "reasoning": {
      const thinkingStyled = new StyledText([
        { __isChunk: true, text: "Thinking: ", fg: RGBA.fromHex(colors.thinkingStatus), attributes: 1 },
        { __isChunk: true, text: entry.text.replace(/^\n+/, ""), fg: RGBA.fromHex(colors.thinking) },
      ]);
      return (
        <box paddingLeft={2} paddingTop={needsSpacing ? 1 : 0}>
          <text content={thinkingStyled} wrapMode="word" width="100%" />
        </box>
      );
    }
    case "tool_call":
      {
        const trimmed = entry.text.trim();
        const firstSpace = trimmed.indexOf(" ");
        const parsedToolName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
        const toolName = typeof entry.meta?.toolName === "string" ? entry.meta.toolName : parsedToolName;
        const restSource = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
        const rest = restSource.replace(/\s+/g, " ").trim();
        const isLive = entry.elapsedMs === undefined && entry.startedAt !== undefined;
        const timeDisplay = entry.elapsedMs !== undefined ? formatElapsed(entry.elapsedMs) : null;
        return (
          <box flexDirection="row" width="100%" paddingLeft={2}>
            <text fg={colors.purple} content={toolName} flexShrink={0} />
            {isLive ? <LiveTimer startedAt={entry.startedAt!} color={colors.dim} /> : null}
            {timeDisplay ? <text fg={colors.toolTime} content={` (${timeDisplay})`} flexShrink={0} /> : null}
            {rest ? (
              <text
                fg={colors.muted}
                content={` ${rest}`}
                wrapMode="none"
                truncate
                flexGrow={1}
                flexShrink={1}
              />
            ) : null}
          </box>
        );
      }
    case "tool_result":
      return (
        <box flexDirection="column" paddingLeft={4}>
          {entry.text.split("\n").map((line, index) => (
            <text
              key={`tool-result-${index}`}
              fg={entry.dim ? colors.dim : diffLineColor(line, colors) ?? colors.text}
              content={line || " "}
            />
          ))}
        </box>
      );
    case "progress":
      return (
        <box paddingLeft={2}>
          <text fg={colors.muted} content={entry.text} />
        </box>
      );
    case "status":
    case "compact_mark":
      return (
        <box paddingLeft={2} paddingTop={1}>
          <text fg={colors.orange} content={entry.text} />
        </box>
      );
    case "error":
      return (
        <box paddingLeft={2} paddingTop={1}>
          <text fg={colors.red} bold content={`[!] ${entry.text}`} />
        </box>
      );
    case "sub_agent_rollup":
      return (
        <box flexDirection="column" paddingLeft={2}>
          <text fg={colors.dim} content={entry.text} />
        </box>
      );
    case "sub_agent_done":
      return (
        <box paddingLeft={2}>
          <text fg={colors.dim} content={entry.text} />
        </box>
      );
    case "interrupted_marker":
      return (
        <box paddingLeft={2}>
          <text fg={colors.orange} content={entry.text} />
        </box>
      );
    default:
      return <box />;
  }
}

function StatusStrip(
  {
    modelName,
    modelColor,
    phase,
    contextTokens,
    contextLimit,
    hint,
    showContext,
    colors,
    onModelClick,
  }: {
    modelName: string;
    modelColor: string;
    phase: ActivityPhase;
    contextTokens: number;
    contextLimit?: number;
    hint?: string | null;
    showContext: boolean;
    colors: OpenTuiPalette;
    onModelClick?: () => void;
  },
): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [modelHover, setModelHover] = useState(false);

  useEffect(() => {
    if (phase === "idle" || phase === "error" || phase === "closing") return;
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [phase]);

  const phaseVisual = (() => {
    switch (phase) {
      case "idle":
        return { indicator: "●", color: colors.readyStatus, label: "READY" };
      case "thinking":
        return { indicator: SPINNER_FRAMES[frame]!, color: colors.thinkingStatus, label: "THINKING" };
      case "working":
        return { indicator: SPINNER_FRAMES[frame]!, color: colors.workingStatus, label: "WORKING" };
      case "generating":
        return { indicator: SPINNER_FRAMES[frame]!, color: colors.generatingStatus, label: "GENERATING" };
      case "waiting":
        return { indicator: SPINNER_FRAMES[frame]!, color: colors.waitingStatus, label: "WAITING" };
      case "closing":
        return { indicator: "●", color: colors.closingStatus, label: "CLOSING" };
      case "error":
        return { indicator: "●", color: colors.errorStatus, label: "ERROR" };
      default:
        return { indicator: "●", color: colors.readyStatus, label: phase.toUpperCase().slice(0, 5) };
    }
  })();

  const pct = formatUsagePercent(contextTokens, contextLimit);
  const ctxCompact = `${pct} ${formatCompactTokens(contextTokens)}/${formatCompactTokens(contextLimit)}`;

  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="column" gap={0} width="100%">
      <box flexDirection="row">
        <text fg={phaseVisual.color} bold content={`${phaseVisual.indicator} ${phaseVisual.label}`} />
        <text fg={colors.separator} content=" │ " />
        {phase === "closing" ? (
          <text fg={colors.dim} content="shutting down..." />
        ) : (
          <>
            <box
              backgroundColor={modelHover ? colors.border : "transparent"}
              onMouseOver={() => setModelHover(true)}
              onMouseOut={() => setModelHover(false)}
              onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onModelClick?.(); }}
            >
              <text fg={modelColor} content={modelName} />
            </box>
            {showContext ? (
              <>
                <text fg={colors.separator} content=" │ " />
                <text fg={colors.dim} content={ctxCompact} />
              </>
            ) : null}
          </>
        )}
      </box>
      {hint ? <text fg={colors.dim} content={hint} /> : null}
    </box>
  );
}

function ContextUsageCard(
  {
    contextTokens,
    contextLimit,
    cacheReadTokens,
    colors,
  }: {
    contextTokens: number;
    contextLimit?: number;
    cacheReadTokens?: number;
    colors: OpenTuiPalette;
  },
): React.ReactElement {
  const percentText = formatUsagePercent(contextTokens, contextLimit);
  const barWidth = 20;
  const limit = contextLimit && contextLimit > 0 ? contextLimit : 1;
  const ratio = contextTokens / limit;
  const filledBlocks = Math.max(0, Math.min(barWidth, Math.round(ratio * barWidth)));
  const emptyBlocks = Math.max(0, barWidth - filledBlocks);

  // Bar color follows the logo gradient as usage climbs
  const barColor = ratio > 0.8 ? colors.red : ratio > 0.5 ? colors.orange : colors.accent;

  return (
    <box flexDirection="column" width="100%" gap={0}>
      <text fg={colors.dim} bold content="CONTEXT" />
      <box flexDirection="row">
        {filledBlocks > 0 ? <text fg={barColor} content={"━".repeat(filledBlocks)} /> : null}
        {emptyBlocks > 0 ? <text fg={colors.border} content={"─".repeat(emptyBlocks)} /> : null}
        <text fg={colors.dim} content={` ${percentText}`} />
      </box>
      <box flexDirection="row">
        <text fg={colors.text} content={formatCompactTokens(contextTokens)} />
        <text fg={colors.muted} content={`/${contextLimit ? formatCompactTokens(contextLimit) : "?"}`} />
        {(cacheReadTokens ?? 0) > 0 ? (
          <text fg={colors.muted} content={` (${formatCompactTokens(cacheReadTokens)} hit)`} />
        ) : null}
      </box>
    </box>
  );
}

function PlanCard(
  { checkpoints, colors }: { checkpoints: PlanCheckpointUi[]; colors: OpenTuiPalette },
): React.ReactElement | null {
  if (checkpoints.length === 0) return null;

  return (
    <box
      flexDirection="column"
      width="100%"
      gap={1}
    >
      <text fg={colors.text} bold content={`Plan (${checkpoints.filter((checkpoint) => checkpoint.checked).length}/${checkpoints.length})`} />
      {checkpoints.map((checkpoint, index) => (
        <box key={`sidebar-plan-${index}`} flexDirection="column" width="100%">
          <text
            fg={checkpoint.checked ? colors.dim : colors.text}
            content={`${checkpoint.checked ? "✓" : "○"} ${checkpoint.text}`}
            wrapMode="word"
            width="100%"
          />
        </box>
      ))}
    </box>
  );
}

function SidebarTitle({ colors }: { colors: OpenTuiPalette }): React.ReactElement {
  const name = "VIGIL";
  const indices = [0, 1, 3, 5, 6];
  return (
    <box flexDirection="row">
      {name.split("").map((ch, i) => (
        <text key={`sidebar-title-${i}`} fg={LOGO_GRADIENT[indices[i]]} bold content={ch} />
      ))}
      <text fg={colors.muted} content={` ${APP_VERSION}`} />
    </box>
  );
}

function SidebarView(
  {
    width,
    contextTokens,
    contextLimit,
    cacheReadTokens,
    checkpoints,
    colors,
  }: {
    width: number;
    contextTokens: number;
    contextLimit?: number;
    cacheReadTokens?: number;
    checkpoints: PlanCheckpointUi[] | null;
    colors: OpenTuiPalette;
  },
): React.ReactElement {
  const safeCheckpoints = checkpoints ?? [];

  return (
    <box
      width={width}
      minWidth={width}
      maxWidth={width}
      flexDirection="column"
      border={["left"] as any}
      borderColor={colors.separator}
      borderStyle="single"
    >
      <scrollbox
        flexGrow={1}
        viewportOptions={{ paddingRight: 1 }}
        autoHideScrollbars={1500}
        verticalScrollbarOptions={{
          paddingLeft: 1,
          trackOptions: {
            backgroundColor: "transparent",
            foregroundColor: colors.border + "44",
          },
        }}
      >
        <box flexDirection="column" gap={1} width="100%" paddingLeft={1}>
          <SidebarTitle colors={colors} />
          <ContextUsageCard
            contextTokens={contextTokens}
            contextLimit={contextLimit}
            cacheReadTokens={cacheReadTokens}
            colors={colors}
          />
          <PlanCard checkpoints={safeCheckpoints} colors={colors} />
        </box>
      </scrollbox>
    </box>
  );
}

function truncateToWidth(text: string, maxWidth: number): string {
  const textWidth = Bun.stringWidth(text);
  if (textWidth <= maxWidth) return text;
  // Need to truncate — reserve 3 chars for "..."
  const target = maxWidth - 3;
  if (target <= 0) return "...".slice(0, maxWidth);
  let w = 0;
  let i = 0;
  for (const ch of text) {
    const cw = Bun.stringWidth(ch) || 1;
    if (w + cw > target) return text.slice(0, i) + "...";
    w += cw;
    i += ch.length;
  }
  return text;
}

function CommandOverlayView(
  {
    overlay,
    colors,
    contentWidth,
    maxVisible,
    onItemClick,
  }: {
    overlay: CommandOverlayState;
    colors: OpenTuiPalette;
    contentWidth: number;
    maxVisible: number;
    onItemClick: (index: number) => void;
  },
): React.ReactElement | null {
  if (!overlay.visible || overlay.items.length === 0) return null;
  const [hovered, setHovered] = useState(-1);
  const { start, end } = getVisibleWindow(overlay.items.length, overlay.selected, maxVisible);
  const visibleItems = overlay.items.slice(start, end);
  const overlayHeight = visibleItems.length + 2;

  return (
    <box
      border
      borderColor={colors.border}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      width="100%"
      height={overlayHeight}
      flexShrink={0}
      selectable={false}
      onMouseOut={() => setHovered(-1)}
    >
      {visibleItems.map((item, index) => {
        const actualIndex = start + index;
        const selected = actualIndex === overlay.selected;
        const isHovered = actualIndex === hovered;
        const prefix = selected ? "> " : "  ";
        return (
          <box
            key={`overlay-${actualIndex}`}
            width="100%"
            backgroundColor={isHovered ? colors.border : "transparent"}
            onMouseOver={() => setHovered(actualIndex)}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onItemClick(actualIndex); }}
          >
            <text
              fg={selected ? colors.accent : colors.dim}
              content={truncateToWidth(`${prefix}${item}`, contentWidth)}
            />
          </box>
        );
      })}
    </box>
  );
}

function CommandPickerView(
  {
    picker: pickerProp,
    colors,
    contentWidth,
    maxVisible,
    onItemClick,
  }: {
    picker: CommandPickerState | null;
    colors: OpenTuiPalette;
    contentWidth: number;
    maxVisible: number;
    onItemClick: (index: number) => void;
  },
): React.ReactElement | null {
  if (!isCommandPickerActive(pickerProp)) return null;
  const [hovered, setHovered] = useState(-1);

  // Override maxVisible at render time so terminal resize is reflected
  const picker = { ...pickerProp, maxVisible };
  const level = getCommandPickerLevel(picker);
  const path = getCommandPickerPath(picker);
  const { start, end } = getCommandPickerVisibleRange(picker);
  const visibleOptions = level.options.slice(start, end);
  const pickerHeight = 1 + visibleOptions.length + 2;

  return (
    <box
      border
      borderColor={colors.border}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      width="100%"
      height={pickerHeight}
      flexShrink={0}
      selectable={false}
      onMouseOut={() => setHovered(-1)}
    >
      {path.length > 0 ? (
        <text fg={colors.accent} content={truncateToWidth(`${picker.commandName} › ${path.join(" › ")}`, contentWidth)} />
      ) : (
        <text fg={colors.accent} content={truncateToWidth(picker.commandName, contentWidth)} />
      )}
      {visibleOptions.map((item, index) => {
        const actualIndex = start + index;
        const selected = actualIndex === level.selected;
        const isHovered = actualIndex === hovered;
        const prefix = selected ? "> " : "  ";
        return (
          <box
            key={`picker-d${picker.stack.length}-${actualIndex}`}
            width="100%"
            backgroundColor={isHovered ? colors.border : "transparent"}
            onMouseOver={() => setHovered(actualIndex)}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onItemClick(actualIndex); }}
          >
            <text fg={selected ? colors.accent : colors.dim} content={truncateToWidth(`${prefix}${item.label}`, contentWidth)} />
          </box>
        );
      })}
    </box>
  );
}

function CheckboxPickerView(
  {
    picker,
    colors,
    contentWidth,
    onItemClick,
    onScroll,
  }: {
    picker: CheckboxPickerState | null;
    colors: OpenTuiPalette;
    contentWidth: number;
    onItemClick: (index: number) => void;
  },
): React.ReactElement | null {
  if (!isCheckboxPickerActive(picker)) return null;
  const [hovered, setHovered] = useState(-1);

  const { start, end } = getCheckboxPickerVisibleRange(picker);
  const visibleItems = picker.items.slice(start, end);
  const pickerHeight = 1 + visibleItems.length + 1 + 2;

  return (
    <box
      border
      borderColor={colors.border}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      width="100%"
      height={pickerHeight}
      flexShrink={0}
      selectable={false}
      onMouseOut={() => setHovered(-1)}
    >
      <text fg={colors.accent} content={truncateToWidth(picker.title, contentWidth)} />
      {visibleItems.map((item, index) => {
        const actualIndex = start + index;
        const selected = actualIndex === picker.selected;
        const isHovered = actualIndex === hovered;
        const checkbox = item.checked ? "[x]" : "[ ]";
        const prefix = selected ? "> " : "  ";
        return (
          <box
            key={`checkbox-${actualIndex}`}
            width="100%"
            backgroundColor={isHovered ? colors.border : "transparent"}
            onMouseOver={() => setHovered(actualIndex)}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onItemClick(actualIndex); }}
          >
            <text
              fg={selected ? colors.accent : colors.dim}
              content={truncateToWidth(`${prefix}${checkbox} ${item.label}`, contentWidth)}
            />
          </box>
        );
      })}
      <text fg={colors.dim} content={truncateToWidth("Space toggle · Enter confirm · Esc cancel", contentWidth)} />
    </box>
  );
}

function PromptSelectView(
  {
    prompt,
    colors,
    contentWidth,
    maxVisible,
    onItemClick,
    onScroll,
  }: {
    prompt: PromptSelectState | null;
    colors: OpenTuiPalette;
    contentWidth: number;
    maxVisible: number;
    onItemClick: (index: number) => void;
  },
): React.ReactElement | null {
  if (!prompt || prompt.options.length === 0) return null;
  const [hovered, setHovered] = useState(-1);

  const { start, end } = getVisibleWindow(prompt.options.length, prompt.selected, maxVisible);
  const visibleOptions = prompt.options.slice(start, end);
  const selectedOption = prompt.options[clamp(prompt.selected, 0, prompt.options.length - 1)];
  const description = selectedOption?.description?.trim();
  const promptHeight = 1 + visibleOptions.length + (description ? 1 : 0) + 2;

  return (
    <box
      border
      borderColor={colors.border}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      width="100%"
      height={promptHeight}
      flexShrink={0}
      selectable={false}
      onMouseOut={() => setHovered(-1)}
    >
      <text fg={colors.yellow} content={truncateToWidth(prompt.message, contentWidth)} />
      {visibleOptions.map((option, index) => {
        const actualIndex = start + index;
        const selected = actualIndex === prompt.selected;
        const isHovered = actualIndex === hovered;
        const prefix = selected ? "> " : "  ";
        return (
          <box
            key={`prompt-select-${actualIndex}`}
            width="100%"
            backgroundColor={isHovered ? colors.border : "transparent"}
            onMouseOver={() => setHovered(actualIndex)}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onItemClick(actualIndex); }}
          >
            <text fg={selected ? colors.accent : colors.dim} content={truncateToWidth(`${prefix}${option.label}`, contentWidth)} />
          </box>
        );
      })}
      {description ? <text fg={colors.dim} content={truncateToWidth(description, contentWidth)} /> : null}
    </box>
  );
}

function PromptSecretView(
  {
    prompt,
    inputRef,
    focused,
    onSubmit,
    colors,
  }: {
    prompt: PromptSecretState | null;
    inputRef: React.RefObject<InputRenderable | null>;
    focused: boolean;
    onSubmit: (value: string) => void;
    colors: OpenTuiPalette;
  },
): React.ReactElement | null {
  if (!prompt) return null;

  const promptHeight = Math.max(5, prompt.message.split("\n").length + 4);
  return (
    <box
      border
      borderColor={colors.border}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      height={promptHeight}
    >
      <text fg={colors.yellow} content={prompt.message} />
      <input
        ref={(node) => {
          inputRef.current = node;
        }}
        placeholder={prompt.allowEmpty ? "Press Enter to confirm, Esc to cancel" : "Enter a value"}
        focused={focused}
        textColor={colors.text}
        focusedTextColor={colors.text}
        placeholderColor={colors.dim}
        onSubmit={onSubmit}
      />
      <text fg={colors.dim} content="Enter confirm · Esc cancel" />
    </box>
  );
}

function AskPanelView(
  {
    ask,
    error,
    selectedIndex,
    currentQuestionIndex,
    totalQuestions,
    questionAnswers,
    customInputMode,
    noteInputMode,
    reviewMode,
    inlineValue,
    optionNotes,
    inputRef,
    onInput,
    onSubmit,
    colors,
  }: {
    ask: PendingAskUi;
    error?: string | null;
    selectedIndex: number;
    currentQuestionIndex: number;
    totalQuestions: number;
    questionAnswers: Map<number, QuestionAnswerState>;
    customInputMode: boolean;
    noteInputMode: boolean;
    reviewMode: boolean;
    inlineValue: string;
    optionNotes: Map<string, string>;
    inputRef: React.RefObject<InputRenderable | null>;
    onInput: (value: string) => void;
    onSubmit: (value: string) => void;
    colors: OpenTuiPalette;
  },
): React.ReactElement {
  if (ask.kind !== "agent_question") {
    return (
      <box border borderColor={colors.border} paddingLeft={1} paddingRight={1} flexDirection="column">
        <text fg={colors.red} content={`Unsupported ask kind: ${ask.kind}`} />
        <text content={ask.summary} />
        {error ? <text fg={colors.red} content={error} /> : null}
      </box>
    );
  }

  const questions = (ask.payload["questions"] as AgentQuestionItem[]) ?? [];

  if (reviewMode) {
    const reviewContentLines =
      1 +
      questions.reduce((total, question, index) => {
        const answer = questionAnswers.get(index);
        const noteKey = answer ? `${index}-${answer.optionIndex}` : "";
        const note = noteKey ? optionNotes.get(noteKey) : undefined;
        return total + 2 + (note ? 1 : 0);
      }, 0) +
      1 +
      (error ? 1 : 0);
    const panelHeight = reviewContentLines + 2;
    return (
      <box border borderColor={colors.border} paddingLeft={1} paddingRight={1} flexDirection="column" height={panelHeight}>
        <text fg={colors.green} content="Review your answers" />
        {questions.map((question, index) => {
          const answer = questionAnswers.get(index);
          const selected = answer ? question.options[answer.optionIndex] : undefined;
          const answerDisplay = !answer
            ? "(unanswered)"
            : selected?.kind === "custom_input"
              ? `✎ ${answer.customText ?? ""}`
              : selected?.label ?? "(unknown)";
          const noteKey = answer ? `${index}-${answer.optionIndex}` : "";
          const note = noteKey ? optionNotes.get(noteKey) : undefined;
          return (
            <box key={`ask-review-${index}`} flexDirection="column">
              <text content={`${index + 1}. ${question.question}`} />
              <text fg={!answer ? colors.yellow : selected?.kind === "discuss_further" ? colors.yellow : colors.green} content={`   → ${answerDisplay}`} />
              {note ? <text fg={colors.yellow} content={`     Note: ${note}`} /> : null}
            </box>
          );
        })}
        <text fg={colors.dim} content="Enter to submit. Esc to go back." />
        {error ? <text fg={colors.red} content={error} /> : null}
      </box>
    );
  }

  const question = questions[currentQuestionIndex];
  if (!question) {
    return (
      <box border borderColor={colors.border} paddingLeft={1} paddingRight={1} flexDirection="column">
        <text fg={colors.red} content="Question index out of range." />
      </box>
    );
  }

  const existingAnswer = questionAnswers.get(currentQuestionIndex);
  const agentOptionCount = question.options.filter((option) => !option.systemAdded).length;
  const optionContentLines = question.options.reduce((total, option, index) => {
    const note = !option.systemAdded ? optionNotes.get(`${currentQuestionIndex}-${index}`) : undefined;
    return total + 1 + (option.description ? 1 : 0) + (note ? 1 : 0);
  }, 0);
  const inlineLines = customInputMode || noteInputMode ? 3 : 0;
  const panelContentLines = 1 + optionContentLines + inlineLines + 1 + (error ? 1 : 0);
  const panelHeight = panelContentLines + 2;

  return (
    <box border borderColor={colors.border} paddingLeft={1} paddingRight={1} flexDirection="column" height={panelHeight}>
      <text fg={colors.yellow} content={`Question ${currentQuestionIndex + 1}/${totalQuestions}: ${question.question}`} />
      {question.options.map((option, index) => {
        const isSelected = index === selectedIndex;
        const isAnswered = existingAnswer?.optionIndex === index;
        const note = !option.systemAdded ? optionNotes.get(`${currentQuestionIndex}-${index}`) : undefined;
        return (
          <box key={`ask-option-${index}`} flexDirection="column">
            <text
              fg={isSelected ? colors.accent : isAnswered ? colors.green : colors.text}
              content={`${isSelected ? "> " : isAnswered ? "✓ " : "  "}${option.label}`}
            />
            {option.description ? <text fg={colors.dim} content={`   ${option.description}`} /> : null}
            {note ? <text fg={colors.yellow} content={`   Note: ${note}${isSelected ? " (Tab to edit)" : ""}`} /> : null}
          </box>
        );
      })}
      {customInputMode || noteInputMode ? (
        <box flexDirection="column">
          <text
            fg={customInputMode ? colors.accent : colors.yellow}
            content={customInputMode ? "Your answer:" : "Note:"}
          />
          <input
            ref={(node) => {
              inputRef.current = node;
            }}
            value={inlineValue}
            focused={customInputMode || noteInputMode}
            placeholder={customInputMode ? "Type a custom answer" : "Add a note"}
            textColor={colors.text}
            focusedTextColor={colors.text}
            placeholderColor={colors.dim}
            onInput={onInput}
            onChange={onInput}
            onSubmit={onSubmit}
          />
          <text
            fg={colors.dim}
            content={customInputMode ? "Enter to confirm. Esc to cancel." : "Enter to save note. Esc to cancel."}
          />
        </box>
      ) : null}
      <text
        fg={colors.dim}
        content={`Use ↑/↓ to select, ←/→ to navigate questions, Enter to confirm.${agentOptionCount > 0 && selectedIndex < agentOptionCount ? " Tab to add note." : ""
          }`}
      />
      {error ? <text fg={colors.red} content={error} /> : null}
    </box>
  );
}

export function OpenTuiApp({
  session,
  commandRegistry,
  store,
  verbose = false,
  onExit,
}: OpenTuiAppProps): React.ReactElement {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const [entries, setEntries] = useState<ConversationEntry[]>(
    projectToTuiEntries([...(session.log ?? [])] as any[]),
  );
  const theme = THEME;
  const [processing, _setProcessing] = useState(false);
  const processingRef = useRef(false);
  const setProcessing = useCallback((v: boolean) => {
    processingRef.current = v;
    _setProcessing(v);
  }, []);
  const [phase, setPhase] = useState<ActivityPhase>("idle");
  const [contextTokens, setContextTokens] = useState(0);
  const [cacheReadTokens, setCacheReadTokens] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [markdownMode, setMarkdownMode] = useState<"rendered" | "raw">("rendered");
  const [pendingAsk, setPendingAsk] = useState<PendingAskUi | null>(
    typeof session.getPendingAsk === "function" ? session.getPendingAsk() : null,
  );
  const [askError, setAskError] = useState<string | null>(null);
  const [askSelectionIndex, setAskSelectionIndex] = useState(0);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [questionAnswers, setQuestionAnswers] = useState<Map<number, QuestionAnswerState>>(new Map());
  const [customInputMode, setCustomInputMode] = useState(false);
  const [noteInputMode, setNoteInputMode] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [askInputValue, setAskInputValue] = useState("");
  const [optionNotes, setOptionNotes] = useState<Map<string, string>>(new Map());
  const [planCheckpoints, setPlanCheckpoints] = useState<PlanCheckpointUi[] | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [inputVisibleLines, setInputVisibleLines] = useState(1);
  const [commandOverlay, setCommandOverlay] = useState<CommandOverlayState>(EMPTY_COMMAND_OVERLAY);
  const [commandPicker, setCommandPicker] = useState<CommandPickerState | null>(null);
  const [checkboxPicker, setCheckboxPicker] = useState<CheckboxPickerState | null>(null);
  const [promptSelect, setPromptSelect] = useState<PromptSelectState | null>(null);
  const [promptSecret, setPromptSecret] = useState<PromptSecretState | null>(null);

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const promptSecretInputRef = useRef<InputRenderable | null>(null);
  const askInputRef = useRef<InputRenderable | null>(null);
  const lastInputValueRef = useRef("");
  const lastCtrlCRef = useRef(0);
  const closingRef = useRef(false);
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suppressComposerSyncRef = useRef(false);
  const pasteCounterRef = useRef(new TurnPasteCounter());
  const maybeCollapseLargePasteRef = useRef<(previousValue: string, nextValue: string) => boolean>(() => false);
  const updateInputOverlayRef = useRef<(value: string, cursorOffset: number) => void>(() => { });
  const composerTokenVisualsRef = useRef<ComposerTokenVisuals | null>(null);
  const promptSelectResolverRef = useRef<((value: string | undefined) => void) | null>(null);
  const promptSecretResolverRef = useRef<((value: string | undefined) => void) | null>(null);
  const colors = theme.colors;
  const markdownStyle = theme.markdownStyle;
  if (!composerTokenVisualsRef.current) {
    composerTokenVisualsRef.current = createComposerTokenVisuals(colors);
  }
  const composerTokenVisuals = composerTokenVisualsRef.current;

  useEffect(() => {
    setAskError(null);
    setAskSelectionIndex(0);
    setCurrentQuestionIndex(0);
    setQuestionAnswers(new Map());
    setCustomInputMode(false);
    setNoteInputMode(false);
    setReviewMode(false);
    setAskInputValue("");
    setOptionNotes(new Map());
  }, [pendingAsk?.id]);

  const autoSave = useCallback(() => {
    if (!store || !store.sessionDir || typeof session.getLogForPersistence !== "function") return;
    try {
      const { meta, entries: persistedEntries } = session.getLogForPersistence();
      if (meta.turnCount === 0) return;
      saveLog(store.sessionDir, meta, persistedEntries as any[]);
    } catch {
      // ignore autosave failures in the prototype
    }
  }, [session, store]);

  useEffect(() => {
    session.onSaveRequest = autoSave;
    return () => {
      session.onSaveRequest = undefined;
    };
  }, [session, autoSave]);

  const runPendingTurn = useCallback(async () => {
    if (typeof session.resumePendingTurn !== "function") {
      setAskError("Current session does not support resuming pending asks.");
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("working");
    try {
      await session.resumePendingTurn({ signal: controller.signal });
      setPhase("idle");
      setContextTokens(session.lastInputTokens);
      setCacheReadTokens(session.lastCacheReadTokens ?? 0);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      autoSave();
    } catch (err) {
      if (!controller.signal.aborted) {
        setAskError(err instanceof Error ? err.message : String(err));
        session.appendErrorMessage?.(err instanceof Error ? err.message : String(err), "resume_pending_turn");
        setPhase("error");
      }
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
    }
  }, [autoSave, session]);

  const getAskQuestions = useCallback((): AgentQuestionItem[] => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return [];
    return (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
  }, [pendingAsk]);

  const resolveAgentQuestion = useCallback((
    answersOverride?: Map<number, QuestionAnswerState>,
    notesOverride?: Map<string, string>,
  ) => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
    const effectiveAnswers = answersOverride ?? questionAnswers;
    const effectiveNotes = notesOverride ?? optionNotes;

    for (let index = 0; index < questions.length; index += 1) {
      if (!effectiveAnswers.has(index)) {
        setReviewMode(false);
        setCurrentQuestionIndex(index);
        setAskSelectionIndex(0);
        setAskError("Please answer all questions before continuing.");
        return;
      }
    }

    const answers: AgentQuestionAnswer[] = [];
    for (let index = 0; index < questions.length; index += 1) {
      const answer = effectiveAnswers.get(index)!;
      const selectedOption = questions[index].options[answer.optionIndex];
      if (!selectedOption) {
        setReviewMode(false);
        setCurrentQuestionIndex(index);
        setAskSelectionIndex(0);
        setAskError("Selected answer is out of range.");
        return;
      }
      answers.push({
        questionIndex: index,
        selectedOptionIndex: answer.optionIndex,
        answerText: selectedOption.kind === "custom_input" ? (answer.customText ?? "") : selectedOption.label,
        note: effectiveNotes.get(`${index}-${answer.optionIndex}`) || undefined,
      });
    }

    const decision: AgentQuestionDecision = { answers };
    try {
      session.resolveAgentQuestionAsk?.(pendingAsk.id, decision);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      setAskError(null);
      autoSave();
      if (session.hasPendingTurnToResume?.()) {
        void runPendingTurn();
      }
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    }
  }, [autoSave, optionNotes, pendingAsk, questionAnswers, runPendingTurn, session]);

  const confirmCurrentQuestion = useCallback((selectedIndex: number, extra?: { customText?: string }) => {
    const next = new Map(questionAnswers);
    next.set(currentQuestionIndex, { optionIndex: selectedIndex, ...extra });
    setQuestionAnswers(next);
    return next;
  }, [currentQuestionIndex, questionAnswers]);

  const submitOrReview = useCallback((updated: Map<number, QuestionAnswerState>) => {
    const questions = getAskQuestions();
    const firstMissing = questions.findIndex((_, index) => !updated.has(index));
    if (firstMissing !== -1) {
      setReviewMode(false);
      setCurrentQuestionIndex(firstMissing);
      setAskSelectionIndex(0);
      setAskError("Please answer all questions before reviewing.");
      return;
    }
    if (questions.length > 1) {
      setAskError(null);
      setReviewMode(true);
      return;
    }
    resolveAgentQuestion(updated, optionNotes);
  }, [getAskQuestions, optionNotes, resolveAgentQuestion]);

  const beginAskCustomInput = useCallback((selectedIndex: number) => {
    const existing = questionAnswers.get(currentQuestionIndex);
    const initialValue = existing?.optionIndex === selectedIndex ? (existing.customText ?? "") : "";
    setAskInputValue(initialValue);
    setCustomInputMode(true);
  }, [currentQuestionIndex, questionAnswers]);

  const beginAskNoteInput = useCallback((selectedIndex: number) => {
    const noteKey = `${currentQuestionIndex}-${selectedIndex}`;
    setAskInputValue(optionNotes.get(noteKey) ?? "");
    setNoteInputMode(true);
  }, [currentQuestionIndex, optionNotes]);

  const cancelAskInlineInput = useCallback(() => {
    setCustomInputMode(false);
    setNoteInputMode(false);
    setAskInputValue("");
  }, []);

  const resolveSelectedPendingAsk = useCallback(() => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
    const question = questions[currentQuestionIndex];
    if (!question) return;

    const selectedOption = question.options[askSelectionIndex];
    if (!selectedOption) return;

    if (selectedOption.kind === "custom_input") {
      beginAskCustomInput(askSelectionIndex);
      return;
    }

    const updated = confirmCurrentQuestion(askSelectionIndex);
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((current) => current + 1);
      setAskSelectionIndex(0);
      setAskError(null);
      return;
    }
    submitOrReview(updated);
  }, [
    askSelectionIndex,
    beginAskCustomInput,
    confirmCurrentQuestion,
    currentQuestionIndex,
    pendingAsk,
    submitOrReview,
  ]);

  useEffect(() => {
    const syncFromLog = () => {
      setEntries(projectToTuiEntries([...(session.log ?? [])] as any[]));
      setPendingAsk(session.getPendingAsk?.() ?? null);
      setContextTokens(session.lastInputTokens);
      setCacheReadTokens(session.lastCacheReadTokens ?? 0);
    };

    syncFromLog();
    if (typeof session.subscribeLog !== "function") return;
    return session.subscribeLog(syncFromLog);
  }, [session]);

  const handleProgressRef = useRef<(event: ProgressEvent) => void>(() => { });
  handleProgressRef.current = (event) => {
    if (closingRef.current) return;
    switch (event.action) {
      case "reasoning_chunk":
        setPhase("thinking");
        break;
      case "text_chunk":
        setPhase("generating");
        break;
      case "tool_call":
        setPhase("working");
        break;
      case "agent_no_reply":
        setPhase("waiting");
        break;
      case "agent_end":
        setPhase("idle");
        setContextTokens(session.lastInputTokens);
        setCacheReadTokens(session.lastCacheReadTokens ?? 0);
        break;
      case "ask_requested":
        setPendingAsk(session.getPendingAsk?.() ?? null);
        setAskError(null);
        setPhase("waiting");
        break;
      case "ask_resolved":
        setPendingAsk(session.getPendingAsk?.() ?? null);
        setAskError(null);
        break;
      case "plan_submit":
      case "plan_update": {
        const checkpoints = event.extra["checkpoints"] as PlanCheckpointUi[] | undefined;
        if (checkpoints) setPlanCheckpoints(checkpoints);
        break;
      }
      case "plan_finish":
        setPlanCheckpoints(null);
        break;
      case "token_update":
        setContextTokens((event.extra["input_tokens"] as number) ?? session.lastInputTokens);
        setCacheReadTokens((event.extra["cache_read_tokens"] as number) ?? session.lastCacheReadTokens ?? 0);
        break;
    }
  };

  useEffect(() => {
    const reporter = new ProgressReporter({
      level: verbose ? "verbose" : "normal",
      callback: (event) => {
        handleProgressRef.current(event);
      },
    });
    session._progress = reporter;
    return () => {
      if (session._progress === reporter) {
        session._progress = undefined;
      }
    };
  }, [session, verbose]);

  const syncComposerState = useCallback(() => {
    const composer = inputRef.current;
    if (!composer || composer.isDestroyed) return;
    const previousValue = lastInputValueRef.current;
    const nextValue = composer.plainText;
    if (previousValue !== nextValue) {
      maybeCollapseLargePasteRef.current(previousValue, nextValue);
    }
    const visibleValue = composer.plainText;
    const cursorOffset = composer.cursorOffset;
    const computedWidth = Math.max(1, composer.getLayoutNode().getComputedWidth());
    const measured = composer.editorView.measureForDimensions(computedWidth, INPUT_MAX_VISIBLE_LINES);
    const measuredLines = Math.max(
      composer.lineCount || 1,
      composer.virtualLineCount || 1,
      measured?.lineCount || 1,
    );
    lastInputValueRef.current = visibleValue;
    setDraftValue(visibleValue);
    setInputVisibleLines(Math.max(1, Math.min(INPUT_MAX_VISIBLE_LINES, measuredLines)));
    updateInputOverlayRef.current(visibleValue, cursorOffset);
  }, []);

  const setComposerText = useCallback((value: string, cursorToEnd = true) => {
    const composer = inputRef.current;
    if (!composer) return;
    composer.setText(value);
    if (cursorToEnd) {
      composer.cursorOffset = Bun.stringWidth(value);
    }
    syncComposerState();
  }, [syncComposerState]);

  const clearInput = useCallback(() => {
    pasteCounterRef.current.reset();
    lastInputValueRef.current = "";
    setDraftValue("");
    setInputVisibleLines(1);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    setCommandPicker(null);
    setCheckboxPicker(null);
    if (inputRef.current) {
      inputRef.current.extmarks.clear();
      inputRef.current.setText("");
    }
  }, []);

  const focusComposerSoon = useCallback(() => {
    queueMicrotask(() => {
      inputRef.current?.focus();
    });
  }, []);

  const resolvePromptSelect = useCallback((value: string | undefined) => {
    const resolve = promptSelectResolverRef.current;
    promptSelectResolverRef.current = null;
    setPromptSelect(null);
    if (resolve) resolve(value);
    focusComposerSoon();
  }, [focusComposerSoon]);

  const resolvePromptSecret = useCallback((value: string | undefined) => {
    const resolve = promptSecretResolverRef.current;
    promptSecretResolverRef.current = null;
    setPromptSecret(null);
    if (promptSecretInputRef.current) {
      promptSecretInputRef.current.value = "";
    }
    if (resolve) resolve(value);
    focusComposerSoon();
  }, [focusComposerSoon]);

  const showHint = useCallback((message: string) => {
    setHint(message);
    setTimeout(() => {
      setHint((current) => (current === message ? null : current));
    }, 2500);
  }, []);

  const performExit = useCallback(async () => {
    autoSave();
    const msg = GOODBYE_MESSAGES[Math.floor(Math.random() * GOODBYE_MESSAGES.length)]!;
    await onExit(msg);
  }, [autoSave, onExit]);

  const beginClosing = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setProcessing(false);
    setPhase("closing");
    setHint(null);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    setCommandPicker(null);
    setCheckboxPicker(null);
    if (closingTimerRef.current) {
      clearTimeout(closingTimerRef.current);
    }
    void performExit();
  }, [performExit]);

  const buildCommandOptions = useCallback((cmdName: string) => {
    const command = commandRegistry.lookup(cmdName);
    if (!command?.options) return [];
    return command.options({
      session,
      store: store ?? undefined,
    });
  }, [commandRegistry, session, store]);

  const pickerMaxVisible = computePickerMaxVisible(terminal.height);

  const startCommandPicker = useCallback((cmdName: string): boolean => {
    const command = commandRegistry.lookup(cmdName);
    const options = buildCommandOptions(cmdName);
    if (options.length === 0) return false;

    setCommandOverlay(EMPTY_COMMAND_OVERLAY);

    if (command?.checkboxMode) {
      setCheckboxPicker(
        createCheckboxPicker(
          cmdName,
          options.map((option) => ({
            label: option.label,
            value: option.value,
            checked: option.checked !== false,
          })),
          Math.min(pickerMaxVisible, options.length),
        ),
      );
      return true;
    }

    setCommandPicker(
      createCommandPicker(
        cmdName,
        options,
        pickerMaxVisible,
      ),
    );
    return true;
  }, [buildCommandOptions, commandRegistry, pickerMaxVisible]);

  const updateInputOverlay = useCallback((value: string, cursorOffset: number) => {
    if (commandPicker || checkboxPicker || promptSelect || promptSecret) return;

    const livePrefix = inputRef.current ? inputRef.current.getTextRange(0, cursorOffset) : value;

    if (isCommandOverlayEligible(livePrefix)) {
      const prefix = livePrefix.slice(1);
      const matches = commandRegistry.getAll().filter((command) =>
        command.name.slice(1).startsWith(prefix),
      );

      if (matches.length > 0) {
        setCommandOverlay((current) => ({
          mode: "command",
          visible: true,
          items: matches.map((command) => `${command.name.padEnd(20)}${command.description}`),
          values: matches.map((command) => command.name),
          selected: current.mode === "command"
            ? clamp(current.selected, 0, Math.max(0, matches.length - 1))
            : 0,
        }));
        return;
      }
    }

    const fileQuery = isFileOverlayEligible(value, cursorOffset)
      ? findFileReferenceQuery(value, cursorOffset)
      : null;
    if (fileQuery) {
      const candidates = scanCandidates(fileQuery.prefix);
      if (candidates.length > 0) {
        setCommandOverlay((current) => ({
          mode: "file",
          visible: true,
          items: candidates,
          values: candidates,
          selected: current.mode === "file"
            ? clamp(current.selected, 0, Math.max(0, candidates.length - 1))
            : 0,
        }));
        return;
      }
    }

    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
  }, [checkboxPicker, commandPicker, commandRegistry, promptSecret, promptSelect]);
  updateInputOverlayRef.current = updateInputOverlay;

  const resetTurnPasteState = useCallback(() => {
    pasteCounterRef.current.reset();
  }, []);

  const maybeCollapseLargePaste = useCallback((previousValue: string, nextValue: string): boolean => {
    const composer = inputRef.current;
    if (!composer || suppressComposerSyncRef.current) return false;

    const diff = getTextDiffRange(previousValue, nextValue);
    if (!diff || !diff.insertedText) return false;

    const decision = classifyPastedText(diff.insertedText, pasteCounterRef.current);
    if (!decision.replacedWithPlaceholder || decision.index === undefined) return false;

    suppressComposerSyncRef.current = true;
    try {
      replaceRangeWithComposerToken(composer, {
        rangeStart: diff.startOffset,
        rangeEnd: diff.endAfterOffset,
        label: decision.text,
        metadata: {
          kind: "paste",
          label: decision.text,
          submitText: diff.insertedText,
          index: decision.index,
          lineCount: decision.lineCount,
        },
        styleId: composerTokenVisuals.pasteStyleId,
      });
    } finally {
      suppressComposerSyncRef.current = false;
    }

    return true;
  }, [composerTokenVisuals.pasteStyleId]);
  maybeCollapseLargePasteRef.current = maybeCollapseLargePaste;

  useEffect(() => {
    const composer = inputRef.current;
    if (!composer) return;
    patchComposerExtmarksForDisplayWidth(composer);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let followupTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      syncComposerState();
    };
    const scheduleSync = () => {
      sync();
      queueMicrotask(sync);
      timeoutId = setTimeout(sync, 0);
      followupTimeoutId = setTimeout(sync, 16);
    };

    composer.onContentChange = scheduleSync;
    composer.onCursorChange = scheduleSync;
    scheduleSync();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (followupTimeoutId) clearTimeout(followupTimeoutId);
      if (inputRef.current === composer) {
        composer.onContentChange = undefined;
        composer.onCursorChange = undefined;
      }
    };
  }, [syncComposerState]);

  useEffect(() => {
    if (promptSecret) {
      queueMicrotask(() => {
        promptSecretInputRef.current?.focus();
      });
      return;
    }

    if (phase === "closing") {
      return;
    }

    if (pendingAsk?.kind === "agent_question" && (customInputMode || noteInputMode)) {
      queueMicrotask(() => {
        askInputRef.current?.focus();
      });
      return;
    }

    if (!pendingAsk && !commandPicker && !checkboxPicker && !promptSelect) {
      focusComposerSoon();
    }
  }, [
    checkboxPicker,
    commandPicker,
    customInputMode,
    focusComposerSoon,
    noteInputMode,
    pendingAsk,
    phase,
    promptSecret,
    promptSelect,
  ]);

  useEffect(() => {
    return () => {
      promptSelectResolverRef.current?.(undefined);
      promptSecretResolverRef.current?.(undefined);
      promptSelectResolverRef.current = null;
      promptSecretResolverRef.current = null;
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current);
        closingTimerRef.current = null;
      }
    };
  }, []);

  const buildCommandContext = useCallback((): CommandContext => {
    return {
      session,
      store: store ?? undefined,
      commandRegistry,
      autoSave,
      showMessage: (message: string) => {
        session.appendStatusMessage?.(message);
      },
      resetUiState: () => {
        setProcessing(false);
        setPhase("idle");
        setContextTokens(session.lastInputTokens);
        setCacheReadTokens(session.lastCacheReadTokens ?? 0);
        setPendingAsk(null);
        setAskError(null);
        setPlanCheckpoints(null);
      },
      exit: performExit,
      onTurnRequested: (content: string) => {
        void handleSubmit(content);
      },
      onManualSummarizeRequested: (instruction: string) => {
        void runManualSummarize(instruction);
      },
      onManualCompactRequested: (instruction: string) => {
        void runManualCompact(instruction);
      },
      promptSecret: async (request: PromptSecretRequest) => {
        resolvePromptSecret(undefined);
        resolvePromptSelect(undefined);
        return await new Promise<string | undefined>((resolve) => {
          promptSecretResolverRef.current = resolve;
          setCommandOverlay(EMPTY_COMMAND_OVERLAY);
          setCommandPicker(null);
          setCheckboxPicker(null);
          setPromptSecret({
            message: request.message,
            allowEmpty: request.allowEmpty ?? false,
          });
          queueMicrotask(() => {
            promptSecretInputRef.current?.focus();
          });
        });
      },
      promptSelect: async (request: PromptSelectRequest) => {
        resolvePromptSelect(undefined);
        resolvePromptSecret(undefined);
        return await new Promise<string | undefined>((resolve) => {
          promptSelectResolverRef.current = resolve;
          setCommandOverlay(EMPTY_COMMAND_OVERLAY);
          setCommandPicker(null);
          setCheckboxPicker(null);
          setPromptSelect({
            message: request.message,
            options: request.options,
            selected: 0,
          });
        });
      },
    };
  }, [session, store, commandRegistry, autoSave, performExit, resolvePromptSecret, resolvePromptSelect]);

  const runTurn = useCallback(async (input: string) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("working");
    try {
      await session.turn(input, { signal: controller.signal });
      setPhase("idle");
      setContextTokens(session.lastInputTokens);
      setCacheReadTokens(session.lastCacheReadTokens ?? 0);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      autoSave();
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(message, "turn");
        setPhase("error");
      }
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
      setPhase("idle");
    }
  }, [session, autoSave]);

  const runManualSummarize = useCallback(async (instruction: string) => {
    if (typeof session.runManualSummarize !== "function") {
      session.appendStatusMessage?.("/summarize is not available in this session.");
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("working");
    try {
      await session.runManualSummarize(instruction, { signal: controller.signal });
      setPhase("idle");
      autoSave();
    } catch (err) {
      if (!controller.signal.aborted) {
        session.appendErrorMessage?.(err instanceof Error ? err.message : String(err), "manual_summarize");
        setPhase("error");
      }
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
      setPhase("idle");
    }
  }, [session, autoSave]);

  const runManualCompact = useCallback(async (instruction: string) => {
    if (typeof session.runManualCompact !== "function") {
      session.appendStatusMessage?.("/compact is not available in this session.");
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("working");
    try {
      await session.runManualCompact(instruction, { signal: controller.signal });
      setPhase("idle");
      autoSave();
    } catch (err) {
      if (!controller.signal.aborted) {
        session.appendErrorMessage?.(err instanceof Error ? err.message : String(err), "manual_compact");
        setPhase("error");
      }
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
      setPhase("idle");
    }
  }, [session, autoSave]);

  const getSerializedComposerInput = useCallback((): string => {
    const composer = inputRef.current;
    if (!composer) return draftValue;
    return serializeComposerText(composer, ensureComposerTokenType(composer));
  }, [draftValue]);

  const handleSubmit = useCallback(async (submittedValue: string) => {
    const input = submittedValue.trim();
    if (!input) return;

    if (pendingAsk) {
      showHint("Ask resolution is not implemented in this prototype yet.");
      return;
    }

    if (!processingRef.current && input.startsWith("/") && !/\s/.test(input)) {
      const command = commandRegistry.lookup(input);
      if (command?.options && startCommandPicker(input)) {
        if (inputRef.current) {
          inputRef.current.extmarks.clear();
          inputRef.current.setText("");
        }
        resetTurnPasteState();
        lastInputValueRef.current = "";
        setDraftValue("");
        setInputVisibleLines(1);
        return;
      }
    }

    clearInput();

    // Use ref to avoid stale closure — OpenTUI's custom renderer may not
    // re-create useCallback closures on every state change.
    const isProcessing = processingRef.current;

    if (isProcessing) {
      if (typeof session.deliverMessage === "function") {
        session.deliverMessage("user", input);
        session.appendStatusMessage?.(`[Queued user message]\n${input}`, "queued_user_message");
        showHint("Message queued for the next activation boundary.");
      } else {
        showHint("The assistant is busy and this prototype cannot queue input here.");
      }
      return;
    }

    if (input.startsWith("/")) {
      const [cmdName] = input.split(/\s+/, 1);
      const args = input.slice(cmdName.length).trim();
      const command = commandRegistry.lookup(cmdName);
      if (!command) {
        session.appendErrorMessage?.(`Unknown command: ${cmdName}`, "command");
        return;
      }
      try {
        await command.handler(buildCommandContext(), args);
      } catch (err) {
        if (isCommandExitSignal(err)) {
          await performExit();
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(`Command failed (${cmdName}): ${message}`, "command");
      }
      return;
    }

    await runTurn(input);
  }, [
    clearInput,
    pendingAsk,
    processing,
    session,
    commandRegistry,
    startCommandPicker,
    buildCommandContext,
    performExit,
    runTurn,
    showHint,
  ]);

  const acceptInputOverlaySelection = useCallback(() => {
    const selectedValue = commandOverlay.values[commandOverlay.selected];
    if (!selectedValue) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    if (commandOverlay.mode === "file") {
      const composer = inputRef.current;
      if (!composer) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      const query = findFileReferenceQuery(composer.plainText, composer.cursorOffset);
      if (!query) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      const label = buildFileReferenceLabel(selectedValue);
      suppressComposerSyncRef.current = true;
      try {
        replaceRangeWithComposerToken(composer, {
          rangeStart: query.startOffset,
          rangeEnd: query.endOffset,
          label,
          metadata: {
            kind: "file",
            label,
            submitText: label,
            path: selectedValue,
          },
          styleId: composerTokenVisuals.fileStyleId,
          trailingText: " ",
        });
      } finally {
        suppressComposerSyncRef.current = false;
      }

      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      syncComposerState();
      return;
    }

    const command = commandRegistry.lookup(selectedValue);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    if (command?.options && startCommandPicker(selectedValue)) {
      if (inputRef.current) {
        inputRef.current.setText("");
        inputRef.current.extmarks.clear();
      }
      resetTurnPasteState();
      lastInputValueRef.current = "";
      setDraftValue("");
      setInputVisibleLines(1);
      return;
    }

    void handleSubmit(selectedValue);
  }, [
    commandOverlay,
    commandRegistry,
    composerTokenVisuals.fileStyleId,
    handleSubmit,
    resetTurnPasteState,
    startCommandPicker,
    syncComposerState,
  ]);

  const completeInputOverlaySelection = useCallback(() => {
    const selectedValue = commandOverlay.values[commandOverlay.selected];
    if (!selectedValue) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    if (commandOverlay.mode === "file") {
      acceptInputOverlaySelection();
      return;
    }

    setComposerText(`${selectedValue} `);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
  }, [acceptInputOverlaySelection, commandOverlay, setComposerText]);

  const acceptCommandPickerSelectionLocal = useCallback(() => {
    if (!commandPicker) return;
    const result = acceptCommandPickerSelection(commandPicker);
    if (!result) {
      setCommandPicker(null);
      return;
    }

    if (result.kind === "drill_down") {
      setCommandPicker(result.picker);
      return;
    }

    setCommandPicker(null);
    void handleSubmit(result.command);
  }, [commandPicker, handleSubmit]);

  const clickCommandPickerItem = useCallback((index: number) => {
    if (!commandPicker) return;
    const withSelection = setCommandPickerSelection(commandPicker, index);
    const result = acceptCommandPickerSelection(withSelection);
    if (!result) {
      setCommandPicker(null);
      return;
    }
    if (result.kind === "drill_down") {
      setCommandPicker(result.picker);
      return;
    }
    setCommandPicker(null);
    void handleSubmit(result.command);
  }, [commandPicker, handleSubmit]);

  const clickCheckboxPickerItem = useCallback((index: number) => {
    setCheckboxPicker((current) => {
      if (!current) return current;
      const withSelection = setCheckboxPickerSelection(current, index);
      return toggleCheckboxItem(withSelection);
    });
  }, []);

  const clickOverlayItem = useCallback((index: number) => {
    const selectedValue = commandOverlay.values[index];
    if (!selectedValue) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    if (commandOverlay.mode === "file") {
      // Set selection and let the standard accept handle file references
      setCommandOverlay((current) => ({ ...current, selected: index }));
      acceptInputOverlaySelection();
      return;
    }

    const command = commandRegistry.lookup(selectedValue);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    if (command?.options && startCommandPicker(selectedValue)) {
      if (inputRef.current) {
        inputRef.current.setText("");
        inputRef.current.extmarks.clear();
      }
      resetTurnPasteState();
      lastInputValueRef.current = "";
      setDraftValue("");
      setInputVisibleLines(1);
      return;
    }
    void handleSubmit(selectedValue);
  }, [commandOverlay, commandRegistry, startCommandPicker, handleSubmit, acceptInputOverlaySelection, resetTurnPasteState]);

  const clickPromptSelectItem = useCallback((index: number) => {
    if (!promptSelect) return;
    const option = promptSelect.options[clamp(index, 0, promptSelect.options.length - 1)];
    resolvePromptSelect(option?.value);
  }, [promptSelect, resolvePromptSelect]);

  const submitCheckboxPickerSelection = useCallback(async () => {
    if (!checkboxPicker) return;
    const result = submitCheckboxPicker(checkboxPicker);
    if (result.kind !== "submit") return;

    const enabled = result.items.filter((item) => item.checked).map((item) => item.value);
    const args = enabled.length > 0 ? enabled.join(",") : ",";
    setCheckboxPicker(null);
    await handleSubmit(`/skills ${args}`);
  }, [checkboxPicker, handleSubmit]);

  const deleteToVisualLineStart = useCallback(() => {
    const composer = inputRef.current;
    if (!composer) return;

    if (composer.hasSelection()) {
      composer.deleteCharBackward();
      syncComposerState();
      return;
    }

    const cursor = composer.editorView.getCursor();
    const visualStart = composer.editorView.getVisualSOL();
    if (
      visualStart.logicalRow === cursor.row &&
      visualStart.logicalCol === cursor.col
    ) {
      return;
    }

    if (visualStart.logicalRow === cursor.row && visualStart.logicalCol === 0) {
      composer.deleteToLineStart();
      syncComposerState();
      return;
    }

    composer.gotoVisualLineHome({ select: true });
    if (composer.hasSelection()) {
      composer.deleteCharBackward();
    }
    syncComposerState();
  }, [syncComposerState]);

  const isAtFirstVisualLine = useCallback((): boolean => {
    const composer = inputRef.current;
    if (!composer) return false;
    const visualStart = composer.editorView.getVisualSOL();
    return visualStart.logicalRow === 0 && visualStart.logicalCol === 0;
  }, []);

  const isAtLastVisualLine = useCallback((): boolean => {
    const composer = inputRef.current;
    if (!composer) return false;
    const lineCount = composer.lineCount || composer.editBuffer.getLineCount();
    const visualEnd = composer.editorView.getVisualEOL();
    const logicalEnd = composer.editBuffer.getEOL();
    return (
      visualEnd.logicalRow === Math.max(0, lineCount - 1) &&
      visualEnd.logicalCol === logicalEnd.col
    );
  }, []);

  const moveComposerVertically = useCallback((direction: "up" | "down") => {
    const composer = inputRef.current;
    if (!composer) return;

    if (direction === "up") {
      composer.moveCursorUp();
    } else {
      composer.moveCursorDown();
    }

    syncComposerState();
  }, [syncComposerState]);

  const acceptPromptSelect = useCallback(() => {
    if (!promptSelect) return;
    const option = promptSelect.options[clamp(promptSelect.selected, 0, promptSelect.options.length - 1)];
    resolvePromptSelect(option?.value);
  }, [promptSelect, resolvePromptSelect]);

  const submitPromptSecret = useCallback((value: string) => {
    if (!promptSecret) return;
    if (!promptSecret.allowEmpty && value.trim() === "") {
      showHint("A value is required.");
      return;
    }
    resolvePromptSecret(value);
  }, [promptSecret, resolvePromptSecret, showHint]);

  const submitAskInlineInput = useCallback((value: string) => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];

    if (noteInputMode) {
      const noteText = value.trim();
      const noteKey = `${currentQuestionIndex}-${askSelectionIndex}`;
      setOptionNotes((current) => {
        const next = new Map(current);
        if (noteText) {
          next.set(noteKey, noteText);
        } else {
          next.delete(noteKey);
        }
        return next;
      });
      confirmCurrentQuestion(askSelectionIndex);
      cancelAskInlineInput();
      return;
    }

    if (!customInputMode) return;

    const customText = value.trim();
    if (!customText) {
      setAskError(CUSTOM_EMPTY_HINT);
      return;
    }

    const updated = confirmCurrentQuestion(askSelectionIndex, { customText });
    cancelAskInlineInput();
    setAskError(null);
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((current) => current + 1);
      setAskSelectionIndex(0);
      return;
    }
    submitOrReview(updated);
  }, [
    askSelectionIndex,
    cancelAskInlineInput,
    confirmCurrentQuestion,
    currentQuestionIndex,
    customInputMode,
    noteInputMode,
    pendingAsk,
    submitOrReview,
  ]);

  useKeyboard((event) => {
    const selectionText = renderer.getSelection()?.getSelectedText() ?? "";
    const hasSelection = selectionText.length > 0;
    const isCopyCombo = event.name === "c" && (event.meta || event.super || event.ctrl);
    const composer = inputRef.current;

    if (phase === "closing") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (hasSelection && isCopyCombo) {
      const copied = copyToClipboard(selectionText, (text) => renderer.copyToClipboardOSC52(text));
      if (!copied) {
        showHint("Copy failed.");
      }
      renderer.clearSelection();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (hasSelection && event.name === "escape") {
      renderer.clearSelection();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (promptSecret) {
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        resolvePromptSecret(undefined);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (promptSelect) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setPromptSelect((current) => current
          ? { ...current, selected: (current.selected - 1 + current.options.length) % current.options.length }
          : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down" || event.name === "tab") {
        setPromptSelect((current) => current
          ? { ...current, selected: (current.selected + 1) % current.options.length }
          : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        acceptPromptSelect();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        resolvePromptSelect(undefined);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (pendingAsk?.kind === "agent_question") {
      if (!(event.name === "c" && event.ctrl)) {
        const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
        const question = questions[currentQuestionIndex];
        const totalOptions = question?.options.length ?? 0;
        const agentOptionCount = question?.options.filter((option) => !option.systemAdded).length ?? 0;

        if (reviewMode) {
          if (event.name === "return") {
            resolveAgentQuestion(questionAnswers, optionNotes);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.name === "escape") {
            setReviewMode(false);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (/^[1-9]$/.test(event.name)) {
            const nextQuestionIndex = Number(event.name) - 1;
            if (nextQuestionIndex < questions.length) {
              setReviewMode(false);
              setCurrentQuestionIndex(nextQuestionIndex);
              setAskSelectionIndex(questionAnswers.get(nextQuestionIndex)?.optionIndex ?? 0);
            }
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          return;
        }

        if (customInputMode || noteInputMode) {
          if (event.name === "escape") {
            cancelAskInlineInput();
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }

        if (!question) return;

        if (event.name === "tab" && askSelectionIndex < agentOptionCount) {
          beginAskNoteInput(askSelectionIndex);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "up" && totalOptions > 0) {
          setAskSelectionIndex((current) => (current - 1 + totalOptions) % totalOptions);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "down" && totalOptions > 0) {
          setAskSelectionIndex((current) => (current + 1) % totalOptions);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "left" && questions.length > 1) {
          setCurrentQuestionIndex((current) => Math.max(0, current - 1));
          setAskSelectionIndex(questionAnswers.get(Math.max(0, currentQuestionIndex - 1))?.optionIndex ?? 0);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "right" && questions.length > 1) {
          if (question.options[askSelectionIndex]?.kind !== "custom_input") {
            confirmCurrentQuestion(askSelectionIndex);
          }
          const nextQuestionIndex = Math.min(questions.length - 1, currentQuestionIndex + 1);
          setCurrentQuestionIndex(nextQuestionIndex);
          setAskSelectionIndex(questionAnswers.get(nextQuestionIndex)?.optionIndex ?? 0);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "return") {
          resolveSelectedPendingAsk();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }

    if (isCheckboxPickerActive(checkboxPicker)) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setCheckboxPicker((current) => current ? moveCheckboxSelection(current, -1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down" || event.name === "tab") {
        setCheckboxPicker((current) => current ? moveCheckboxSelection(current, 1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "space") {
        setCheckboxPicker((current) => current ? toggleCheckboxItem(current) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        event.preventDefault();
        event.stopPropagation();
        void submitCheckboxPickerSelection();
        return;
      }
      if (event.name === "escape") {
        setCheckboxPicker(null);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (isCommandPickerActive(commandPicker)) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setCommandPicker((current) => current ? moveCommandPickerSelection(current, -1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down" || event.name === "tab") {
        setCommandPicker((current) => current ? moveCommandPickerSelection(current, 1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        event.preventDefault();
        event.stopPropagation();
        acceptCommandPickerSelectionLocal();
        return;
      }
      if (event.name === "escape") {
        setCommandPicker((current) => current ? exitCommandPickerLevel(current) : null);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    const liveComposerValue = composer?.plainText ?? draftValue;
    const liveCursorOffset = composer?.cursorOffset ?? liveComposerValue.length;
    const shouldHandleInputOverlay = commandOverlay.visible && (
      commandOverlay.mode === "command"
        ? isCommandOverlayEligible(composer ? composer.getTextRange(0, liveCursorOffset) : liveComposerValue)
        : isFileOverlayEligible(liveComposerValue, liveCursorOffset)
    );
    if (commandOverlay.visible && !shouldHandleInputOverlay) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    }

    if (shouldHandleInputOverlay) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setCommandOverlay((current) => ({
          ...current,
          selected: (current.selected - 1 + current.items.length) % current.items.length,
        }));
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down") {
        setCommandOverlay((current) => ({
          ...current,
          selected: (current.selected + 1) % current.items.length,
        }));
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "tab") {
        completeInputOverlaySelection();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        acceptInputOverlaySelection();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "escape") {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (event.name === "pageup") {
      scrollRef.current?.scrollBy(-(scrollRef.current.height / 2));
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "pagedown") {
      scrollRef.current?.scrollBy(scrollRef.current.height / 2);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "c" && event.ctrl) {
      event.preventDefault();
      event.stopPropagation();

      if (commandPicker) {
        setCommandPicker(null);
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      if (checkboxPicker) {
        setCheckboxPicker(null);
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      if (commandOverlay.visible) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      const now = Date.now();
      if (now - lastCtrlCRef.current < CTRL_C_EXIT_WINDOW_MS) {
        if (processingRef.current) {
          const decision = session.requestTurnInterrupt
            ? session.requestTurnInterrupt()
            : (session.cancelCurrentTurn?.(), { accepted: true as const });
          if (decision.accepted) {
            abortControllerRef.current?.abort();
          }
        }
        beginClosing();
        return;
      }

      lastCtrlCRef.current = now;

      if (processingRef.current) {
        const decision = session.requestTurnInterrupt
          ? session.requestTurnInterrupt()
          : (session.cancelCurrentTurn?.(), { accepted: true as const });
        if (decision.accepted) {
          abortControllerRef.current?.abort();
          // Do NOT set processing=false here — let runTurn's finally block
          // handle it after the turn actually finishes. This prevents a new
          // turn from starting before the old one unwinds.
          setPhase("cancelling");
        } else {
          showHint(
            decision.reason === "compact_in_progress"
              ? "Interrupt is disabled during compact phase"
              : "Interrupt is currently disabled.",
          );
        }
        return;
      }

      if (lastInputValueRef.current.trim()) {
        clearInput();
        return;
      }

      showHint("Press Ctrl+C again to exit");
      return;
    }

    if (event.name === "g" && event.ctrl) {
      setMarkdownMode((current) => {
        const next = current === "rendered" ? "raw" : "rendered";
        showHint(next === "raw" ? "Markdown raw: ON" : "Markdown raw: OFF");
        return next;
      });
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!composer || pendingAsk) return;

    if (isDeleteToVisualLineStartShortcut(event)) {
      deleteToVisualLineStart();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "up" && isAtFirstVisualLine()) {
      composer.gotoVisualLineHome();
      syncComposerState();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "up") {
      moveComposerVertically("up");
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "down" && isAtLastVisualLine()) {
      composer.gotoVisualLineEnd();
      syncComposerState();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "down") {
      moveComposerVertically("down");
      event.preventDefault();
      event.stopPropagation();
      return;
    }

  });

  const lastAssistantIndex = [...entries]
    .map((entry, index) => ({ entry, index }))
    .reverse()
    .find((item) => item.entry.kind === "assistant")?.index ?? -1;

  const modelDescriptor = getCurrentModelDescriptor(session);
  const modelName = modelDescriptor?.compactScopedLabel ?? "unknown";
  const modelNameColor = resolveModelNameColor(modelDescriptor, colors);
  const sidebarVisible = terminal.width >= MIN_TERMINAL_WIDTH_FOR_SIDEBAR;
  const sidebarWidth = sidebarVisible ? getSidebarWidth(terminal.width) : 0;
  // Picker content width: terminal - outer padding(4) - row gap+sidebar border(2) - sidebar - picker border(2) - picker padding(2)
  const pickerContentWidth = terminal.width - 10 - (sidebarVisible ? sidebarWidth : 0);
  const showLogoInScroll = terminal.height >= MIN_TERMINAL_HEIGHT_FOR_LOGO_HEADER
    && terminal.width >= MIN_TERMINAL_WIDTH_FOR_LOGO_HEADER;

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={colors.background}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      onMouseDown={() => {
        if (commandOverlay.visible) setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        if (commandPicker) setCommandPicker(null);
        if (checkboxPicker) setCheckboxPicker(null);
      }}
    >
      <box flexDirection="row" flexGrow={1} gap={1}>
        <box flexDirection="column" flexGrow={1} gap={1}>
          <scrollbox
            ref={scrollRef}
            flexGrow={1}
            flexShrink={1}
            stickyScroll={true}
            stickyStart="bottom"
            viewportOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{
              paddingLeft: 1,
              trackOptions: {
                backgroundColor: "transparent",
                foregroundColor: colors.border + "44",
              },
            }}
          >
            <box flexDirection="column" gap={0}>
              {showLogoInScroll ? <LogoBlock colors={colors} /> : null}
              {entries.map((entry, index) => {
                const prev = index > 0 ? entries[index - 1] : null;
                const needsSpacing = entry.kind === "reasoning" && (
                  prev?.kind === "progress" ||
                  prev?.kind === "tool_call" ||
                  prev?.kind === "sub_agent_rollup"
                );

                return (
                  <ConversationEntryView
                    key={conversationEntryKey(entry, index)}
                    entry={entry}
                    streaming={processing && index === lastAssistantIndex}
                    markdownMode={markdownMode}
                    colors={colors}
                    markdownStyle={markdownStyle}
                    needsSpacing={needsSpacing}
                  />
                );
              })}
            </box>
          </scrollbox>

          {pendingAsk ? (
            <AskPanelView
              ask={pendingAsk}
              error={askError}
              selectedIndex={askSelectionIndex}
              currentQuestionIndex={currentQuestionIndex}
              totalQuestions={pendingAsk.kind === "agent_question" ? getAskQuestions().length : 1}
              questionAnswers={questionAnswers}
              customInputMode={customInputMode}
              noteInputMode={noteInputMode}
              reviewMode={reviewMode}
              inlineValue={askInputValue}
              optionNotes={optionNotes}
              inputRef={askInputRef}
              onInput={setAskInputValue}
              onSubmit={submitAskInlineInput}
              colors={colors}
            />
          ) : null}
          <CommandOverlayView
            overlay={commandOverlay}
            colors={colors}
            contentWidth={pickerContentWidth}
            maxVisible={pickerMaxVisible}
            onItemClick={clickOverlayItem}
          />
          <CommandPickerView
            picker={commandPicker}
            colors={colors}
            contentWidth={pickerContentWidth}
            maxVisible={pickerMaxVisible}
            onItemClick={clickCommandPickerItem}
          />
          <CheckboxPickerView
            picker={checkboxPicker}
            colors={colors}
            contentWidth={pickerContentWidth}
            onItemClick={clickCheckboxPickerItem}
          />
          <PromptSelectView
            prompt={promptSelect}
            colors={colors}
            contentWidth={pickerContentWidth}
            maxVisible={pickerMaxVisible}
            onItemClick={clickPromptSelectItem}
          />
          <PromptSecretView
            prompt={promptSecret}
            inputRef={promptSecretInputRef}
            focused={Boolean(promptSecret)}
            onSubmit={submitPromptSecret}
            colors={colors}
          />
        </box>

        {sidebarVisible ? (
          <SidebarView
            width={sidebarWidth}
            contextTokens={contextTokens}
            contextLimit={session.primaryAgent.modelConfig?.contextLength}
            cacheReadTokens={cacheReadTokens}
            checkpoints={planCheckpoints}
            colors={colors}
          />
        ) : null}
      </box>

      <box flexDirection="column" gap={0} flexShrink={0}>
        <box
          flexDirection="column"
          height={inputVisibleLines + 2}
          flexShrink={0}
        >
          <text
            fg={colors.separator}
            content={"─".repeat(Math.max(8, terminal.width - 5))}
          />
          <box flexDirection="row" width="100%">
            <text fg={colors.accent} bold content="❯ " flexShrink={0} />
            <textarea
              ref={(node) => {
                inputRef.current = node;
              }}
              placeholder={pendingAsk ? "ask pending..." : "message or /command"}
              focused={phase !== "closing" && !pendingAsk && !commandPicker && !checkboxPicker && !promptSelect && !promptSecret}
              textColor={colors.text}
              focusedTextColor={colors.text}
              placeholderColor={colors.muted}
              cursorStyle={{ style: "block", blinking: false }}
              cursorColor={colors.accent}
              paddingRight={1}
              width="100%"
              height={inputVisibleLines}
              maxHeight={INPUT_MAX_VISIBLE_LINES}
              minHeight={1}
              syntaxStyle={composerTokenVisuals.syntaxStyle}
              keyBindings={COMPOSER_KEY_BINDINGS}
              onSubmit={() => {
                void handleSubmit(getSerializedComposerInput());
              }}
              wrapMode="word"
              scrollMargin={0}
            />
          </box>
          <text
            fg={colors.separator}
            content={"─".repeat(Math.max(8, terminal.width - 5))}
          />
        </box>
        <box flexShrink={0} flexDirection="column">
          <StatusStrip
            modelName={modelName}
            modelColor={modelNameColor}
            phase={phase}
            contextTokens={contextTokens}
            contextLimit={session.primaryAgent.modelConfig?.contextLength}
            hint={hint}
            showContext={!sidebarVisible}
            colors={colors}
            onModelClick={() => void handleSubmit("/model")}
          />
          <box paddingLeft={1}>
            <text fg={colors.muted} content={shortenPath(process.cwd())} wrapMode="truncate" />
          </box>
        </box>
      </box>

    </box>
  );
}
