/** @jsxImportSource @opentui/react */

import React from "react";

import type { InputRenderable } from "@opentui/core";
import type { CommandPickerState } from "../../../src/ui/command-picker.js";
import {
  getCommandPickerLevel,
  getCommandPickerPath,
  getCommandPickerVisibleRange,
  isCommandPickerActive,
} from "../../../src/ui/command-picker.js";
import type { CheckboxPickerState } from "../../../src/ui/checkbox-picker.js";
import {
  getCheckboxPickerVisibleRange,
  isCheckboxPickerActive,
} from "../../../src/ui/checkbox-picker.js";
import type { DisplayTheme } from "../theme/index.js";
import type {
  CommandOverlayState,
  OAuthOverlayState,
  PromptSecretState,
  PromptSelectState,
} from "../types.js";
import { truncateToWidth } from "../utils/format.js";
import { PanelSurface } from "../primitives/panel-surface.js";
import { SelectableRow } from "../primitives/selectable-row.js";

interface OverlayFrameProps {
  theme: DisplayTheme;
  width?: string | number;
  height?: string | number;
  children: React.ReactNode;
}

function OverlayFrame({ theme, width = "100%", height, children }: OverlayFrameProps): React.ReactElement {
  return (
    <PanelSurface
      colors={theme.colors}
      spacing={theme.spacing}
      width={width}
      height={height}
      flexDirection="column"
      flexShrink={0}
      border={false}
    >
      {children}
    </PanelSurface>
  );
}

interface OverlayOptionRowProps {
  theme: DisplayTheme;
  label: string;
  selected: boolean;
  width: number;
  onPress?: () => void;
}

function OverlayOptionRow({
  theme,
  label,
  selected,
  width,
  onPress,
}: OverlayOptionRowProps): React.ReactElement {
  const prefix = selected ? "> " : "  ";
  return (
    <SelectableRow
      hoverBackgroundColor={theme.colors.border}
      onPress={onPress}
    >
      <text
        fg={selected ? theme.colors.accent : theme.colors.dim}
        content={truncateToWidth(`${prefix}${label}`, width)}
      />
    </SelectableRow>
  );
}

export function CommandOverlayView(
  {
    overlay,
    theme,
    contentWidth,
    maxVisible,
    onItemClick,
  }: {
    overlay: CommandOverlayState;
    theme: DisplayTheme;
    contentWidth: number;
    maxVisible: number;
    onItemClick: (index: number) => void;
  },
): React.ReactElement | null {
  if (!overlay.visible || overlay.items.length === 0) return null;
  const start = Math.max(0, Math.min(
    overlay.selected - Math.floor(maxVisible / 2),
    Math.max(0, overlay.items.length - maxVisible),
  ));
  const end = Math.min(overlay.items.length, start + maxVisible);
  const visibleItems = overlay.items.slice(start, end);

  return (
    <OverlayFrame theme={theme} height={visibleItems.length}>
      {visibleItems.map((item, index) => {
        const actualIndex = start + index;
        return (
          <OverlayOptionRow
            key={`overlay-${actualIndex}`}
            theme={theme}
            label={item}
            selected={actualIndex === overlay.selected}
            width={contentWidth}
            onPress={() => onItemClick(actualIndex)}
          />
        );
      })}
    </OverlayFrame>
  );
}

export function CommandPickerView(
  {
    picker: pickerProp,
    theme,
    contentWidth,
    maxVisible,
    onItemClick,
  }: {
    picker: CommandPickerState | null;
    theme: DisplayTheme;
    contentWidth: number;
    maxVisible: number;
    onItemClick: (index: number) => void;
  },
): React.ReactElement | null {
  if (!isCommandPickerActive(pickerProp)) return null;

  const picker = { ...pickerProp, maxVisible };
  const level = getCommandPickerLevel(picker);
  const path = getCommandPickerPath(picker);
  const { start, end } = getCommandPickerVisibleRange(picker);
  const visibleOptions = level.options.slice(start, end);
  const pickerHeight = 1 + visibleOptions.length;
  const title = path.length > 0
    ? `${picker.commandName} › ${path.join(" › ")}`
    : picker.commandName;

  return (
    <OverlayFrame theme={theme} height={pickerHeight}>
      <text fg={theme.colors.accent} content={truncateToWidth(title, contentWidth)} />
      {visibleOptions.map((item, index) => {
        const actualIndex = start + index;
        return (
          <OverlayOptionRow
            key={`picker-${picker.stack.length}-${actualIndex}`}
            theme={theme}
            label={item.label}
            selected={actualIndex === level.selected}
            width={contentWidth}
            onPress={() => onItemClick(actualIndex)}
          />
        );
      })}
    </OverlayFrame>
  );
}

export function CheckboxPickerView(
  {
    picker,
    theme,
    contentWidth,
    onItemClick,
  }: {
    picker: CheckboxPickerState | null;
    theme: DisplayTheme;
    contentWidth: number;
    onItemClick: (index: number) => void;
  },
): React.ReactElement | null {
  if (!isCheckboxPickerActive(picker)) return null;

  const { start, end } = getCheckboxPickerVisibleRange(picker);
  const visibleItems = picker.items.slice(start, end);
  const pickerHeight = 1 + visibleItems.length + 1;

  return (
    <OverlayFrame theme={theme} height={pickerHeight}>
      <text fg={theme.colors.accent} content={truncateToWidth(picker.title, contentWidth)} />
      {visibleItems.map((item, index) => {
        const actualIndex = start + index;
        const checkbox = item.checked ? "[x]" : "[ ]";
        return (
          <OverlayOptionRow
            key={`checkbox-${actualIndex}`}
            theme={theme}
            label={`${checkbox} ${item.label}`}
            selected={actualIndex === picker.selected}
            width={contentWidth}
            onPress={() => onItemClick(actualIndex)}
          />
        );
      })}
      <text fg={theme.colors.dim} content={truncateToWidth("Space toggle · Enter confirm · Esc cancel", contentWidth)} />
    </OverlayFrame>
  );
}

