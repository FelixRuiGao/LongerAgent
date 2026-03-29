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
  colors: ConversationPalette;
  inputVisibleLines: number;
  composerTokenVisuals: { syntaxStyle: any };
  keyBindings: any;
  onSubmit: () => void;
  onHelpClick: () => void;
  commandPicker: boolean;
  checkboxPicker: boolean;
  promptSelect: boolean;
  promptSecret: boolean;
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
    colors,
    inputVisibleLines,
    composerTokenVisuals,
    keyBindings,
    onSubmit,
    onHelpClick,
    commandPicker,
    checkboxPicker,
    promptSelect,
    promptSecret,
  } = props;

  const placeholder = pendingAsk
    ? "ask pending..."
    : selectedChildId
      ? "Esc to return to primary session"
      : processing
        ? "agent is working..."
        : "message or /command";

  const focused = phase !== "closing" && !pendingAsk && !commandPicker && !checkboxPicker && !promptSelect && !promptSecret && !selectedChildId;

  return (
    <box flexDirection="column" gap={0} flexShrink={0}>
      <box
        flexDirection="column"
        height={inputVisibleLines + 2}
        flexShrink={0}
        borderStyle="rounded"
        borderColor={colors.muted}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" width="100%">
          {!processing ? (
            <text fg={colors.accent} bold content="❯ " flexShrink={0} />
          ) : null}
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
            maxHeight={8}
            minHeight={1}
            syntaxStyle={composerTokenVisuals.syntaxStyle}
            keyBindings={keyBindings}
            onSubmit={onSubmit}
            wrapMode="word"
            scrollMargin={0}
          />
        </box>
      </box>

      <box flexDirection="row" paddingLeft={2} gap={0}>
        <text fg={modelColor} content={modelName} />
        {processing && elapsed > 0 ? (
          <>
            <text fg={colors.dim} content=" │ " />
            <text fg={colors.dim} content={formatElapsed(elapsed)} />
          </>
        ) : null}
        <text fg={colors.dim} content=" │ " />
        <text fg={colors.muted} content={cwd} wrapMode="truncate" flexGrow={1} flexShrink={1} />
        <box
          hoverStyle={{ backgroundColor: colors.border }}
          onMouseDown={(e: any) => {
            e.stopPropagation();
            e.preventDefault();
            onHelpClick();
          }}
        >
          <text fg={colors.dim} content=" ? help" />
        </box>
      </box>
    </box>
  );
}

export const InputArea = React.memo(InputAreaInner);
