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
  type CommandPickerState,
} from "../src/tui/command-picker.js";
import {
  createCheckboxPicker,
  getCheckboxPickerVisibleRange,
  isCheckboxPickerActive,
  moveCheckboxSelection,
  submitCheckboxPicker,
  toggleCheckboxItem,
  type CheckboxPickerState,
} from "../src/tui/checkbox-picker.js";
import {
  RGBA,
  SyntaxStyle,
  type TerminalColors,
  type InputRenderable,
  type KeyBinding,
  type ScrollBoxRenderable,
  type TextareaRenderable,
  getTreeSitterClient,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import "./forked/patch-opentui-markdown.js";

type ActivityPhase =
  | "idle"
  | "working"
  | "thinking"
  | "generating"
  | "waiting"
  | "error";

export interface OpenTuiAppProps {
  session: TuiSession;
  commandRegistry: CommandRegistry;
  store: SessionStore | null;
  verbose?: boolean;
  onExit: () => Promise<void> | void;
}

const COLORS = {
  background: "transparent",
  panel: "transparent",
  border: "#4b5567",
  accent: "#55a2ff",
  dim: "#97a2b5",
  text: "#ecf2ff",
  yellow: "#f4c95d",
  red: "#ff6b6b",
  green: "#65d08f",
  cyan: "#72d6ff",
} as const;

type OpenTuiPalette = typeof COLORS;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const TERMINAL_PALETTE_REFRESH_MS = 30_000;
const INPUT_MAX_VISIBLE_LINES = 10;
const COMMAND_PICKER_MAX_VISIBLE = 10;
const CHECKBOX_PICKER_MAX_VISIBLE = 15;
const PROMPT_SELECT_MAX_VISIBLE = 10;
const SIDEBAR_WIDTH = 34;
const MIN_TERMINAL_WIDTH_FOR_SIDEBAR = 120;
const MIN_TERMINAL_WIDTH_FOR_LOGO_HEADER = 72;
const MIN_TERMINAL_HEIGHT_FOR_LOGO_HEADER = 28;
const APP_VERSION = "v0.1.3";
const CUSTOM_EMPTY_HINT =
  'Custom answer is empty. Please enter an answer first, or choose "Discuss further" instead.';

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
  visible: boolean;
  items: string[];
  values: string[];
  selected: number;
}

interface OpenTuiTheme {
  colors: OpenTuiPalette;
  markdownStyle: SyntaxStyle;
  defaultForeground: string | null;
  defaultBackground: string | null;
}

function normalizeHexColor(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const normalized = hex.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : null;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return null;
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixHexColors(foreground: string, background: string, towardBackground: number): string | null {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  if (!fg || !bg) return null;
  const weight = Math.max(0, Math.min(1, towardBackground));
  return rgbToHex(
    fg[0] * (1 - weight) + bg[0] * weight,
    fg[1] * (1 - weight) + bg[1] * weight,
    fg[2] * (1 - weight) + bg[2] * weight,
  );
}

function buildMarkdownStyle(colors: OpenTuiPalette): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(colors.text) },
    conceal: { fg: RGBA.fromHex(colors.dim) },
    "markup.heading": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.3": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.4": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.5": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.heading.6": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.strong": { fg: RGBA.fromHex(colors.text), bold: true },
    "markup.italic": { fg: RGBA.fromHex(colors.text), italic: true },
    "markup.raw": { fg: RGBA.fromHex(colors.yellow) },
    "markup.raw.block": { fg: RGBA.fromHex(colors.yellow) },
    "markup.link": { fg: RGBA.fromHex(colors.cyan) },
    "markup.link.label": { fg: RGBA.fromHex(colors.text), underline: true },
    "markup.link.url": { fg: RGBA.fromHex(colors.cyan), underline: true },
    "markup.quote": { fg: RGBA.fromHex(colors.dim), italic: true },
    "markup.list": { fg: RGBA.fromHex(colors.text) },
  });
}

