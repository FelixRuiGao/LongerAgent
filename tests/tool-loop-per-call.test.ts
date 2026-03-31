import { describe, expect, it } from "vitest";

import { asyncRunToolLoop } from "../src/agents/tool-loop.js";
import { createEphemeralLogState } from "../src/ephemeral-log.js";
import type { LogEntry } from "../src/log-entry.js";
import { BaseProvider, ProviderResponse, Usage } from "../src/providers/base.js";

function createUpdateEntry(entries: LogEntry[]) {
  return (entryId: string, patch: { content?: unknown; display?: string; meta?: Record<string, unknown> }): void => {
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    if (patch.content !== undefined) entry.content = patch.content;
    if (patch.display !== undefined) entry.display = patch.display;
    if (patch.meta !== undefined) entry.meta = patch.meta;
  };
}

describe("tool-loop per-call lifecycle", () => {
  it("starts executing a closed tool call before the provider returns its final response", async () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
    ]);
    const events: string[] = [];

    let releaseProviderReturn: (() => void) | null = null;
    const providerGate = new Promise<void>((resolve) => {
      releaseProviderReturn = resolve;
    });

    class StreamingProvider extends BaseProvider {
      private _calls = 0;

      async sendMessage(
        _messages: any[],
        _tools?: any[],
        options?: {
          onToolCallStart?: (callId: string, name: string) => void;
          onToolCallArgDelta?: (callId: string, args: string) => void;
          onToolCallClosed?: (callId: string, args: string) => void;
        },
      ): Promise<ProviderResponse> {
        this._calls += 1;
        if (this._calls === 1) {
          options?.onToolCallStart?.("call_1", "read_file");
          options?.onToolCallArgDelta?.("call_1", "{\"path\":\"a.txt\"}");
          options?.onToolCallClosed?.("call_1", "{\"path\":\"a.txt\"}");
          events.push("provider:closed");
          await providerGate;
          events.push("provider:return");
          return new ProviderResponse({
            toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
            usage: new Usage(1, 1),
          });
        }
        return new ProviderResponse({
          text: "done",
          usage: new Usage(1, 1),
        });
      }
    }

    const resultPromise = asyncRunToolLoop({
      provider: new StreamingProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      toolExecutors: {
        read_file: async (args) => {
          events.push(`tool:${String(args["path"] ?? "")}`);
          releaseProviderReturn?.();
          return "OK";
        },
      },
      maxRounds: 2,
      onToolCallStart: () => {},
      onToolCallArgDelta: () => {},
      updateEntry: createUpdateEntry(runtime.entries),
    });

    const result = await resultPromise;

    expect(events.indexOf("tool:a.txt")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("tool:a.txt")).toBeLessThan(events.indexOf("provider:return"));
    expect(result.text).toBe("done");
  });

  it("executes repaired write_file calls immediately after close detection", async () => {
    const runtime = createEphemeralLogState([
      { role: "system", content: "prompt" },
      { role: "user", content: "hi" },
    ]);
    const executedArgs: Array<Record<string, unknown>> = [];

    let releaseProviderReturn: (() => void) | null = null;
    const providerGate = new Promise<void>((resolve) => {
      releaseProviderReturn = resolve;
    });

    class RepairedWriteProvider extends BaseProvider {
      private _calls = 0;

      async sendMessage(
        _messages: any[],
        _tools?: any[],
        options?: {
          onToolCallStart?: (callId: string, name: string) => void;
          onToolCallArgDelta?: (callId: string, args: string) => void;
          onToolCallClosed?: (callId: string, args: string) => void;
        },
      ): Promise<ProviderResponse> {
        this._calls += 1;
        if (this._calls === 1) {
          const partial = "{\"path\":\"demo.txt\",\"content\":\"hello";
          options?.onToolCallStart?.("write_1", "write_file");
          options?.onToolCallArgDelta?.("write_1", partial);
          options?.onToolCallClosed?.("write_1", partial);
          await providerGate;
          return new ProviderResponse({
            toolCalls: [
              {
                id: "write_1",
                name: "write_file",
                arguments: {
                  _parseError: "Failed to parse streamed tool arguments as JSON.",
                },
              },
            ],
            usage: new Usage(1, 1),
          });
        }
        return new ProviderResponse({
          text: "done",
          usage: new Usage(1, 1),
        });
      }
    }

    const result = await asyncRunToolLoop({
      provider: new RepairedWriteProvider(),
      getMessages: runtime.getMessages,
      appendEntry: runtime.appendEntry,
      allocId: runtime.allocId,
      turnIndex: 0,
      toolExecutors: {
        write_file: async (args) => {
          executedArgs.push(args);
          releaseProviderReturn?.();
          return "OK";
        },
      },
      maxRounds: 2,
      onToolCallStart: () => {},
      onToolCallArgDelta: () => {},
      updateEntry: createUpdateEntry(runtime.entries),
    });

    expect(executedArgs).toEqual([
      {
        path: "demo.txt",
        content: "hello",
      },
    ]);
    expect(result.text).toBe("done");
  });
});
