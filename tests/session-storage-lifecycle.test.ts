import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { countTokens as gptCountTokens, encode as gptEncode } from "gpt-tokenizer/model/gpt-5";

import { Session } from "../src/session.js";
import { SessionStore } from "../src/persistence.js";
import { createLogSessionMeta, loadLog, saveLog } from "../src/persistence.js";
import { projectToApiMessages, projectToTuiEntries } from "../src/log-projection.js";
import {
  LogIdAllocator,
  createAssistantText,
  createReasoning,
  createSummary,
  createSystemPrompt,
  createToolResult,
  createTurnEnd,
  createTurnStart,
  createTokenUpdate,
  createToolCall,
  createUserMessage,
} from "../src/log-entry.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(
  projectRoot: string,
  store: SessionStore,
  options?: {
    modelConfigs?: Record<string, {
      name: string;
      provider: string;
      model: string;
      apiKey?: string;
      maxTokens: number;
      contextLength: number;
      supportsMultimodal: boolean;
    }>;
    initialModelConfigName?: string;
  },
): Session {
  const modelConfigs = options?.modelConfigs ?? {
    "test-model": {
      name: "test-model",
      provider: "openai",
      model: "gpt-5.2",
      apiKey: "sk-test",
      maxTokens: 256,
      contextLength: 8192,
      supportsMultimodal: false,
    },
  };
  const initialModelConfigName = options?.initialModelConfigName ?? "test-model";
  const initialModelConfig = modelConfigs[initialModelConfigName];
  if (!initialModelConfig) {
    throw new Error(`Unknown initial model config '${initialModelConfigName}'.`);
  }

  const primaryAgent = {
    name: "Primary",
    systemPrompt: "ROOT={PROJECT_ROOT}\nART={SESSION_ARTIFACTS}\nSYS={SYSTEM_DATA}",
    tools: [],
    modelConfig: { ...initialModelConfig },
    _provider: {
      budgetCalcMode: "full_context",
    },
    replaceModelConfig(next: typeof initialModelConfig) {
      this.modelConfig = next;
    },
  } as any;

  const config = {
    pathOverrides: { projectRoot },
    subAgentModelName: undefined,
    mcpServerConfigs: [],
    getModel: (name: string) => {
      const modelConfig = modelConfigs[name];
      if (!modelConfig) {
        const available = Object.keys(modelConfigs).join(", ") || "(none)";
        throw new Error(`Model config '${name}' not found. Available: ${available}`);
      }
      return { ...modelConfig };
    },
    listModelEntries: () =>
      Object.values(modelConfigs).map((modelConfig) => ({
        name: modelConfig.name,
        provider: modelConfig.provider,
        model: modelConfig.model,
        apiKeyRaw: modelConfig.apiKey ?? "",
        hasResolvedApiKey: Boolean(modelConfig.apiKey),
      })),
    upsertModelRaw: (name: string, cfg: Record<string, unknown>) => {
      modelConfigs[name] = {
        name,
        provider: String(cfg["provider"] ?? ""),
        model: String(cfg["model"] ?? ""),
        apiKey: String(cfg["api_key"] ?? ""),
        maxTokens: Number(cfg["max_tokens"] ?? 32000),
        contextLength: Number(cfg["context_length"] ?? 8192),
        supportsMultimodal: Boolean(cfg["supports_multimodal"] ?? false),
      };
    },
    get modelNames() {
      return Object.keys(modelConfigs);
    },
  } as any;

  return new Session({
    primaryAgent,
    config,
    store,
  });
}

function stubRunActivation(session: Session, text = "ok"): void {
  (session as any)._runActivation = async () => ({
    text,
    lastInputTokens: 1,
    lastTotalTokens: 2,
    totalUsage: {},
    toolHistory: [],
    compactNeeded: false,
  });
}

function countMessageTokens(messages: Array<Record<string, unknown>>): number {
  return gptCountTokens(messages as any);
}

