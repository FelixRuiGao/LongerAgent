/** @jsxImportSource @opentui/react */

import React from "react";

import type { ConversationPalette } from "../components/conversation-types.js";
import { formatElapsed } from "../presentation/use-turn-timer.js";

interface InputAreaProps {
  inputRef: React.RefObject<any>;
  processing: boolean;
  pendingAsk: boolean;
  selectedChildId: string | null;
  phase: string;
  modelName: string;
  modelColor: string;
  elapsed: number;
  cwd: string;
  hint: string | null;
  contextTokens: number;
  contextLimit: number | undefined;
  showContext: boolean;
  terminalWidth: number;
  colors: ConversationPalette;
  inputVisibleLines: number;
  maxInputLines: number;
  composerTokenVisuals: { syntaxStyle: any };
  keyBindings: any;
  onSubmit: () => void;
  onModelClick: () => void;
  commandPicker: boolean;
  checkboxPicker: boolean;
  promptSelect: boolean;
  promptSecret: boolean;
}

function formatCompactTokens(value: number | undefined): string {
  if (value == null || value === 0) return "0";
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
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
    showContext,
    terminalWidth,
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

  const separatorLine = "─".repeat(Math.max(8, terminalWidth - 5));

  return (
    <box flexDirection="column" gap={0} flexShrink={0}>
      <box
        flexDirection="column"
        height={inputVisibleLines + 2}
        flexShrink={0}
      >
        <text fg={colors.dim} content={separatorLine} />
        <box flexDirection="row" width="100%">
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
            paddingRight={1}
            width="100%"
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
        <text fg={colors.dim} content={separatorLine} />
      </box>

      <box paddingLeft={1} paddingRight={1} flexDirection="column" gap={0} width="100%">
        <box flexDirection="row">
          <box
            hoverStyle={{ backgroundColor: colors.border }}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onModelClick(); }}
          >
            <text fg={modelColor} content={modelName} />
          </box>
          {processing && elapsed > 0 ? (
            <>
              <text fg={colors.dim} content=" │ " />
              <text fg={colors.dim} content={formatElapsed(elapsed)} />
            </>
          ) : null}
          {showContext ? (
            <>
              <text fg={colors.dim} content=" │ " />
              <text fg={colors.dim} content={`${formatCompactTokens(contextTokens)}/${formatCompactTokens(contextLimit)}`} />
            </>
          ) : null}
        </box>
        {hint ? <text fg={colors.dim} content={hint} /> : null}
        <box flexDirection="row">
          <text fg={colors.muted} content={cwd} wrapMode="truncate" flexGrow={1} flexShrink={1} />
        </box>
      </box>
    </box>
  );
}

export const InputArea = React.memo(InputAreaInner);