function buildTheme(defaultForeground: string | null, defaultBackground: string | null): OpenTuiTheme {
  const text = normalizeHexColor(defaultForeground) ?? COLORS.text;
  const background = normalizeHexColor(defaultBackground) ?? "#000000";
  const dim = mixHexColors(text, background, 0.35) ?? COLORS.dim;
  const border = mixHexColors(text, background, 0.62) ?? COLORS.border;
  const colors: OpenTuiPalette = {
    ...COLORS,
    text,
    dim,
    border,
  };

  return {
    colors,
    markdownStyle: buildMarkdownStyle(colors),
    defaultForeground: normalizeHexColor(defaultForeground),
    defaultBackground: normalizeHexColor(defaultBackground),
  };
}

function paletteSnapshot(palette: TerminalColors): { defaultForeground: string | null; defaultBackground: string | null } {
  return {
    defaultForeground: normalizeHexColor(palette.defaultForeground),
    defaultBackground: normalizeHexColor(palette.defaultBackground),
  };
}

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

function formatTokens(value: number | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

function formatContext(contextTokens: number, contextLimit?: number, cacheReadTokens?: number): string {
  if (contextLimit && contextLimit > 0) {
    const pct = ((contextTokens / contextLimit) * 100).toFixed(1);
    const cache = cacheReadTokens ? ` (${formatTokens(cacheReadTokens)} cached)` : "";
    return `${pct}%  ${formatTokens(contextTokens)} / ${formatTokens(contextLimit)}${cache}`;
  }
  return formatTokens(contextTokens);
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

function getUsageBarSegments(ratio: number, width: number): { filled: string; partial: string; empty: string } {
  const safeRatio = Math.max(0, Math.min(1, ratio));
  const filledCells = Math.round(safeRatio * width);
  const filled = "▰".repeat(Math.max(0, Math.min(width, filledCells)));
  const empty = "▱".repeat(Math.max(0, width - filled.length));
  return { filled, partial: "", empty };
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
            content={`  ${
              checkpoint.checked
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

function HeaderView(
  {
    colors,
    directory,
    useCompact,
  }: {
    colors: OpenTuiPalette;
    directory: string;
    useCompact: boolean;
  },
): React.ReactElement {
  if (useCompact) {
    return (
      <box
        border
        borderStyle="rounded"
        borderColor={colors.border}
        title=" LONGERAGENT "
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
        width="100%"
        flexShrink={0}
      >
        <text fg={colors.dim} content={`Version:   ${APP_VERSION}`} />
        <text fg={colors.dim} content={`Directory: ${directory}`} wrapMode="truncate" />
      </box>
    );
  }

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={colors.border}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      width="100%"
      flexShrink={0}
    >
      <text fg={colors.accent} content="╦  ╔═╗╔╗╔╔═╗╔═╗╦═╗  ╔═╗╔═╗╔═╗╔╗╔╔╦╗" />
      <text fg={colors.accent} content="║  ║ ║║║║║ ╦║╣ ╠╦╝  ╠═╣║ ╦║╣ ║║║ ║ " />
      <text fg={colors.accent} content="╩═╝╚═╝╝╚╝╚═╝╚═╝╩╚═  ╩ ╩╚═╝╚═╝╝╚╝ ╩ " />
      <text fg={colors.dim} content={`Version:   ${APP_VERSION}`} />
      <text fg={colors.dim} content={`Directory: ${directory}`} wrapMode="truncate" />
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

function ConversationEntryView(
  {
    entry,
    streaming,
    colors,
    markdownStyle,
    needsSpacing,
  }: {
    entry: ConversationEntry;
    streaming: boolean;
    colors: OpenTuiPalette;
    markdownStyle: SyntaxStyle;
    needsSpacing?: boolean;
  },
): React.ReactElement {
  switch (entry.kind) {
    case "user":
      return (
        <box flexDirection="row" paddingTop={1}>
          <text fg={colors.accent} content="> " />
          <text fg={colors.text} content={entry.text} />
          {entry.queued ? <text fg={colors.yellow} content=" (Queued)" /> : null}
        </box>
      );
    case "assistant":
      return (
        <box paddingLeft={1}>
          <markdown
            content={entry.text}
            syntaxStyle={markdownStyle}
            treeSitterClient={MARKDOWN_TREE_SITTER_CLIENT}
            streaming={streaming}
            conceal={true}
            concealCode={false}
            width="100%"
            tableOptions={{
              borders: false,
              outerBorder: false,
              wrapMode: "word",
              selectable: true,
            }}
          />
        </box>
      );
    case "reasoning":
      return (
        <box paddingLeft={needsSpacing ? 1 : 0} paddingTop={needsSpacing ? 1 : 0}>
          <text fg={colors.dim} content={entry.text} />
        </box>
      );
    case "tool_call":
      {
        const trimmed = entry.text.trim();
        const firstSpace = trimmed.indexOf(" ");
        const parsedToolName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
        const toolName = typeof entry.meta?.toolName === "string" ? entry.meta.toolName : parsedToolName;
        const restSource = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
        const rest = restSource.replace(/\s+/g, " ").trim();
        const timeDisplay = entry.elapsedMs !== undefined ? formatElapsed(entry.elapsedMs) : null;
        return (
          <box flexDirection="row" width="100%">
            <text fg={colors.cyan} content={`- ${toolName}`} flexShrink={0} />
            {timeDisplay ? <text fg={colors.dim} content={` (${timeDisplay}) `} flexShrink={0} /> : null}
            {rest ? (
              <text
                fg={colors.dim}
                content={rest}
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
        <box flexDirection="column" paddingLeft={2}>
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
        <box>
          <text fg={colors.dim} content={entry.text} />
        </box>
      );
    case "status":
    case "compact_mark":
      return (
        <box paddingTop={1}>
          <text fg={colors.yellow} content={entry.text} />
        </box>
      );
    case "error":
      return (
        <box paddingTop={1}>
          <text fg={colors.red} content={`[x] Error: ${entry.text}`} />
        </box>
      );
    case "sub_agent_rollup":
      return (
        <box flexDirection="column">
          <text fg={colors.dim} content={entry.text} />
        </box>
      );
    case "sub_agent_done":
      return (
        <box>
          <text fg={colors.dim} content="- " />
          <text fg={colors.dim} content={entry.text} />
        </box>
      );
    case "interrupted_marker":
      return (
        <box paddingLeft={1}>
          <text fg={colors.yellow} content={entry.text} />
        </box>
      );
    default:
      return <box />;
  }
}

function StatusStrip(
  {
    modelName,
    phase,
    contextTokens,
    contextLimit,
    cacheReadTokens,
    hint,
    showContext,
    colors,
  }: {
    modelName: string;
    phase: ActivityPhase;
    contextTokens: number;
    contextLimit?: number;
    cacheReadTokens?: number;
    hint?: string | null;
    showContext: boolean;
    colors: OpenTuiPalette;
  },
): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (phase === "idle" || phase === "error") return;
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [phase]);

  const indicator = phase === "idle" ? "●" : phase === "error" ? "●" : SPINNER_FRAMES[frame]!;
  const color = phase === "error" ? colors.red : phase === "waiting" ? colors.yellow : colors.accent;
  const label = phase === "idle"
    ? "READY"
    : phase === "error"
    ? "ERROR"
    : phase.toUpperCase();
  const contextSummary = showContext ? `  |  Context ${formatContext(contextTokens, contextLimit, cacheReadTokens)}` : "";

  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="column" gap={0} width="100%">
      <box flexDirection="column">
        <box>
          <text
            fg={color}
            content={`${indicator} ${label}  |  ${modelName}${contextSummary}`}
          />
        </box>
        {hint ? <text fg={colors.dim} content={hint} /> : null}
      </box>
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
  const usageRatio = contextLimit && contextLimit > 0 ? contextTokens / contextLimit : 0;
  const bar = getUsageBarSegments(usageRatio, 16);
  const limitText = contextLimit ? formatCompactTokens(contextLimit) : "0";

  return (
    <box
      flexDirection="column"
      width="100%"
      gap={0}
    >
      <text fg={colors.text} bold content="Context" />
      <text content=" " />
      <box flexDirection="row" gap={1}>
        <text fg={colors.accent} content={percentText} />
        <box flexDirection="row">
          {bar.filled ? <text fg={colors.accent} content={bar.filled} /> : null}
          {bar.empty ? <text fg={colors.dim} content={bar.empty} /> : null}
        </box>
      </box>
      <box flexDirection="row">
        <text fg={colors.text} content={formatCompactTokens(contextTokens)} />
        <text fg={colors.dim} content={` / ${limitText} Tokens`} />
      </box>
      <text fg={colors.green} content={`╰─ ⚡ ${formatCompactTokens(cacheReadTokens)} Cached`} />
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

function SidebarView(
  {
    contextTokens,
    contextLimit,
    cacheReadTokens,
    checkpoints,
    colors,
  }: {
    contextTokens: number;
    contextLimit?: number;
    cacheReadTokens?: number;
    checkpoints: PlanCheckpointUi[] | null;
    colors: OpenTuiPalette;
  },
): React.ReactElement {
  const safeCheckpoints = checkpoints ?? [];

  return (
    <box width={SIDEBAR_WIDTH} minWidth={SIDEBAR_WIDTH} maxWidth={SIDEBAR_WIDTH} flexDirection="column">
      <scrollbox
        flexGrow={1}
        viewportOptions={{ paddingRight: 1 }}
        verticalScrollbarOptions={{
          visible: true,
          paddingLeft: 1,
          trackOptions: {
            backgroundColor: colors.background,
            foregroundColor: colors.border,
          },
        }}
      >
        <box flexDirection="column" gap={1} width="100%" paddingLeft={2}>
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

function CommandOverlayView(
  { overlay, colors }: { overlay: CommandOverlayState; colors: OpenTuiPalette },
): React.ReactElement | null {
  if (!overlay.visible || overlay.items.length === 0) return null;

  return (
    <box
      border
      borderColor={colors.accent}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      height={overlay.items.length + 2}
    >
      {overlay.items.map((item, index) => (
        <text
          key={`overlay-${index}`}
          fg={index === overlay.selected ? colors.accent : colors.dim}
          content={`${index === overlay.selected ? "> " : "  "}${item}`}
        />
      ))}
    </box>
  );
}

function CommandPickerView(
  { picker, colors }: { picker: CommandPickerState | null; colors: OpenTuiPalette },
): React.ReactElement | null {
  if (!isCommandPickerActive(picker)) return null;

  const level = getCommandPickerLevel(picker);
  const path = getCommandPickerPath(picker);
  const { start, end } = getCommandPickerVisibleRange(picker);
  const visibleOptions = level.options.slice(start, end);
  const pickerHeight = 1 + path.length + visibleOptions.length + 2;

  return (
    <box
      border
      borderColor={colors.accent}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      height={pickerHeight}
    >
      <text fg={colors.accent} content={picker.commandName} />
      {path.length > 0 ? (
        <text fg={colors.dim} content={`  ${path.join(" · ")}`} />
      ) : null}
      {visibleOptions.map((item, index) => {
        const actualIndex = start + index;
        return (
          <text
            key={`picker-${actualIndex}`}
            fg={actualIndex === level.selected ? colors.accent : colors.dim}
            content={`${actualIndex === level.selected ? "> " : "  "}${item.label}`}
          />
        );
      })}
    </box>
  );
}

function CheckboxPickerView(
  { picker, colors }: { picker: CheckboxPickerState | null; colors: OpenTuiPalette },
): React.ReactElement | null {
  if (!isCheckboxPickerActive(picker)) return null;

  const { start, end } = getCheckboxPickerVisibleRange(picker);
  const visibleItems = picker.items.slice(start, end);
  const pickerHeight = 1 + visibleItems.length + 1 + 2;

  return (
    <box
      border
      borderColor={colors.accent}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      height={pickerHeight}
    >
      <text fg={colors.accent} content={picker.title} />
      {visibleItems.map((item, index) => {
        const actualIndex = start + index;
        const checkbox = item.checked ? "[x]" : "[ ]";
        return (
          <text
            key={`checkbox-${actualIndex}`}
            fg={actualIndex === picker.selected ? colors.accent : colors.dim}
            content={`${actualIndex === picker.selected ? "> " : "  "}${checkbox} ${item.label}`}
          />
        );
      })}
      <text fg={colors.dim} content="Space toggle · Enter confirm · Esc cancel" />
    </box>
  );
}

function PromptSelectView(
  { prompt, colors }: { prompt: PromptSelectState | null; colors: OpenTuiPalette },
): React.ReactElement | null {
  if (!prompt || prompt.options.length === 0) return null;

  const { start, end } = getVisibleWindow(prompt.options.length, prompt.selected, PROMPT_SELECT_MAX_VISIBLE);
  const visibleOptions = prompt.options.slice(start, end);
  const selectedOption = prompt.options[clamp(prompt.selected, 0, prompt.options.length - 1)];
  const description = selectedOption?.description?.trim();
  const promptHeight = prompt.message.split("\n").length + visibleOptions.length + (description ? 1 : 0) + 2;

  return (
    <box
      border
      borderColor={colors.yellow}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      height={promptHeight}
    >
      <text fg={colors.yellow} content={prompt.message} />
      {visibleOptions.map((option, index) => {
        const actualIndex = start + index;
        return (
          <text
            key={`prompt-select-${actualIndex}`}
            fg={actualIndex === prompt.selected ? colors.accent : colors.dim}
            content={`${actualIndex === prompt.selected ? "> " : "  "}${option.label}`}
          />
        );
      })}
      {description ? <text fg={colors.dim} content={description} /> : null}
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
      borderColor={colors.yellow}
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
      <box border borderColor={colors.red} paddingLeft={1} paddingRight={1} flexDirection="column">
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
      <box border borderColor={colors.green} paddingLeft={1} paddingRight={1} flexDirection="column" height={panelHeight}>
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
      <box border borderColor={colors.red} paddingLeft={1} paddingRight={1} flexDirection="column">
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
    <box border borderColor={colors.yellow} paddingLeft={1} paddingRight={1} flexDirection="column" height={panelHeight}>
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
        content={`Use ↑/↓ to select, ←/→ to navigate questions, Enter to confirm.${
          agentOptionCount > 0 && selectedIndex < agentOptionCount ? " Tab to add note." : ""
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
  const [theme, setTheme] = useState<OpenTuiTheme>(() => buildTheme(null, null));
  const [processing, setProcessing] = useState(false);
  const [phase, setPhase] = useState<ActivityPhase>("idle");
  const [contextTokens, setContextTokens] = useState(0);
  const [cacheReadTokens, setCacheReadTokens] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
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
  const abortControllerRef = useRef<AbortController | null>(null);
  const promptSelectResolverRef = useRef<((value: string | undefined) => void) | null>(null);
  const promptSecretResolverRef = useRef<((value: string | undefined) => void) | null>(null);
  const colors = theme.colors;
  const markdownStyle = theme.markdownStyle;

  const refreshTerminalTheme = useCallback(async () => {
    if (typeof renderer.getPalette !== "function") return;

    try {
      if (typeof renderer.clearPaletteCache === "function") {
        renderer.clearPaletteCache();
      }

      const nextPalette = paletteSnapshot(await renderer.getPalette({ size: 16, timeout: 1200 }));
      setTheme((current) => {
        if (
          current.defaultForeground === nextPalette.defaultForeground &&
          current.defaultBackground === nextPalette.defaultBackground
        ) {
          return current;
        }
        return buildTheme(nextPalette.defaultForeground, nextPalette.defaultBackground);
      });
    } catch {
      // Ignore palette detection failures and keep the current fallback colors.
    }
  }, [renderer]);

  useEffect(() => {
    void refreshTerminalTheme();

    const intervalId = setInterval(() => {
      void refreshTerminalTheme();
    }, TERMINAL_PALETTE_REFRESH_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [refreshTerminalTheme]);

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
      void refreshTerminalTheme();
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
  }, [autoSave, refreshTerminalTheme, session]);

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

  const handleProgressRef = useRef<(event: ProgressEvent) => void>(() => {});
  handleProgressRef.current = (event) => {
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
    const nextValue = composer.plainText;
    const computedWidth = Math.max(1, composer.getLayoutNode().getComputedWidth());
    const measured = composer.editorView.measureForDimensions(computedWidth, INPUT_MAX_VISIBLE_LINES);
    const measuredLines = Math.max(
      composer.lineCount || 1,
      composer.virtualLineCount || 1,
      measured?.lineCount || 1,
    );
    lastInputValueRef.current = nextValue;
    setDraftValue(nextValue);
    setInputVisibleLines(Math.max(1, Math.min(INPUT_MAX_VISIBLE_LINES, measuredLines)));
  }, []);

  const setComposerText = useCallback((value: string, cursorToEnd = true) => {
    const composer = inputRef.current;
    if (!composer) return;
    composer.setText(value);
    if (cursorToEnd) {
      composer.cursorOffset = value.length;
    }
    syncComposerState();
  }, [syncComposerState]);

  const clearInput = useCallback(() => {
    lastInputValueRef.current = "";
    setDraftValue("");
    setInputVisibleLines(1);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    setCommandPicker(null);
    setCheckboxPicker(null);
    if (inputRef.current) {
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
    await onExit();
  }, [autoSave, onExit]);

  const buildCommandOptions = useCallback((cmdName: string) => {
    const command = commandRegistry.lookup(cmdName);
    if (!command?.options) return [];
    return command.options({
      session,
      store: store ?? undefined,
    });
  }, [commandRegistry, session, store]);

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
          Math.min(CHECKBOX_PICKER_MAX_VISIBLE, options.length),
        ),
      );
      return true;
    }

    setCommandPicker(
      createCommandPicker(
        cmdName,
        options,
        cmdName === "/resume" ? COMMAND_PICKER_MAX_VISIBLE : Math.min(COMMAND_PICKER_MAX_VISIBLE, options.length),
      ),
    );
    return true;
  }, [buildCommandOptions, commandRegistry]);

  const updateCommandOverlay = useCallback((value: string) => {
    if (commandPicker || checkboxPicker || promptSelect || promptSecret) return;

    if (!isCommandOverlayEligible(value)) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    const prefix = value.slice(1);
    const matches = commandRegistry.getAll().filter((command) =>
      command.name.slice(1).startsWith(prefix),
    );

    if (matches.length === 0) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    setCommandOverlay({
      visible: true,
      items: matches.map((command) => `${command.name}  ${command.description}`),
      values: matches.map((command) => command.name),
      selected: 0,
    });
  }, [checkboxPicker, commandPicker, commandRegistry, promptSecret, promptSelect]);

  useEffect(() => {
    updateCommandOverlay(draftValue);
  }, [draftValue, updateCommandOverlay]);

  useEffect(() => {
    const composer = inputRef.current;
    if (!composer) return;

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
    scheduleSync();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (followupTimeoutId) clearTimeout(followupTimeoutId);
      if (inputRef.current === composer) {
        composer.onContentChange = undefined;
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
    promptSecret,
    promptSelect,
  ]);

  useEffect(() => {
    return () => {
      promptSelectResolverRef.current?.(undefined);
      promptSecretResolverRef.current?.(undefined);
      promptSelectResolverRef.current = null;
      promptSecretResolverRef.current = null;
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
        setContextTokens(0);
        setCacheReadTokens(0);
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
    }
  }, [session, autoSave]);

  const handleSubmit = useCallback(async (submittedValue: string) => {
    const input = submittedValue.trim();
    if (!input) return;

    if (pendingAsk) {
      showHint("Ask resolution is not implemented in this prototype yet.");
      return;
    }

    if (!processing && input.startsWith("/") && !/\s/.test(input)) {
      const command = commandRegistry.lookup(input);
      if (command?.options && startCommandPicker(input)) {
        if (inputRef.current) {
          inputRef.current.setText("");
        }
        lastInputValueRef.current = "";
        setDraftValue("");
        setInputVisibleLines(1);
        return;
      }
    }

    clearInput();

    if (processing) {
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

  const acceptCommandOverlaySelection = useCallback(() => {
    const selectedCommand = commandOverlay.values[commandOverlay.selected];
    if (!selectedCommand) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    const command = commandRegistry.lookup(selectedCommand);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    if (command?.options && startCommandPicker(selectedCommand)) {
      if (inputRef.current) {
        inputRef.current.setText("");
      }
      lastInputValueRef.current = "";
      setDraftValue("");
      setInputVisibleLines(1);
      return;
    }

    void handleSubmit(selectedCommand);
  }, [clearInput, commandOverlay, commandRegistry, handleSubmit, startCommandPicker]);

  const completeCommandOverlaySelection = useCallback(() => {
    const selectedCommand = commandOverlay.values[commandOverlay.selected];
    if (!selectedCommand) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    setComposerText(`${selectedCommand} `);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
  }, [commandOverlay, setComposerText]);

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
    const shouldHandleCommandOverlay = commandOverlay.visible && isCommandOverlayEligible(liveComposerValue);
    if (commandOverlay.visible && !shouldHandleCommandOverlay) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    }

    if (shouldHandleCommandOverlay) {
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
        completeCommandOverlaySelection();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        acceptCommandOverlaySelection();
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
      if (processing) {
        const decision = session.requestTurnInterrupt
          ? session.requestTurnInterrupt()
          : (session.cancelCurrentTurn?.(), { accepted: true as const });
        if (decision.accepted) {
          abortControllerRef.current?.abort();
          setProcessing(false);
          setPhase("idle");
          showHint("Current turn interrupted.");
        } else {
          showHint("Interrupt is currently disabled.");
        }
        return;
      }

      if (lastInputValueRef.current.trim()) {
        clearInput();
        showHint("Input cleared.");
        return;
      }

      void performExit();
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

  const modelName = `${session.primaryAgent.modelConfig?.provider ?? "model"}:${session.primaryAgent.modelConfig?.model ?? "unknown"}`;
  const sidebarVisible = terminal.width >= MIN_TERMINAL_WIDTH_FOR_SIDEBAR;
  const compactHeader = terminal.height < MIN_TERMINAL_HEIGHT_FOR_LOGO_HEADER
    || terminal.width < MIN_TERMINAL_WIDTH_FOR_LOGO_HEADER;

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
    >
      <box flexDirection="row" flexGrow={1} gap={1}>
        <box flexDirection="column" flexGrow={1} gap={1}>
          <HeaderView
            colors={colors}
            directory={process.cwd()}
            useCompact={compactHeader}
          />

          <scrollbox
            ref={scrollRef}
            flexGrow={1}
            flexShrink={1}
            stickyScroll={true}
            stickyStart="bottom"
            viewportOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{
              visible: true,
              paddingLeft: 1,
              trackOptions: {
                backgroundColor: colors.panel,
                foregroundColor: colors.border,
              },
            }}
          >
            <box flexDirection="column" gap={0}>
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
          <CommandOverlayView overlay={commandOverlay} colors={colors} />
          <CommandPickerView picker={commandPicker} colors={colors} />
          <CheckboxPickerView picker={checkboxPicker} colors={colors} />
          <PromptSelectView prompt={promptSelect} colors={colors} />
          <PromptSecretView
            prompt={promptSecret}
            inputRef={promptSecretInputRef}
            focused={Boolean(promptSecret)}
            onSubmit={submitPromptSecret}
            colors={colors}
          />

          <box flexDirection="column" gap={0} flexShrink={0}>
            <box
              border
              borderStyle="rounded"
              title=" Input "
              borderColor={pendingAsk || commandPicker || checkboxPicker || promptSelect || promptSecret ? colors.border : colors.accent}
              paddingLeft={1}
              paddingRight={1}
              flexDirection="column"
              height={inputVisibleLines + 2}
              flexShrink={0}
            >
              <textarea
                ref={(node) => {
                  inputRef.current = node;
                }}
                placeholder={pendingAsk ? "Ask pending..." : "Type a message or /command"}
                focused={!pendingAsk && !commandPicker && !checkboxPicker && !promptSelect && !promptSecret}
                width="100%"
                height={inputVisibleLines}
                maxHeight={INPUT_MAX_VISIBLE_LINES}
                minHeight={1}
                keyBindings={COMPOSER_KEY_BINDINGS}
                onSubmit={() => {
                  const composer = inputRef.current;
                  if (!composer) return;
                  void handleSubmit(composer.plainText);
                }}
                wrapMode="word"
                scrollMargin={0}
              />
            </box>
            <box flexShrink={0}>
              <StatusStrip
                modelName={modelName}
                phase={phase}
                contextTokens={contextTokens}
                contextLimit={session.primaryAgent.modelConfig?.contextLength}
                cacheReadTokens={cacheReadTokens}
                hint={hint}
                showContext={!sidebarVisible}
                colors={colors}
              />
            </box>
          </box>
        </box>

        {sidebarVisible ? (
          <SidebarView
            contextTokens={contextTokens}
            contextLimit={session.primaryAgent.modelConfig?.contextLength}
            cacheReadTokens={cacheReadTokens}
            checkpoints={planCheckpoints}
            colors={colors}
          />
        ) : null}
      </box>

    </box>
  );
}
