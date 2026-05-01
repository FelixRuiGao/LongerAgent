import { describe, expect, it } from "bun:test";

import {
  createAssistantText,
  createCompactContext,
  createCompactMarker,
  createSummary,
  createSystemPrompt,
  createToolCall,
  createToolResult,
  createUserMessage,
  type LogEntry,
} from "../src/log-entry.js";
import { execSummarizeContextOnLog, truncateDistillContent } from "../src/summarize-context.js";

function allocIds(prefix: string): () => string {
  let i = 0;
  return () => `${prefix}${++i}`;
}

describe("truncateDistillContent", () => {
  it("keeps short content unchanged", () => {
    const text = "short content";
    expect(truncateDistillContent(text)).toBe(text);
  });

  it("truncates long content at space boundary and includes context reference", () => {
    const text = "A".repeat(95) + " word " + "B".repeat(80);
    const out = truncateDistillContent(text, "ctx9");
    expect(out).toContain("truncated");
    expect(out).toContain("context_id ctx9");
    expect(out.length).toBeLessThan(text.length);
  });

  it("hard-truncates at 120 chars when no space found", () => {
    const text = "A".repeat(200);
    const out = truncateDistillContent(text);
    // 120 chars of A + suffix
    expect(out.startsWith("A".repeat(120))).toBe(true);
    expect(out).toContain("truncated");
  });
});

describe("execSummarizeContextOnLog", () => {
  it("distills a visible context range in-place", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hello", "hello", "c1"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["c1"], content: "compressed" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
    expect(entries[1].type).toBe("summary");
    expect(String(entries[1].content)).not.toContain("§{");
    expect(entries[2].summarized).toBe(true);
    expect((entries[1].meta as Record<string, unknown>)["summaryDepth"]).toBe(1);
  });

  it("allows distilling compact_context in the active window", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "old", "old", "old1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createCompactContext("cc-001", 1, "continuation", "cc1", 0),
      createUserMessage("user-002", 1, "new", "new", "u2"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["cc1"], content: "compact distilled" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
    expect(entries.some((e) => e.type === "summary" && String(e.content).includes("compact distilled"))).toBe(true);
    expect(entries.find((e) => e.id === "cc-001")?.summarized).toBe(true);
  });

  it("treats sub-context IDs as part of their main context", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createAssistantText("asst-001", 1, 0, "Checking", "Checking", "7.1"),
      createToolCall(
        "tc-001",
        1,
        0,
        "read_file",
        { id: "call_1", name: "read_file", arguments: { path: "x.ts" } },
        { toolCallId: "call_1", toolName: "read_file", agentName: "agent", contextId: "7.1" },
      ),
      createToolResult(
        "tr-001",
        1,
        0,
        { toolCallId: "call_1", toolName: "read_file", content: "source", toolSummary: "read" },
        { isError: false, contextId: "7.1" },
      ),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["7"], content: "tool round distilled" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded");
    expect(entries.filter((e) => e.summarized).map((e) => e.id)).toEqual([
      "asst-001",
      "tc-001",
      "tr-001",
    ]);
  });

  it("rejects non-contiguous contexts", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "a", "a", "c1"),
      createAssistantText("asst-001", 1, 0, "gap", "gap", "c2"),
      createUserMessage("user-002", 1, "b", "b", "c3"),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["c1", "c3"], content: "bad" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("Not spatially contiguous");
  });

  it("rejects contexts before the last compact marker", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "old", "old", "old1"),
      createCompactMarker("cm-001", 1, 0, 100, 20),
      createSummary("sum-keep", 1, "kept", "kept", "new1", ["old1"], 1),
    ];

    const result = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["old1"], content: "hidden" }] },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("0 succeeded");
    expect(result.output).toContain("before the last compact marker");
  });

  it("rejects duplicate references within the same call", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hello", "hello", "c1"),
    ];

    const result = execSummarizeContextOnLog(
      {
        operations: [
          { context_ids: ["c1"], content: "first" },
          { context_ids: ["c1"], content: "second" },
        ],
      },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("1 succeeded, 1 failed");
    expect(result.output).toContain("already referenced by another operation");
  });

  it("supports re-distillation with depth tracking", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "hello", "hello", "c1"),
    ];
    const ctxAlloc = allocIds("ctx-");
    const logAlloc = allocIds("sum-");

    const first = execSummarizeContextOnLog(
      { operations: [{ context_ids: ["c1"], content: "first distilled" }] },
      entries,
      ctxAlloc,
      logAlloc,
      1,
    );
    const firstSummaryId = first.results[0].newContextId!;

    const second = execSummarizeContextOnLog(
      { operations: [{ context_ids: [firstSummaryId], content: "second distilled" }] },
      entries,
      ctxAlloc,
      logAlloc,
      1,
    );

    expect(second.output).toContain("1 succeeded");
    const latestSummary = entries.find((e) => e.type === "summary" && e.id === "sum-2")!;
    expect((latestSummary.meta as Record<string, unknown>)["summaryDepth"]).toBe(2);
  });

  it("returns a direct error when no operations are provided", () => {
    const result = execSummarizeContextOnLog(
      { operations: [] },
      [],
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toBe("Error: no operations provided.");
    expect(result.results[0].success).toBe(false);
  });

  it("handles multiple independent operations in one call", () => {
    const entries: LogEntry[] = [
      createSystemPrompt("sys-001", "prompt"),
      createUserMessage("user-001", 1, "first msg", "first msg", "c1"),
      createAssistantText("asst-001", 1, 0, "response 1", "response 1", "c1"),
      createUserMessage("user-002", 1, "second msg", "second msg", "c2"),
      createAssistantText("asst-002", 1, 0, "response 2", "response 2", "c2"),
      createUserMessage("user-003", 1, "third msg", "third msg", "c3"),
    ];

    const result = execSummarizeContextOnLog(
      {
        operations: [
          { context_ids: ["c1"], content: "Phase 1: initial exploration of the auth module, found strategy pattern in src/auth/provider.ts", reason: "phase 1 complete" },
          { context_ids: ["c2"], content: "Phase 2: config analysis, roles.yaml at src/config/, no validation on load", reason: "phase 2 complete" },
        ],
      },
      entries,
      allocIds("ctx-"),
      allocIds("sum-"),
      1,
    );

    expect(result.output).toContain("2 submitted, 2 succeeded, 0 failed");
    // Both original context groups should be summarized
    expect(entries.filter((e) => e.summarized).length).toBe(4); // 2 user + 2 assistant
    // Two new summary entries should exist
    expect(entries.filter((e) => e.type === "summary").length).toBe(2);
    // c3 should remain untouched
    const c3Entry = entries.find((e) => e.id === "user-003");
    expect(c3Entry?.summarized).toBeFalsy();
  });
});
