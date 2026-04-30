import { describe, expect, it } from "vitest";
import {
  acceptCommandPickerSelection,
  createCommandPicker,
  moveCommandPickerSelection,
  setCommandPickerSelection,
} from "../src/ui/command-picker.js";

describe("command picker", () => {
  it("skips disabled heading rows for initial selection and submission", () => {
    const picker = createCommandPicker("/sessions", [
      { label: "Created  Active  Title", value: "", disabled: true },
      { label: "2 days ago  1 day ago  Fix login", value: "session-a" },
      { label: "5 days ago  5 days ago  Refactor picker", value: "session-b" },
    ]);

    expect(picker.stack[0]?.selected).toBe(1);
    expect(acceptCommandPickerSelection(picker)).toEqual({
      kind: "submit",
      command: "/sessions session-a",
    });

    const unchanged = setCommandPickerSelection(picker, 0);
    expect(unchanged.stack[0]?.selected).toBe(1);

    const moved = moveCommandPickerSelection(picker, -1);
    expect(moved.stack[0]?.selected).toBe(2);
  });
});
