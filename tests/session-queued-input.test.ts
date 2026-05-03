import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { SessionStore } from "../src/persistence.js";
import { projectToApiMessages, projectToTuiEntries } from "../src/log-projection.js";
import { Session } from "../src/session.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(projectRoot: string): Session {
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "You are a test agent.",
    tools: [],
    _provider: {
      budgetCalcMode: "last_call",
      requiresAlternatingRoles: false,
    },
    modelConfig: {
      model: "test-model",
      contextLength: 8192,
      maxTokens: 1024,
      supportsMultimodal: false,
    },
  } as any;

  const store = new SessionStore({ baseDir: projectRoot, projectPath: projectRoot });
  store.createSession();

  return new Session({
    primaryAgent,
    config: {
      mcpServerConfigs: [],
      getModel: () => ({ model: "test" }),
    } as any,
    store,
  });
}

function textResult(text: string, callCount: number): any {
  return {
    text,
    toolHistory: [],
    totalUsage: { inputTokens: 10 * callCount, outputTokens: 1 },
    intermediateText: [],
    lastInputTokens: 10 * callCount,
    reasoningContent: "",
    reasoningState: null,
    lastTotalTokens: 10 * callCount + 1,
    textHandledInLog: false,
    reasoningHandledInLog: false,
    endedWithoutToolCalls: true,
  };
}

describe("queued user input", () => {
  it("continues the same work lifecycle after text-only output", async () => {
    const projectRoot = makeTempDir("fermi-queued-input-");
    try {
      const session = makeSession(projectRoot);
      let callCount = 0;
      let secondActivationSawQueuedMessage = false;

      (session.primaryAgent as any).asyncRunWithMessages = async (
        getMessages: () => Array<Record<string, unknown>>,
      ) => {
        callCount += 1;
        if (callCount === 1) {
          session.deliverMessage("user", "second while first is still running");
          return textResult("first response", callCount);
        }

        const messages = getMessages();
        secondActivationSawQueuedMessage = messages.some((message) =>
          message.role === "user" &&
          String(message.content).includes("second while first is still running")
        );
        return textResult("second response", callCount);
      };

      await session.turn("first");

      expect(callCount).toBe(2);
      expect(secondActivationSawQueuedMessage).toBe(true);
      expect(session.log.filter((entry) => entry.type === "input_received")).toHaveLength(2);
      expect(session.log.filter((entry) => entry.type === "work_end")).toHaveLength(1);
      expect(session.log.filter((entry) => entry.type === "assistant_text").map((entry) => entry.meta.providerRoundId))
        .toEqual(["input-1:round-0", "input-2:round-0"]);

      const tui = projectToTuiEntries([...session.log]);
      expect(tui.filter((entry) => entry.kind === "user").map((entry) => entry.text))
        .toEqual(["first", "second while first is still running"]);

      const api = projectToApiMessages([...session.log]);
      expect(api.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
