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
  TOOL_SPINNER_FRAMES,
  TOOL_SPINNER_INTERVAL,
  THINKING_SPINNER_FRAMES,
  THINKING_SPINNER_INTERVAL,
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
  /** Width of the content column (terminal width minus screen padding). */
  contentWidth: number;
  colors: ConversationPalette;
  inputVisibleLines: number;
  maxInputLines: number;
  composerTokenVisuals: ComposerTokenVisuals;
  keyBindings: readonly KeyBinding[];
  onSubmit: () => void;
  onModelClick: () => void;
  commandPicker: boolean;
  checkboxPicker: boolean;
  promptSelect: boolean;
  promptSecret: boolean;
}

function getPhaseLabel(phase: ActivityPhase): string {
  switch (phase) {
    case "thinking": return "Reasoning";
    case "generating": return "Decoding";
    case "working": return "Executing";
    case "waiting": return "Awaiting";
    case "prefilling":
    default: return "Prefilling";
  }
}

function getPhaseSpinnerConfig(phase: ActivityPhase): { frames: readonly string[]; interval: number } {
  switch (phase) {
    case "thinking": return { frames: THINKING_SPINNER_FRAMES, interval: THINKING_SPINNER_INTERVAL };
    case "generating": return { frames: DECODING_SPINNER_FRAMES, interval: DECODING_SPINNER_INTERVAL };
    case "working": return { frames: TOOL_SPINNER_FRAMES, interval: TOOL_SPINNER_INTERVAL };
    case "waiting": return { frames: AWAITING_SPINNER_FRAMES, interval: AWAITING_SPINNER_INTERVAL };
    case "prefilling":
    default: return { frames: PREFILL_SPINNER_FRAMES, interval: PREFILL_SPINNER_INTERVAL };
  }
}

function getPhaseColor(phase: ActivityPhase, colors: ConversationPalette): string {
  switch (phase) {
    case "thinking": return colors.thinkingStatus;
    case "generating": return colors.generatingStatus;
    case "working": return colors.workingStatus;
    case "waiting": return colors.waitingStatus;
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
  } = props;

  const placeholder = pendingAsk
    ? "ask pending..."
    : selectedChildId
      ? "Esc to return to primary session"
      : "message or /command";

  const focused = phase !== "closing" && !pendingAsk && !commandPicker && !checkboxPicker && !promptSelect && !promptSecret && !selectedChildId;

  const spinnerConfig = getPhaseSpinnerConfig(phase);
  const activeSpinner = useSpinner(spinnerConfig.frames, spinnerConfig.interval, processing);
  const phaseLabel = getPhaseLabel(phase);
  const phaseColor = getPhaseColor(phase, colors);

  const contextText = contextLimit
    ? `${formatCompactTokensShort(contextTokens)}/${formatCompactTokensShort(contextLimit)}`
    : formatCompactTokensShort(contextTokens);

  return (
    <box flexDirection="column" gap={0} flexShrink={0}>
      {/* Top row: activity indicator (left) + model name (right) */}
      <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
        {processing ? (
          <box flexDirection="row" flexGrow={1}>
            <text fg={phaseColor} content={`${activeSpinner} ${phaseLabel}`} />
            {elapsed > 0 ? (
              <text fg={colors.dim} content={` ${formatElapsed(elapsed)}`} />
            ) : null}
          </box>
        ) : (
          <box flexGrow={1} />
        )}
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

      {/* Bottom row: cwd (left) + context (right) */}
      <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
        <text fg={colors.muted} content={cwd} wrapMode="truncate" flexGrow={1} flexShrink={1} />
        {hint ? (
          <>
            <text fg={colors.dim} content="  " flexShrink={0} />
            <text fg={colors.dim} content={hint} flexShrink={0} />
          </>
        ) : null}
        <text fg={colors.dim} content={`  ${contextText}`} flexShrink={0} />
      </box>
    </box>
  );
}

export const InputArea = React.memo(InputAreaInner);
