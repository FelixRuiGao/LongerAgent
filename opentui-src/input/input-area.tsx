/** @jsxImportSource @opentui/react */

import React from "react";

import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import type { ConversationPalette } from "../components/conversation-types.js";
import type { ComposerTokenVisuals } from "../composer-tokens.js";
import type { ActivityPhase } from "../display/types.js";
import { formatCompactTokensShort } from "../display/utils/format.js";
import { formatElapsed } from "../presentation/use-turn-timer.js";
import {
  useSpinner,
  DECODING_SPINNER_FRAMES,
  DECODING_SPINNER_INTERVAL,
  PREFILL_SPINNER_FRAMES,
  PREFILL_SPINNER_INTERVAL,
  AWAITING_SPINNER_FRAMES,
  AWAITING_SPINNER_INTERVAL,
} from "../presentation/use-spinner.js";

interface InputAreaProps {
  inputRef: React.RefObject<TextareaRenderable | null>;
  processing: boolean;
  pendingAsk: boolean;
  selectedChildId: string | null;
  phase: ActivityPhase;
  modelName: string;
  modelColor: string;
  elapsed: number;
  cwd: string;
  hint: string | null;
  contextTokens: number;
  contextLimit: number | undefined;
  cacheReadTokens: number;
  /** Width of the content column (terminal width minus screen padding). */
  contentWidth: number;
  colors: ConversationPalette;
  inputVisibleLines: number;
  maxInputLines: number;
  composerTokenVisuals: ComposerTokenVisuals;
  keyBindings: readonly KeyBinding[];
  onSubmit: () => void;
  onModelClick: () => void;
  onAgentIndicatorClick?: () => void;
  commandPicker: boolean;
  checkboxPicker: boolean;
  promptSelect: boolean;
  promptSecret: boolean;
  /** Number of running child agents. */
  runningAgentCount?: number;
  /** Number of idle child agents. */
  idleAgentCount?: number;
  /** Number of archived child agents. */
  archivedAgentCount?: number;
}

function getPhaseLabel(phase: ActivityPhase): string {
  switch (phase) {
    case "decoding": return "Decoding";
    case "waiting": return "Waiting";
    case "asking": return "Asking";
    case "prefilling":
    default: return "Prefilling";
  }
}

function getPhaseSpinnerConfig(phase: ActivityPhase): { frames: readonly string[]; interval: number } {
  switch (phase) {
    case "decoding": return { frames: DECODING_SPINNER_FRAMES, interval: DECODING_SPINNER_INTERVAL };
    case "waiting": return { frames: AWAITING_SPINNER_FRAMES, interval: AWAITING_SPINNER_INTERVAL };
    case "asking": return { frames: AWAITING_SPINNER_FRAMES, interval: AWAITING_SPINNER_INTERVAL };
    case "prefilling":
    default: return { frames: PREFILL_SPINNER_FRAMES, interval: PREFILL_SPINNER_INTERVAL };
  }
}

function getPhaseColor(phase: ActivityPhase, colors: ConversationPalette): string {
  switch (phase) {
    case "decoding": return colors.generatingStatus;
    case "waiting": return colors.waitingStatus;
    case "asking": return colors.waitingStatus;
    case "prefilling":
    default: return colors.dim;
  }
}