export function PromptSelectView(
  {
    prompt,
    theme,
    contentWidth,
    maxVisible,
    onItemClick,
  }: {
    prompt: PromptSelectState | null;
    theme: DisplayTheme;
    contentWidth: number;
    maxVisible: number;
    onItemClick: (index: number) => void;
  },
): React.ReactElement | null {
  if (!prompt || prompt.options.length === 0) return null;

  const start = Math.max(0, Math.min(
    prompt.selected - Math.floor(maxVisible / 2),
    Math.max(0, prompt.options.length - maxVisible),
  ));
  const end = Math.min(prompt.options.length, start + maxVisible);
  const visibleOptions = prompt.options.slice(start, end);
  const selectedOption = prompt.options[Math.max(0, Math.min(prompt.selected, prompt.options.length - 1))];
  const description = selectedOption?.description?.trim();
  const promptHeight = 1 + visibleOptions.length + (description ? 1 : 0);

  return (
    <OverlayFrame theme={theme} height={promptHeight}>
      <text fg={theme.colors.yellow} content={truncateToWidth(prompt.message, contentWidth)} />
      {visibleOptions.map((option, index) => {
        const actualIndex = start + index;
        return (
          <OverlayOptionRow
            key={`prompt-${actualIndex}`}
            theme={theme}
            label={option.label}
            selected={actualIndex === prompt.selected}
            width={contentWidth}
            onPress={() => onItemClick(actualIndex)}
          />
        );
      })}
      {description ? <text fg={theme.colors.dim} content={truncateToWidth(description, contentWidth)} /> : null}
    </OverlayFrame>
  );
}

export function PromptSecretView(
  {
    prompt,
    inputRef,
    focused,
    onSubmit,
    theme,
  }: {
    prompt: PromptSecretState | null;
    inputRef: React.RefObject<InputRenderable | null>;
    focused: boolean;
    onSubmit: (value: string) => void;
    theme: DisplayTheme;
  },
): React.ReactElement | null {
  if (!prompt) return null;

  const promptHeight = Math.max(3, prompt.message.split("\n").length + 2);

  return (
    <OverlayFrame theme={theme} height={promptHeight}>
      <text fg={theme.colors.yellow} content={prompt.message} />
      <input
        ref={(node) => {
          inputRef.current = node;
        }}
        placeholder={prompt.allowEmpty ? "Press Enter to confirm, Esc to cancel" : "Enter a value"}
        focused={focused}
        textColor={theme.colors.text}
        focusedTextColor={theme.colors.text}
        placeholderColor={theme.colors.dim}
        onSubmit={onSubmit}
      />
      <text fg={theme.colors.dim} content="Enter confirm · Esc cancel" />
    </OverlayFrame>
  );
}

export function OAuthOverlayView(
  {
    state,
    theme,
    contentWidth,
  }: {
    state: OAuthOverlayState | null;
    theme: DisplayTheme;
    contentWidth: number;
  },
): React.ReactElement | null {
  if (!state) return null;

  const { phase } = state;
  if (phase.step === "choose") {
    const options = [
      "Browser login (recommended)",
      "Device code (SSH / headless)",
    ];
    return (
      <OverlayFrame theme={theme} height={options.length + 2}>
        <text fg={theme.colors.yellow} content="OpenAI ChatGPT Login" />
        {options.map((label, index) => (
          <OverlayOptionRow
            key={`oauth-opt-${index}`}
            theme={theme}
            label={label}
            selected={index === state.selected}
            width={contentWidth}
          />
        ))}
        <text fg={theme.colors.dim} content="Enter select · Esc cancel" />
      </OverlayFrame>
    );
  }

  const lines: string[] = [];
  if (phase.step === "browser_waiting") {
    lines.push("Waiting for browser authorization...");
    lines.push("");
    lines.push(`URL: ${phase.url.length > contentWidth - 5 ? `${phase.url.slice(0, contentWidth - 8)}...` : phase.url}`);
  } else if (phase.step === "device_code") {
    lines.push(`Open:  ${phase.url}`);
    lines.push(`Code:  ${phase.userCode}`);
    lines.push("");
    lines.push("Waiting for sign-in...");
  } else if (phase.step === "polling") {
    lines.push("Waiting for sign-in...");
  } else if (phase.step === "exchanging") {
    lines.push("Exchanging authorization code...");
  } else if (phase.step === "done") {
    lines.push("Login successful!");
  } else if (phase.step === "error") {
    lines.push(`Error: ${phase.message}`);
  }

  return (
    <OverlayFrame theme={theme} height={lines.length + 2}>
      <text fg={theme.colors.yellow} content="OpenAI ChatGPT Login" />
      {lines.map((line, index) => (
        <text key={`oauth-line-${index}`} fg={theme.colors.text} content={truncateToWidth(line, contentWidth)} />
      ))}
      <text fg={theme.colors.dim} content="Esc cancel" />
    </OverlayFrame>
  );
}
