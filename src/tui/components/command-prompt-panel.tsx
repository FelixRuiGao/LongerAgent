import React from "react";
import { Box, Text } from "ink";
import type { PromptChoice } from "../../provider-credential-flow.js";

const ANSI_INVERSE_ON = "\u001B[7m";
const ANSI_INVERSE_OFF = "\u001B[27m";

function renderWithCursor(value: string, cursor: number): string {
  if (value.length === 0) return `${ANSI_INVERSE_ON} ${ANSI_INVERSE_OFF}`;
  const c = Math.max(0, Math.min(cursor, value.length));
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    out += i === c ? `${ANSI_INVERSE_ON}${value[i]}${ANSI_INVERSE_OFF}` : value[i];
  }
  if (c === value.length) out += `${ANSI_INVERSE_ON} ${ANSI_INVERSE_OFF}`;
  return out;
}

function maskValue(value: string): string {
  return "*".repeat(value.length);
}

export interface CommandPromptSelectState {
  kind: "select";
  message: string;
  options: PromptChoice[];
  selected: number;
}

export interface CommandPromptSecretState {
  kind: "secret";
  message: string;
  value: string;
  cursor: number;
  allowEmpty?: boolean;
  error?: string | null;
}

export type CommandPromptState =
  | CommandPromptSelectState
  | CommandPromptSecretState;

export interface CommandPromptPanelProps {
  prompt: CommandPromptState;
}

export function CommandPromptPanel({
  prompt,
}: CommandPromptPanelProps): React.ReactElement {
  if (prompt.kind === "secret") {
    return (
      <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
        <Text color="yellow">Command Prompt</Text>
        <Text>{prompt.message}</Text>
        <Box marginTop={1}>
          <Text>{renderWithCursor(maskValue(prompt.value), prompt.cursor)}</Text>
        </Box>
        <Text dimColor>Enter to save. Esc or Ctrl+C to cancel.</Text>
        {prompt.error ? <Text color="red">{prompt.error}</Text> : null}
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow">Command Prompt</Text>
      <Text>{prompt.message}</Text>
      <Box flexDirection="column" marginTop={1}>
        {prompt.options.map((option, index) => (
          <Box key={`${option.value}-${index}`} flexDirection="column">
            <Text color={index === prompt.selected ? "yellow" : undefined} bold={index === prompt.selected}>
              {index === prompt.selected ? " > " : "   "}
              {option.label}
            </Text>
            {option.description ? <Text dimColor>     {option.description}</Text> : null}
          </Box>
        ))}
      </Box>
      <Text dimColor>Use ↑/↓ to select, Enter to confirm, Esc or Ctrl+C to cancel.</Text>
    </Box>
  );
}
