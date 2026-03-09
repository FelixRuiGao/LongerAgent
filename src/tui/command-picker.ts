import type { CommandOption } from "../commands.js";

export interface CommandPickerLevel {
  label: string;
  options: CommandOption[];
  selected: number;
}

export interface CommandPickerState {
  commandName: string;
  stack: CommandPickerLevel[];
}

export type CommandPickerAcceptResult =
  | { kind: "drill_down"; picker: CommandPickerState }
  | { kind: "submit"; command: string };

function clampSelection(selected: number, options: CommandOption[]): number {
  if (options.length === 0) return 0;
  if (selected < 0) return 0;
  if (selected >= options.length) return options.length - 1;
  return selected;
}

export function createCommandPicker(
  commandName: string,
  options: CommandOption[],
): CommandPickerState {
  return {
    commandName,
    stack: [{ label: commandName, options, selected: 0 }],
  };
}

export function isCommandPickerActive(
  picker: CommandPickerState | null | undefined,
): picker is CommandPickerState {
  return Boolean(picker && picker.stack.length > 0);
}

export function getCommandPickerLevel(picker: CommandPickerState): CommandPickerLevel {
  return picker.stack[picker.stack.length - 1]!;
}

export function getCommandPickerPath(picker: CommandPickerState): string[] {
  return picker.stack.slice(1).map((level) => level.label);
}

export function moveCommandPickerSelection(
  picker: CommandPickerState,
  delta: number,
): CommandPickerState {
  const level = getCommandPickerLevel(picker);
  const count = level.options.length;
  if (count === 0) return picker;
  const nextSelected = (level.selected + delta + count) % count;
  return {
    ...picker,
    stack: [
      ...picker.stack.slice(0, -1),
      { ...level, selected: nextSelected },
    ],
  };
}

export function exitCommandPickerLevel(picker: CommandPickerState): CommandPickerState | null {
  if (picker.stack.length <= 1) return null;
  return {
    ...picker,
    stack: picker.stack.slice(0, -1),
  };
}

export function acceptCommandPickerSelection(
  picker: CommandPickerState,
): CommandPickerAcceptResult | null {
  const level = getCommandPickerLevel(picker);
  const option = level.options[clampSelection(level.selected, level.options)];
  if (!option) return null;

  if (option.children && option.children.length > 0) {
    return {
      kind: "drill_down",
      picker: {
        ...picker,
        stack: [
          ...picker.stack,
          {
            label: option.label,
            options: option.children,
            selected: 0,
          },
        ],
      },
    };
  }

  return {
    kind: "submit",
    command: `${picker.commandName} ${option.value}`.trim(),
  };
}
