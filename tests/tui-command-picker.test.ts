import { describe, expect, it } from "vitest";

import {
  acceptCommandPickerSelection,
  createCommandPicker,
  exitCommandPickerLevel,
  getCommandPickerLevel,
  getCommandPickerPath,
  moveCommandPickerSelection,
} from "../src/tui/command-picker.js";

describe("command picker", () => {
  it("drills into nested command options before submitting", () => {
    const picker = createCommandPicker("/model", [
      {
        label: "openrouter",
        value: "openrouter",
        children: [
          { label: "kimi-k2.5", value: "openrouter:moonshotai/kimi-k2.5" },
        ],
      },
      {
        label: "anthropic",
        value: "anthropic",
        children: [
          { label: "claude-sonnet-4-6", value: "anthropic:claude-sonnet-4-6" },
        ],
      },
    ]);

    const firstAccept = acceptCommandPickerSelection(picker);
    expect(firstAccept).toEqual(
      expect.objectContaining({
        kind: "drill_down",
      }),
    );

    const nested = firstAccept?.kind === "drill_down" ? firstAccept.picker : null;
    expect(nested).not.toBeNull();
    expect(getCommandPickerPath(nested!)).toEqual(["openrouter"]);
    expect(getCommandPickerLevel(nested!).options[0]?.label).toBe("kimi-k2.5");

    const secondAccept = acceptCommandPickerSelection(nested!);
    expect(secondAccept).toEqual({
      kind: "submit",
      command: "/model openrouter:moonshotai/kimi-k2.5",
    });
  });

  it("supports cyclic selection movement and backing out of nested levels", () => {
    const picker = createCommandPicker("/thinking", [
      { label: "default", value: "default" },
      { label: "high", value: "high" },
    ]);

    const moved = moveCommandPickerSelection(picker, -1);
    expect(getCommandPickerLevel(moved).selected).toBe(1);

    const nestedPicker = createCommandPicker("/model", [
      {
        label: "openrouter",
        value: "openrouter",
        children: [{ label: "kimi-k2.5", value: "openrouter:moonshotai/kimi-k2.5" }],
      },
    ]);
    const drilled = acceptCommandPickerSelection(nestedPicker);
    expect(drilled?.kind).toBe("drill_down");
    const backedOut = drilled?.kind === "drill_down"
      ? exitCommandPickerLevel(drilled.picker)
      : null;
    expect(backedOut).not.toBeNull();
    expect(getCommandPickerPath(backedOut!)).toEqual([]);
    expect(exitCommandPickerLevel(backedOut!)).toBeNull();
  });
});
