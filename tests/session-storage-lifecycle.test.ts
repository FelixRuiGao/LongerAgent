import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, mock, spyOn } from "bun:test";
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
    const baseDir = makeTempDir("fermi-prefs-base-");
    const projectRoot = makeTempDir("fermi-prefs-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      store.saveGlobalPreferences({
        version: 1,
        modelConfigName: "my-openrouter",
        modelProvider: "openrouter",
        modelSelectionKey: "moonshotai/kimi-k2.5",
        modelId: "moonshotai/kimi-k2.5",
        thinkingLevel: "high",
      });

      expect(store.loadGlobalPreferences()).toEqual(
        expect.objectContaining({
          modelConfigName: "my-openrouter",
          modelProvider: "openrouter",
          modelSelectionKey: "moonshotai/kimi-k2.5",
          modelId: "moonshotai/kimi-k2.5",
          thinkingLevel: "high",
          }),
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("constructs with a store that has no active session directory", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
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
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
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
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
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
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
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
      });

      session.resetForNewSession(store);

      expect(session.thinkingLevel).toBe("high");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not carry archived child session metadata into a /new session", async () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store) as any;

      session._saveChildSession = mock();
      session._childSessions.set("reviewer-crm-dashboard", {
        id: "reviewer-crm-dashboard",
        numericId: 1,
        template: "reviewer",
        mode: "oneshot",
        lifecycle: "idle",
        status: "idle",
        phase: "idle",
        session: { _inbox: [] },
        sessionDir: join(projectRoot, "old-child-session"),
        artifactsDir: join(projectRoot, "old-child-session", "artifacts"),
        resultText: "",
        elapsed: 0,
        startTime: 0,
        turnPromise: null,
        abortController: null,
        recentEvents: [],
        lifetimeToolCallCount: 0,
        lastToolCallSummary: "",
        lastTotalTokens: 0,
        lastOutcome: "none",
        lastActivityAt: Date.now(),
        order: 1,
        suspended: false,
        settlePromise: null,
        settleResolve: null,
      });

      store.clearSession();
      await session.resetForNewSession(store);

      expect(session._childSessions.size).toBe(0);
      expect(session._archivedChildren.size).toBe(0);
      expect(session.getLogForPersistence().meta.childSessions).toEqual([]);

      const newSessionDir = store.createSession();
      const persisted = session.getLogForPersistence();
      saveLog(newSessionDir, persisted.meta, [...persisted.entries]);

      const restored = loadLog(newSessionDir);
      expect(restored.meta.childSessions ?? []).toEqual([]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores cache-read token counters from log", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
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

  it("restores token counters from the latest non-zero token update", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const entries = [
        createSystemPrompt("sys-001", "prompt"),
        createTokenUpdate("tok-001", 1, 7171, 6912, 0, 7510),
        createTokenUpdate("tok-002", 2, 0, 0, 0, 0),
      ];
      const idAllocator = new LogIdAllocator();
      idAllocator.restoreFrom(entries);

      session.restoreFromLog?.(
        createLogSessionMeta({
          createdAt: "2026-03-05T23:55:57Z",
          updatedAt: "2026-03-05T23:55:57Z",
          turnCount: 2,
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

  it("ignores zero token updates from providers", async () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      session.lastInputTokens = 7171;
      session.lastTotalTokens = 7510;

      (session.primaryAgent as any).asyncRunWithMessages = async (...args: unknown[]) => {
        const onTokenUpdate = args[14] as ((inputTokens: number, usage?: { totalTokens?: number; cacheReadTokens?: number }) => void) | undefined;
        onTokenUpdate?.(0, { totalTokens: 0, cacheReadTokens: 0 });
        return {
          text: "",
          toolHistory: [],
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          intermediateText: [],
          lastInputTokens: 0,
          reasoningContent: "",
          reasoningState: null,
          lastTotalTokens: 0,
          textHandledInLog: false,
          reasoningHandledInLog: false,
        };
      };

      await (session as any)._runActivation();

      expect(session.lastInputTokens).toBe(7171);
      expect(session.lastTotalTokens).toBe(7510);
      expect(session.log.some((entry) => entry.type === "token_update")).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not reset token counters when an activation finishes without usage", async () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      session.lastInputTokens = 7171;
      session.lastTotalTokens = 7510;

      (session as any)._runActivation = async () => ({
        text: "ok",
        toolHistory: [],
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        intermediateText: [],
        lastInputTokens: 0,
        reasoningContent: "",
        reasoningState: null,
        lastTotalTokens: 0,
        textHandledInLog: false,
        reasoningHandledInLog: false,
        endedWithoutToolCalls: true,
      });

      await session.turn("hello");

      expect(session.lastInputTokens).toBe(7171);
      expect(session.lastTotalTokens).toBe(7510);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores model config before thinking/cache state from log", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
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

      session.restoreFromLog(
        createLogSessionMeta({
          createdAt: "2026-03-05T23:55:57Z",
          updatedAt: "2026-03-05T23:55:57Z",
          turnCount: 1,
          compactCount: 0,
          projectPath: projectRoot,
          modelConfigName: "restored-model",
          thinkingLevel: "high",
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
      expect(session._preferredThinkingLevel).toBe("high");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("reconstructs runtime model configs from persisted model identity", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
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

  it("starts a fresh session with zero input tokens before the first user message", () => {
    const previousHome = process.env["HOME"];
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      process.env["HOME"] = baseDir;
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);

      expect(session.lastInputTokens).toBe(0);
      expect(session.lastTotalTokens).toBe(0);
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

  it("applies context budget percent to the main session budget", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);

      session.applySettings({ context_budget_percent: 50 }, {});

      expect(session.contextBudget).toBe(4096);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not inherit main context budget percent into child sessions", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      store.createSession();
      const session = makeSession(projectRoot, store, {
        modelConfigs: {
          "test-model": {
            name: "test-model",
            provider: "openai",
            model: "gpt-5.2",
            apiKey: "sk-test",
            maxTokens: 256,
            contextLength: 1_000_000,
            supportsMultimodal: false,
          },
        },
      });
      session.applySettings({ context_budget_percent: 20 }, {});

      const childAgent = {
        name: "Child",
        systemPrompt: "child",
        tools: [],
        maxToolRounds: 1,
        modelConfig: {
          name: "test-model",
          provider: "openai",
          model: "gpt-5.2",
          apiKey: "sk-test",
          maxTokens: 256,
          contextLength: 128_000,
          supportsMultimodal: false,
        },
        _provider: { budgetCalcMode: "full_context" },
        replaceModelConfig(next: any) {
          this.modelConfig = next;
        },
      } as any;

      const handle = (session as any)._instantiateChildSession("worker-1", "main", "persistent", childAgent);

      expect(session.contextBudget).toBe(200_000);
      expect(handle.session.contextBudget).toBe(128_000);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails restore without mutating the current session when model config is invalid", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store) as any;
      const originalLog = session.log;
      const originalModelConfigName = session.currentModelConfigName;
      const originalThinkingLevel = session.thinkingLevel;

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
      expect(session.log).toBe(originalLog);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not mutate the live session when staged restore preflight fails", () => {
    const baseDir = makeTempDir("fermi-restore-preflight-base-");
    const projectRoot = makeTempDir("fermi-restore-preflight-project-");
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
          lifecycle: "idle",
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
    const baseDir = makeTempDir("fermi-restore-summary-base-");
    const projectRoot = makeTempDir("fermi-restore-summary-project-");
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
    const baseDir = makeTempDir("fermi-summary-base-");
    const projectRoot = makeTempDir("fermi-summary-project-");
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

  it("requestTurnInterrupt cascades to running children and drops pending state", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      const workingAbort = new AbortController();
      const finishedAbort = new AbortController();
      const killShell = mock();
      let woke = false;

      (session as any)._inbox = [
        { type: "system_notice", sender: "system", content: "queued result", timestamp: Date.now() },
      ];
      (session as any)._waitHandle = { resolve: () => { woke = true; } };
      (session as any)._childSessions.set("working-agent", {
        id: "working-agent",
        numericId: 1,
        template: "explorer",
        mode: "persistent",
        lifecycle: "running",
        status: "working",
        phase: "thinking",
        session: { _recordSessionEvent: mock() },
        sessionDir: "",
        artifactsDir: "",
        resultText: "",
        elapsed: 0,
        startTime: performance.now(),
        turnPromise: new Promise(() => {}),
        abortController: workingAbort,
        recentEvents: [],
        lifetimeToolCallCount: 0,
        lastToolCallSummary: "",
        lastTotalTokens: 0,
        lastOutcome: "none",
        lastActivityAt: Date.now(),
        order: 1,
        suspended: false,
        settlePromise: null,
        settleResolve: null,
      });
      (session as any)._childSessions.set("finished-agent", {
        id: "finished-agent",
        numericId: 2,
        template: "explorer",
        mode: "oneshot",
        lifecycle: "archived",
        status: "completed",
        phase: "idle",
        session: { _recordSessionEvent: mock() },
        sessionDir: "",
        artifactsDir: "",
        resultText: "ready but undelivered",
        elapsed: 1,
        startTime: performance.now(),
        turnPromise: Promise.resolve(""),
        abortController: finishedAbort,
        recentEvents: [],
        lifetimeToolCallCount: 3,
        lastToolCallSummary: "",
        lastTotalTokens: 0,
        lastOutcome: "completed",
        lastActivityAt: Date.now(),
        order: 2,
        suspended: false,
        settlePromise: null,
        settleResolve: null,
      });
      (session as any)._shellManager._activeShells.set("shell-1", {
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

      // requestTurnInterrupt aborts main turn only — no cascade to children or shells
      expect(decision).toEqual({ accepted: true });
      expect((session as any)._activeAsk).toBeNull();
      expect((session as any)._pendingTurnState).toBeNull();
      // Children and shells are NOT killed by requestTurnInterrupt (use interruptAllChildAgents / killAllShells separately)
      expect(workingAbort.signal.aborted).toBe(false);
      expect(finishedAbort.signal.aborted).toBe(false);
      expect(killShell).not.toHaveBeenCalled();
      // Inbox is preserved (sub-agent messages should not be discarded)
      expect((session as any)._inbox.length).toBe(1);

      // Explicit cascade via interruptAllChildAgents
      session.interruptAllChildAgents();
      expect((session as any)._childSessions.get("working-agent")?.terminationCause).toBe("user_mass_interrupt");
      session.killAllShells();
      expect(killShell).toHaveBeenCalledWith("SIGTERM");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("requestTurnInterrupt rejects interruption during compact phase", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);

      (session as any)._compactInProgress = true;
      (session as any)._inbox = [
        { type: "system_notice" as const, sender: "system", content: "queued", timestamp: Date.now() },
      ];

      const decision = session.requestTurnInterrupt();
      expect(decision).toEqual({ accepted: false, reason: "compact_in_progress" });
      expect((session as any)._inbox.length).toBe(1);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("interruption cleanup drops incomplete reasoning, marks partial text, and closes pending tool calls", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      (session as any)._turnCount = 1;
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
      // Partial text is kept without suffix
      const interruptedText = log.find((e) => e.id === "as-001");
      expect(interruptedText.display).toBe("partial");
      expect(interruptedText.content).toBe("partial");

      const reasoning = log.find((e) => e.id === "rs-001");
      expect(reasoning.discarded).toBe(true);

      const interruptedToolResult = log.find((e) => e.type === "tool_result" && e.meta?.toolCallId === "call-1");
      expect(interruptedToolResult).toBeTruthy();
      expect(interruptedToolResult.content.content).toBe("[Interrupted] Tool was not executed.");
      // Interrupted tool_result now has previewText → tuiVisible
      expect(interruptedToolResult.tuiVisible).toBe(true);

      // [Interrupted here.] marker exists for API protocol but hidden from TUI
      const markerEntry = log.find((e) => e.type === "assistant_text" && String(e.display) === "[Interrupted here.]");
      expect(markerEntry).toBeTruthy();
      expect(markerEntry.tuiVisible).toBe(false);

      const interruptionUser = log[log.length - 1];
      expect(interruptionUser.type).toBe("user_message");
      expect(String(interruptionUser.display)).toBe("Last turn was interrupted by the user.");
      expect(interruptionUser.tuiVisible).toBe(false);
      expect(interruptionUser.displayKind).toBeNull();

      const tuiEntries = projectToTuiEntries(log);
      expect(tuiEntries.some((entry) => entry.text.includes("Last turn was interrupted by the user."))).toBe(false);
      expect(tuiEntries).toEqual([
        {
          kind: "tool_call",
          text: "edit_file src/a.ts",
          id: "tc-001",
          startedAt: expect.any(Number),
          elapsedMs: expect.any(Number),
          meta: {
            toolCallId: "call-1",
            toolName: "edit_file",
            toolArgs: { path: "src/a.ts" },
            rawArguments: "{\"path\":\"src/a.ts\"}",
          },
        },
        { kind: "assistant", text: "partial", id: "as-001" },
        { kind: "tool_result", text: "[Interrupted] Tool was not executed.", fullText: "[Interrupted] Tool was not executed.", id: expect.any(String), dim: true, meta: { toolCallId: "call-1", toolName: "edit_file", isError: false } },
      ]);

      const apiMessages = projectToApiMessages(log);
      expect(apiMessages.at(-1)).toMatchObject({
        role: "user",
        content: "Last turn was interrupted by the user.",
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("formats truncated sub-agent output with line-aware resume guidance", async () => {
      const baseDir = makeTempDir("fermi-lifecycle-base-");
      const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      stubRunActivation(session, "ok");
      await session.turn("bootstrap");

      const longText = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join("\n");
      const rendered = (session as any)._buildAgentResultApiContent(
        {
          id: "investigator",
          resultText: longText,
        },
        "completed",
        "natural",
      ) as { content: string; fullOutputPath?: string };

      expect(rendered.content).toContain("Output truncated at 12,000 chars");
      const m = rendered.content.match(/line (\d+)\)/);
      expect(m).toBeTruthy();
      const line = Number(m?.[1] ?? "0");
      expect(line).toBeGreaterThan(1);
      expect(rendered.content).toContain(`read_file(start_line=${line})`);
      expect(rendered.content).toContain("do not reread the portion already received");
      expect(rendered.fullOutputPath).toBe("artifacts/agent-outputs/investigator.md");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not mark safe interrupted tools as having partial effects", () => {
    const baseDir = makeTempDir("fermi-lifecycle-base-");
    const projectRoot = makeTempDir("fermi-lifecycle-project-");
    try {
      const store = new SessionStore({ baseDir, projectPath: projectRoot });
      const session = makeSession(projectRoot, store);
      (session as any)._turnCount = 1;
      (session as any)._log = [
        createSystemPrompt("sys-001", "prompt"),
        createToolCall(
          "tc-001",
          1,
          0,
          "await_event 60s",
          { id: "await-event-1", name: "await_event", arguments: { seconds: 60 } },
          { toolCallId: "await-event-1", toolName: "await_event", agentName: "Primary", contextId: "ctx-w" },
        ),
      ];
      ((session as any)._log[1].meta as Record<string, unknown>).toolExecState = "running";

      (session as any)._completeMissingToolResultsFromLog(1, "[Interrupted] Tool was not executed.");

      const toolResult = ((session as any)._log as any[]).find((entry) => entry.type === "tool_result");
      expect(toolResult).toBeTruthy();
      expect(toolResult.display).toBe("[Interrupted] Tool execution was interrupted.");
      const hints = (session as any)._collectInterruptHints();
      expect(hints).not.toContain("Some tools may have had partial effects.");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