describe("session storage lifecycle", () => {
  it("round-trips global TUI preferences through SessionStore", () => {
    const baseDir = makeTempDir("longeragent-prefs-base-");
    const projectRoot = makeTempDir("longeragent-prefs-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      store.saveGlobalPreferences({
        version: 1,
        modelConfigName: "my-openrouter",
        modelProvider: "openrouter",
        modelSelectionKey: "moonshotai/kimi-k2.5",
        modelId: "moonshotai/kimi-k2.5",
        thinkingLevel: "high",
        cacheHitEnabled: false,
      });

      expect(store.loadGlobalPreferences()).toEqual(
        expect.objectContaining({
          modelConfigName: "my-openrouter",
          modelProvider: "openrouter",
          modelSelectionKey: "moonshotai/kimi-k2.5",
          modelId: "moonshotai/kimi-k2.5",
          thinkingLevel: "high",
          cacheHitEnabled: false,
        }),
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("constructs with a store that has no active session directory", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const systemContent = String(((session as any)._log?.find((e: any) => e.type === "system_prompt")?.content ?? ""));

      expect(store.sessionDir).toBeUndefined();
      expect(systemContent).toContain("/artifacts");
      expect(systemContent).not.toContain("{SESSION_ARTIFACTS}");
      expect(systemContent).toContain(store.projectDir);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("creates session storage on the first turn and hydrates system paths", async () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      stubRunActivation(session, "first-response");

      const result = await session.turn("hello");
      const artifactsDir = store.artifactsDir;
      const systemContent = String(((session as any)._log?.find((e: any) => e.type === "system_prompt")?.content ?? ""));

      expect(result).toBe("first-response");
      expect(store.sessionDir).toBeTruthy();
      expect(artifactsDir).toBeTruthy();
      expect(systemContent).not.toContain("{SESSION_ARTIFACTS}");
      expect(systemContent).toContain(artifactsDir as string);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns /new-style state to unbound storage and recreates on next turn", async () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      stubRunActivation(session, "phase-1");

      await session.turn("first");
      const firstSessionDir = store.sessionDir;
      expect(firstSessionDir).toBeTruthy();

      store.clearSession();
      session.resetForNewSession(store);

      const resetSystemContent = String(((session as any)._log?.find((e: any) => e.type === "system_prompt")?.content ?? ""));
      expect(store.sessionDir).toBeUndefined();
      expect(resetSystemContent).toContain("/artifacts");
      expect(resetSystemContent).not.toContain("{SESSION_ARTIFACTS}");

      stubRunActivation(session, "phase-2");
      await session.turn("second");

      const secondSessionDir = store.sessionDir;
      const secondArtifactsDir = store.artifactsDir;
      const hydratedSystemContent = String(((session as any)._log?.find((e: any) => e.type === "system_prompt")?.content ?? ""));
      expect(secondSessionDir).toBeTruthy();
      expect(secondSessionDir).not.toBe(firstSessionDir);
      expect(secondArtifactsDir).toBeTruthy();
      expect(hydratedSystemContent).not.toContain("{SESSION_ARTIFACTS}");
      expect(hydratedSystemContent).toContain(secondArtifactsDir as string);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses global preference defaults when resetting for /new", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);

      session.applyGlobalPreferences({
        version: 1,
        modelConfigName: "test-model",
        modelProvider: "openai",
        modelSelectionKey: "gpt-5.2",
        modelId: "gpt-5.2",
        thinkingLevel: "high",
        cacheHitEnabled: false,
      });

      session.resetForNewSession(store);

      expect(session.thinkingLevel).toBe("high");
      expect(session.cacheHitEnabled).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores cache-read token counters from log", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const entries = [
        createSystemPrompt("sys-001", "prompt"),
        createTokenUpdate("tok-001", 1, 7171, 6912, 0, 7510),
      ];
      const idAllocator = new LogIdAllocator();
      idAllocator.restoreFrom(entries);

      session.restoreFromLog?.(
        createLogSessionMeta({
          createdAt: "2026-03-05T23:55:57Z",
          updatedAt: "2026-03-05T23:55:57Z",
          turnCount: 1,
          compactCount: 0,
          projectPath: projectRoot,
          modelConfigName: "test-model",
        }),
        entries,
        idAllocator,
      );

      expect(session.lastInputTokens).toBe(7171);
      expect(session.lastTotalTokens).toBe(7510);
      expect((session as any).lastCacheReadTokens).toBe(6912);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores model config before thinking/cache state from log", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store, {
        modelConfigs: {
          "test-model": {
            name: "test-model",
            provider: "openai",
            model: "gpt-5.2",
            maxTokens: 256,
            contextLength: 8192,
            supportsMultimodal: false,
          },
          "restored-model": {
            name: "restored-model",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            maxTokens: 512,
            contextLength: 200000,
            supportsMultimodal: false,
          },
        },
      }) as any;
      const entries = [createSystemPrompt("sys-001", "prompt")];
      const idAllocator = new LogIdAllocator();
      idAllocator.restoreFrom(entries);

      session.thinkingLevel = "low";
      session.cacheHitEnabled = true;

      session.restoreFromLog(
        createLogSessionMeta({
          createdAt: "2026-03-05T23:55:57Z",
          updatedAt: "2026-03-05T23:55:57Z",
          turnCount: 1,
          compactCount: 0,
          projectPath: projectRoot,
          modelConfigName: "restored-model",
          thinkingLevel: "high",
          cacheHitEnabled: false,
        }),
        entries,
        idAllocator,
      );

      expect(session.currentModelConfigName).toBe("restored-model");
      expect(session.currentModelName).toBe("claude-sonnet-4-5");
      expect(session.primaryAgent.modelConfig.provider).toBe("anthropic");
      expect(session.thinkingLevel).toBe(
        session._resolveThinkingLevelForModel("claude-sonnet-4-5", "high"),
      );
      expect(session.cacheHitEnabled).toBe(false);
      expect(session._preferredThinkingLevel).toBe("high");
      expect(session._preferredCacheHitEnabled).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("reconstructs runtime model configs from persisted model identity", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store, {
        modelConfigs: {
          "test-model": {
            name: "test-model",
            provider: "openai",
            model: "gpt-5.2",
            apiKey: "sk-openai",
            maxTokens: 256,
            contextLength: 8192,
            supportsMultimodal: false,
          },
          "kimi-key-source": {
            name: "kimi-key-source",
            provider: "kimi-cn",
            model: "kimi-k2-instruct",
            apiKey: "sk-kimi",
            maxTokens: 256,
            contextLength: 8192,
            supportsMultimodal: false,
          },
        },
      }) as any;
      const entries = [createSystemPrompt("sys-001", "prompt")];
      const idAllocator = new LogIdAllocator();
      idAllocator.restoreFrom(entries);

      session.restoreFromLog(
        createLogSessionMeta({
          createdAt: "2026-03-05T23:55:57Z",
          updatedAt: "2026-03-05T23:55:57Z",
          turnCount: 1,
          compactCount: 0,
          projectPath: projectRoot,
          modelConfigName: "runtime-kimi-cn-kimi-k2-5",
          modelProvider: "kimi-cn",
          modelSelectionKey: "kimi-k2.5",
          modelId: "kimi-k2.5",
          thinkingLevel: "default",
          cacheHitEnabled: true,
        }),
        entries,
        idAllocator,
      );

      expect(session.currentModelConfigName).toBe("runtime-kimi-cn-kimi-k2-5");
      expect(session.currentModelName).toBe("kimi-k2.5");
      expect(session.primaryAgent.modelConfig.provider).toBe("kimi-cn");
      expect(session.getLogForPersistence().meta).toMatchObject({
        modelConfigName: "runtime-kimi-cn-kimi-k2-5",
        modelProvider: "kimi-cn",
        modelSelectionKey: "kimi-k2.5",
        modelId: "kimi-k2.5",
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("estimates initial input tokens for a fresh session before the first user message", () => {
    const previousHome = process.env["HOME"];
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      process.env["HOME"] = baseDir;
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const expected = (session as any)._estimateInitialApiInputTokens();

      expect(session.lastInputTokens).toBe(expected);
      expect(session.lastTotalTokens).toBe(expected);
      expect(session.lastCacheReadTokens).toBe(0);
    } finally {
      if (previousHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = previousHome;
      }
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("includes tool definitions in the initial input token estimate", async () => {
    const previousHome = process.env["HOME"];
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      process.env["HOME"] = baseDir;
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const tools = [
        {
          name: "write_file",
          description: "Write a file to disk",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      ];
      (session.primaryAgent as any).tools = tools;

      await session.resetForNewSession(store);
      expect(session.lastInputTokens).toBe((session as any)._estimateInitialApiInputTokens());
    } finally {
      if (previousHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = previousHome;
      }
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails restore without mutating the current session when model config is invalid", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store) as any;
      const originalLog = session.log;
      const originalModelConfigName = session.currentModelConfigName;
      const originalThinkingLevel = session.thinkingLevel;
      const originalCacheHitEnabled = session.cacheHitEnabled;

      const entries = [createSystemPrompt("sys-001", "prompt")];
      const idAllocator = new LogIdAllocator();
      idAllocator.restoreFrom(entries);

      expect(() =>
        session.restoreFromLog(
          createLogSessionMeta({
            createdAt: "2026-03-05T23:55:57Z",
            updatedAt: "2026-03-05T23:55:57Z",
            turnCount: 1,
            compactCount: 0,
            projectPath: projectRoot,
            modelConfigName: "missing-model",
          }),
          entries,
          idAllocator,
        )
      ).toThrow("Model config 'missing-model' not found.");

      expect(session.currentModelConfigName).toBe(originalModelConfigName);
      expect(session.thinkingLevel).toBe(originalThinkingLevel);
      expect(session.cacheHitEnabled).toBe(originalCacheHitEnabled);
      expect(session.log).toBe(originalLog);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("preserves a persisted plan internally after resume without re-injecting it into provider messages", async () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store) as any;
      const sessionDir = store.createSession();

      const submit = session._execPlan({
        action: "submit",
        checkpoints: ["Explore auth flow", "Implement fix"],
      });
      expect(submit.content).toContain("Plan submitted with 2 checkpoints.");

      const persisted = session.getLogForPersistence();
      saveLog(sessionDir, persisted.meta, [...persisted.entries]);

      const loaded = loadLog(sessionDir);
      expect(loaded.meta.activePlanCheckpoints).toEqual(["Explore auth flow", "Implement fix"]);

      const restoredStore = new SessionStore({ baseDir, projectPath: projectRoot });
      restoredStore.sessionDir = sessionDir;
      const restored = makeSession(projectRoot, restoredStore) as any;
      restored.restoreFromLog(loaded.meta, loaded.entries, loaded.idAllocator);
      expect(restored._activePlanCheckpoints).toEqual(["Explore auth flow", "Implement fix"]);
      expect(restored._activePlanChecked).toEqual([false, false]);

      restored.primaryAgent.asyncRunWithMessages = async (
        getMessages: () => Array<Record<string, unknown>>,
      ) => {
        const messages = getMessages();
        const injected = messages.find((msg) => String(msg.content ?? "").includes("## Active Plan"));
        expect(injected).toBeUndefined();
        return {
          text: "",
          toolHistory: [],
          totalUsage: { inputTokens: 1, outputTokens: 0 },
          intermediateText: [],
          lastInputTokens: 1,
          reasoningContent: "",
          reasoningState: null,
          lastTotalTokens: 1,
          textHandledInLog: false,
          reasoningHandledInLog: false,
        };
      };

      await restored._runActivation();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not mutate the live session when staged restore preflight fails", () => {
    const baseDir = makeTempDir("longeragent-restore-preflight-base-");
    const projectRoot = makeTempDir("longeragent-restore-preflight-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store) as any;
      const originalLog = structuredClone(session.log);

      const meta = createLogSessionMeta({
        createdAt: "2026-03-01T10:00:00Z",
        turnCount: 1,
        compactCount: 0,
        summary: "resume target",
        modelConfigName: "test-model",
        childSessions: [{
          id: "repo-mapper",
          numericId: 1,
          template: "explorer",
          mode: "persistent",
          teamId: null,
          lifecycle: "live",
          outcome: "completed",
          order: 1,
        }],
      });
      const entries = [
        createSystemPrompt("sys-001", 0, "You are helpful"),
        createTurnStart("ts-001", 1),
        createUserMessage("user-001", 1, "Hello!", "Hello!", { contextId: "c1" }),
        createAssistantText("asst-001", 1, 0, "Hi there!", "Hi there!"),
      ];
      const allocator = new LogIdAllocator();
      allocator.restoreFrom(entries);

      expect(() => session.prepareRestoreFromLog(meta, entries, allocator)).toThrow(
        "Cannot restore child sessions before the session store is bound to the target session directory.",
      );

      expect(session.log).toEqual(originalLog);
      expect(session.getChildSessionSnapshots()).toEqual([]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores the latest tool summary from tool results instead of bare tool names", () => {
    const baseDir = makeTempDir("longeragent-restore-summary-base-");
    const projectRoot = makeTempDir("longeragent-restore-summary-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      store.createSession();
      const session = makeSession(projectRoot, store);

      const entries = [
        createSystemPrompt("sys-001", 0, "You are helpful"),
        createTurnStart("ts-001", 1),
        createUserMessage("user-001", 1, "Coordinate the team.", "Coordinate the team.", { contextId: "c1" }),
        createToolCall(
          "tool-call-001",
          1,
          0,
          "send",
          { id: "call-001", name: "send", arguments: { to: "team-inspector", content: "Inspect the team runtime." } },
          { toolCallId: "call-001", toolName: "send", agentName: "synthesizer", contextId: "c1" },
        ),
        createToolResult(
          "tool-result-001",
          1,
          0,
          {
            toolCallId: "call-001",
            toolName: "send",
            content: "Message sent to 'team-inspector'.",
            toolSummary: "synthesizer sent message to team-inspector",
          },
          { isError: false, contextId: "c1" },
        ),
        createTurnEnd("turn-end-001", 1, "completed"),
      ];
      const allocator = new LogIdAllocator();
      allocator.restoreFrom(entries);
      const meta = createLogSessionMeta({
        createdAt: "2026-03-01T10:00:00Z",
        turnCount: 1,
        compactCount: 0,
        summary: "coordination",
        modelConfigName: "test-model",
      });

      session.restoreFromLog(meta, entries, allocator);

      expect(session.lastToolCallSummary).toBe("synthesizer sent message to team-inspector");
      expect(session.recentSessionEvents[session.recentSessionEvents.length - 1]).toBe(
        "synthesizer sent message to team-inspector",
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps the first user message as persisted session summary after summarize", () => {
    const baseDir = makeTempDir("longeragent-summary-base-");
    const projectRoot = makeTempDir("longeragent-summary-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store) as any;

      const firstUser = createUserMessage("user-001", 1, "First request", "First request", "c1");
      firstUser.summarized = true;
      firstUser.summarizedBy = "sum-001";

      session._log.push(firstUser);
      session._log.push(
        createSummary("sum-001", 1, "Summary text", "Summary text", "c2", ["user-001"], 1),
      );
      session._log.push(
        createUserMessage("user-002", 2, "Later request", "Later request", "c3"),
      );

      const persisted = session.getLogForPersistence();
      expect(persisted.meta.summary).toBe("First request");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("requestTurnInterrupt captures snapshot, kills active workers, and drops unconsumed state", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const workingAbort = new AbortController();
      const finishedAbort = new AbortController();
      const killShell = vi.fn();
      let woke = false;

      (session as any)._inbox = [
        { from: "sub-agent", to: "primary", content: "queued result", timestamp: Date.now() },
      ];
      (session as any)._waitResolver = () => {
        woke = true;
      };
      (session as any)._childSessions.set("working-agent", {
        id: "working-agent",
        numericId: 1,
        template: "explorer",
        mode: "persistent",
        teamId: null,
        lifecycle: "live",
        status: "working",
        phase: "thinking",
        session: { _recordSessionEvent: vi.fn() },
        sessionDir: "",
        artifactsDir: "",
        resultText: "",
        elapsed: 0,
        startTime: performance.now(),
        deliveredResultRevision: 0,
        outputRevision: 0,
        turnPromise: new Promise(() => {}),
        abortController: workingAbort,
        recentEvents: [],
        lifetimeToolCallCount: 0,
        lastToolCallSummary: "",
        lastTotalTokens: 0,
        lastOutcome: "none",
        lastActivityAt: Date.now(),
        order: 1,
      });
      (session as any)._childSessions.set("finished-agent", {
        id: "finished-agent",
        numericId: 2,
        template: "explorer",
        mode: "oneshot",
        teamId: null,
        lifecycle: "completed",
        status: "completed",
        phase: "idle",
        session: { _recordSessionEvent: vi.fn() },
        sessionDir: "",
        artifactsDir: "",
        resultText: "ready but undelivered",
        elapsed: 1,
        startTime: performance.now(),
        deliveredResultRevision: 0,
        outputRevision: 1,
        turnPromise: Promise.resolve(""),
        abortController: finishedAbort,
        recentEvents: [],
        lifetimeToolCallCount: 3,
        lastToolCallSummary: "",
        lastTotalTokens: 0,
        lastOutcome: "completed",
        lastActivityAt: Date.now(),
        order: 2,
      });
      (session as any)._activeShells.set("shell-1", {
        id: "shell-1",
        process: { kill: killShell },
        command: "pnpm dev",
        cwd: projectRoot,
        logPath: join(projectRoot, "shell.log"),
        startTime: performance.now(),
        status: "running",
        exitCode: null,
        signal: null,
        readOffset: 0,
        recentOutput: [],
        explicitKill: false,
      });
      (session as any)._activeAsk = { id: "ask-1", payload: {}, kind: "approval" };
      (session as any)._pendingTurnState = { stage: "pre_user_input" };

      const decision = session.requestTurnInterrupt();

      expect(decision).toEqual({ accepted: true });
      expect(workingAbort.signal.aborted).toBe(true);
      expect(finishedAbort.signal.aborted).toBe(false);
      expect((session as any)._childSessions.size).toBe(2);
      expect(killShell).toHaveBeenCalledWith("SIGTERM");
      expect((session as any)._activeShells.size).toBe(0);
      expect((session as any)._inbox).toEqual([]);
      expect(woke).toBe(true);
      expect((session as any)._waitResolver).toBeNull();
      expect((session as any)._activeAsk).toBeNull();
      expect((session as any)._pendingTurnState).toBeNull();
      expect((session as any)._interruptSnapshot).toMatchObject({
        turnIndex: 0,
        hadActiveAgents: true,
        hadActiveShells: true,
        hadUnconsumed: true,
      });
      expect(String((session as any)._interruptSnapshot.deliveryContent)).toContain("# Sub-Session Brief");
      expect(String((session as any)._interruptSnapshot.deliveryContent)).toContain("# Shell");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("requestTurnInterrupt rejects interruption during compact phase", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);

      (session as any)._compactInProgress = true;
      (session as any)._inbox = [
        { from: "system", to: "primary", content: "queued", timestamp: Date.now() },
      ];

      const decision = session.requestTurnInterrupt();
      expect(decision).toEqual({ accepted: false, reason: "compact_in_progress" });
      expect((session as any)._inbox.length).toBe(1);
      expect((session as any)._interruptSnapshot).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("interruption cleanup drops incomplete reasoning, marks partial text, and closes pending tool calls", () => {
    const baseDir = makeTempDir("longeragent-lifecycle-base-");
    const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      (session as any)._turnCount = 1;
      (session as any)._interruptSnapshot = {
        turnIndex: 1,
        hadActiveAgents: true,
        hadActiveShells: false,
        hadUnconsumed: true,
        deliveryContent: "# Snapshot\nqueued",
      };
      (session as any)._log = [
        createSystemPrompt("sys-001", "prompt"),
        createToolCall(
          "tc-001",
          1,
          0,
          "edit_file src/a.ts",
          { id: "call-1", name: "edit_file", arguments: { path: "src/a.ts" } },
          { toolCallId: "call-1", toolName: "edit_file", agentName: "Primary", contextId: "ctx-a" },
        ),
        createReasoning("rs-001", 1, 1, "thinking", "thinking", undefined, "ctx-r"),
        createAssistantText("as-001", 1, 1, "partial", "partial", "ctx-r"),
      ];
      const logLenBefore = 1;

      (session as any)._handleInterruption(logLenBefore, "partial", { activationCompleted: false });

      const log = (session as any)._log as any[];
      const interruptedText = log.find((e) => e.id === "as-001");
      expect(interruptedText.display).toContain("[Interrupted here.]");
      expect(interruptedText.content).toContain("[Interrupted here.]");

      const reasoning = log.find((e) => e.id === "rs-001");
      expect(reasoning.discarded).toBe(true);

      const interruptedToolResult = log.find((e) => e.type === "tool_result" && e.meta?.toolCallId === "call-1");
      expect(interruptedToolResult).toBeTruthy();
      expect(interruptedToolResult.content.content).toBe("[Interrupted here.]");

      const interruptionUser = log[log.length - 1];
      expect(interruptionUser.type).toBe("user_message");
      expect(String(interruptionUser.display)).toContain("Last turn was interrupted by the user.");
      expect(String(interruptionUser.display)).toContain("Active sub-sessions were interrupted.");
      expect(String(interruptionUser.display)).toContain("[Snapshot]");
      expect(interruptionUser.tuiVisible).toBe(false);
      expect(interruptionUser.displayKind).toBeNull();

      const tuiEntries = projectToTuiEntries(log);
      expect(tuiEntries.some((entry) => entry.text.includes("Last turn was interrupted by the user."))).toBe(false);
      expect(tuiEntries).toEqual([
        { kind: "tool_call", text: "edit_file src/a.ts", id: "tc-001", startedAt: expect.any(Number), elapsedMs: expect.any(Number), meta: { toolName: "edit_file", toolArgs: { path: "src/a.ts" } } },
        { kind: "assistant", text: "partial", id: "as-001" },
        { kind: "interrupted_marker", text: "[Interrupted here.]", id: "as-001:interrupt" },
      ]);

      const apiMessages = projectToApiMessages(log);
      expect(apiMessages.at(-1)).toMatchObject({
        role: "user",
        content: expect.stringContaining("Last turn was interrupted by the user."),
      });
      expect((session as any)._interruptSnapshot).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("formats truncated sub-agent output with line-aware resume guidance", async () => {
      const baseDir = makeTempDir("longeragent-lifecycle-base-");
      const projectRoot = makeTempDir("longeragent-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      stubRunActivation(session, "ok");
      await session.turn("bootstrap");

      const longText = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join("\n");
      const rendered = (session as any)._formatAgentOutput({
        name: "investigator",
        status: "finished",
        text: longText,
        elapsed: 1.2,
      }) as string;

      expect(rendered).toContain("Output truncated at 12,000 chars");
      const m = rendered.match(/line (\d+)\)/);
      expect(m).toBeTruthy();
      const line = Number(m?.[1] ?? "0");
      expect(line).toBeGreaterThan(1);
      expect(rendered).toContain(`read_file(start_line=${line})`);
      expect(rendered).toContain("do not reread the portion already received");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
