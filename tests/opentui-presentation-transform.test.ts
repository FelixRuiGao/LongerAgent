import { describe, expect, it } from "vitest";

import type { ReconciledConversationEntry } from "../opentui-src/transcript/types.js";
import { presentationTransform } from "../opentui-src/presentation/transform.js";

function reconciled(
  id: string,
  entry: ReconciledConversationEntry["entry"],
  contentVersion = 1,
): ReconciledConversationEntry {
  return { id, entry, contentVersion };
}

describe("OpenTUI presentation transform", () => {
  it("does not keep a completed tool active just because activeEntryId still points at its tool_call", () => {
    const entries: ReconciledConversationEntry[] = [
      reconciled("tc-old", {
        id: "tc-old",
        kind: "tool_call",
        text: "bash mkdir -p /tmp/demo",
        meta: {
          toolName: "bash",
          toolArgs: { command: "mkdir -p /tmp/demo" },
          toolExecState: "completed",
          toolStreamState: "closed",
        },
      }),
      reconciled("tr-old", {
        id: "tr-old",
        kind: "tool_result",
        text: "OK",
        meta: {
          toolName: "bash",
          isError: false,
        },
      }),
      reconciled("tc-new", {
        id: "tc-new",
        kind: "tool_call",
        text: "write_file /tmp/demo.txt",
        meta: {
          toolName: "write_file",
          toolArgs: { path: "/tmp/demo.txt", content: "hello" },
          toolExecState: "running",
          toolStreamState: "closed",
        },
      }),
    ];

    const result = presentationTransform(entries, [], true, "tc-old");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      kind: "tool_operation",
      toolDisplayName: "Run",
      state: "done",
    });
    expect(result[1]).toMatchObject({
      kind: "tool_operation",
      toolDisplayName: "Write",
      state: "active",
    });
  });
});