function InputAreaInner(props: InputAreaProps): React.ReactElement {
  const {
    inputRef,
    processing,
    pendingAsk,
    selectedChildId,
    phase,
    modelName,
    modelColor,
    elapsed,
    cwd,
    hint,
    contextTokens,
    contextLimit,
    cacheReadTokens,
    contentWidth,
    colors,
    inputVisibleLines,
    maxInputLines,
    composerTokenVisuals,
    keyBindings,
    onSubmit,
    onModelClick,
    commandPicker,
    checkboxPicker,
    promptSelect,
    promptSecret,
    runningAgentCount = 0,
    idleAgentCount = 0,
    archivedAgentCount = 0,
    onAgentIndicatorClick,
  } = props;

  const placeholder = pendingAsk
    ? "ask pending..."
    : selectedChildId
      ? "Esc/^C close or interrupt · Opt+←→ switch tabs · Opt+↑ main"
      : "message or /command";

  const focused = phase !== "closing" && !pendingAsk && !commandPicker && !checkboxPicker && !promptSelect && !promptSecret && !selectedChildId;

  const spinnerConfig = getPhaseSpinnerConfig(phase);
  const activeSpinner = useSpinner(spinnerConfig.frames, spinnerConfig.interval, processing);
  const phaseLabel = getPhaseLabel(phase);
  const phaseColor = getPhaseColor(phase, colors);

  const cacheLabel = cacheReadTokens > 0 ? ` (${formatCompactTokensShort(cacheReadTokens)} cached)` : "";
  const contextText = contextLimit
    ? `${formatCompactTokensShort(contextTokens)}/${formatCompactTokensShort(contextLimit)}${cacheLabel}`
    : `${formatCompactTokensShort(contextTokens)}${cacheLabel}`;

  return (
    <box flexDirection="column" gap={0} flexShrink={0}>
      {/* Top row: activity indicator (left) + agent indicator (center) + model name (right) */}
      <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
        {processing ? (
          <box flexDirection="row" flexShrink={0}>
            <text fg={phaseColor} content={`${activeSpinner} ${phaseLabel}`} />
            {elapsed > 0 ? (
              <text fg={colors.dim} content={` ${formatElapsed(elapsed)}`} />
            ) : null}
          </box>
        ) : null}

        {/* Agent indicator: only show running count */}
        {runningAgentCount > 0 && !selectedChildId ? (
          <box
            flexDirection="row"
            flexShrink={0}
            paddingLeft={processing ? 2 : 0}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onAgentIndicatorClick?.(); }}
          >
            <text fg={colors.workingStatus} content={`${runningAgentCount} agent${runningAgentCount > 1 ? "s" : ""} running`} />
          </box>
        ) : null}

        <box flexGrow={1} />
        <box
          onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onModelClick(); }}
        >
          <text fg={modelColor} content={modelName} />
        </box>
      </box>

      {/* Input box with round border */}
      <box
        flexDirection="row"
        width="100%"
        height={inputVisibleLines + 2}
        flexShrink={0}
        border={true}
        borderStyle="rounded"
        borderColor={colors.dim}
      >
        <text fg={colors.accent} bold content="❯ " flexShrink={0} />
        <textarea
          ref={(node: any) => {
            (inputRef as any).current = node;
          }}
          placeholder={placeholder}
          focused={focused}
          textColor={selectedChildId ? colors.muted : colors.text}
          focusedTextColor={selectedChildId ? colors.muted : colors.text}
          placeholderColor={colors.muted}
          cursorStyle={{ style: "block", blinking: false }}
          cursorColor={colors.accent}
          width={Math.max(10, contentWidth - 2 - 2 - 1)}
          height={inputVisibleLines}
          maxHeight={maxInputLines}
          minHeight={1}
          syntaxStyle={composerTokenVisuals.syntaxStyle}
          keyBindings={keyBindings}
          onSubmit={onSubmit}
          wrapMode="word"
          scrollMargin={0}
        />
      </box>

      {/* Bottom row: cwd (left) + hint (middle) + context (right) */}
      <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
        <text fg={colors.muted} content={cwd} flexShrink={0} />
        {hint ? (
          <text fg={colors.dim} content={`  ${hint}`} wrapMode="truncate" flexGrow={1} flexShrink={1} />
        ) : (
          <box flexGrow={1} />
        )}
        <text fg={colors.dim} content={`  ${contextText}`} flexShrink={0} />
      </box>
    </box>
  );
}

export const InputArea = React.memo(InputAreaInner);
