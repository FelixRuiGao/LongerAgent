import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, mock, spyOn } from "bun:test";

import type { PendingAskUi } from "../src/ask.js";
import { Session } from "../src/session.js";
import { LogIdAllocator, createToolCall } from "../src/log-entry.js";
import { ToolResult } from "../src/providers/base.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSessionLike(): any {
  const s = Object.create(Session.prototype) as any;
  s.primaryAgent = {
    name: "Primary",
    modelConfig: {
      name: "runtime-openai-codex-gpt-5.4",
      provider: "openai-codex",
      model: "gpt-5.4",
      supportsMultimodal: false,
      contextLength: 1000,
    },
  };
  s._childSessions = new Map();
  s._archivedChildren = new Map();
  s._inbox = [];
  s._log = [];
  s._idAllocator = new LogIdAllocator();
  s._turnCount = 1;
  s._activeAsk = null;
  s._askHistory = [];
  s._pendingTurnState = null;
  s._currentTurnSignal = null;
  s._logListeners = new Set();
  s._usedContextIds = new Set();
  s._activeLogEntryId = null;
  s._projectRoot = process.cwd();
  s._progress = undefined;
  s._permissionAdvisor = {
    _allowOnceGrants: new Set(),
    grantAllowOnce: mock(),
    acceptOffer: mock(),
  };
  s.hookRuntime = {
    hooks: [],
    evaluate: mock(),
    fireAndForget: mock(),
  };
  s._emitAskResolvedProgress = mock();
  s._emitAskRequestedProgress = mock();
  s._appendEntry = function appendEntry(entry: any): void {
    this._log.push(entry);
  };
  s._nextLogId = function nextLogId(type: any): string {
    return this._idAllocator.next(type);
  };
  s._allocateContextId = mock(() => "ctx-allocated");
  s._findToolCallContextId = mock((_toolCallId: string, _roundIndex?: number) => "ctx-tool");
  s._updateToolCallExecState = mock();
  s._notifyLogListeners = mock();
  s._saveChildSession = mock();
  s.onSaveRequest = mock();
  return s;
}

function makePendingApproval(id = "approval-child"): PendingAskUi {
  return {
    id,
    kind: "approval",
    createdAt: new Date(0).toISOString(),
    summary: "Allow tool?",
    source: { agentId: "worker-1", agentName: "worker-1" },
    payload: {
      toolCallId: "tool-1",
      toolName: "write_file",
      toolSummary: "worker writes",
      permissionClass: "write",
      offers: [{ type: "tool_once", label: "Allow once" }],
    },
    options: ["Allow once", "Deny"],
  };
}

function makeChildSession(overrides: Record<string, unknown> = {}): any {
  const pendingAsk = overrides.pendingAsk === undefined
    ? makePendingApproval()
    : overrides.pendingAsk as PendingAskUi | null;
  const hasPendingTurnToResume = Boolean(overrides.hasPendingTurnToResume);
  const rest = { ...overrides };
  delete rest.pendingAsk;
  delete rest.hasPendingTurnToResume;
  return {
    primaryAgent: {
      modelConfig: {
        name: "runtime-openai-codex-gpt-5.4",
        provider: "openai-codex",
        model: "gpt-5.4",
        contextLength: 1000,
      },
    },
    lastTurnEndStatus: overrides.lastTurnEndStatus ?? null,
    lastInputTokens: 10,
    lastTotalTokens: 20,
    lastCacheReadTokens: 0,
    contextBudget: 900,
    activeLogEntryId: null,
    currentTurnRunning: false,
    sessionPhase: "idle",
    lifetimeToolCallCount: 1,
    lastToolCallSummary: "write_file",
    recentSessionEvents: [],
    pendingInboxCount: 0,
    getLogRevision: () => 7,
    getPendingAsk: mock(() => pendingAsk),
    hasPendingTurnToResume: mock(() => hasPendingTurnToResume),
    resolveApprovalAsk: mock(),
    resumePendingTurn: mock(async () => "resumed"),
    requestTurnInterrupt: mock(() => ({ accepted: true })),
    _normalizeInterruptedTurnFromLog: mock(),
    _deliverMessage: mock(),
    ...rest,
  };
}

function makeHandle(childSession: any): any {
  return {
    id: "worker-1",
    numericId: 1,
    template: "explorer",
    mode: "oneshot",
    lifecycle: "running",
    status: "working",
    phase: "thinking",
    session: childSession,
    sessionDir: "",
    artifactsDir: "",
    resultText: "partial result",
    elapsed: 0,
    startTime: performance.now(),
    turnPromise: Promise.resolve(""),
    abortController: new AbortController(),
    recentEvents: [],
    lifetimeToolCallCount: 1,
    lastToolCallSummary: "write_file",
    lastTotalTokens: 20,
    lastOutcome: "none",
    lastActivityAt: Date.now(),
    order: 1,
    suspended: false,
    settlePromise: null,
    settleResolve: mock(),
  };
}

describe("child approval routing", () => {
  it("bubbles child pending approval through root getPendingAsk", () => {
    const root = makeSessionLike();
    const child = makeChildSession();
    root._childSessions.set("worker-1", makeHandle(child));

    expect(root.getPendingAsk()).toMatchObject({
      id: "approval-child",
      kind: "approval",
      source: { agentId: "worker-1" },
    });
  });

  it("routes approval resolution to the child and resumes the child turn", () => {
    const root = makeSessionLike();
    const child = makeChildSession({ hasPendingTurnToResume: true });
    const handle = makeHandle(child);
    handle.turnPromise = null;
    root._childSessions.set("worker-1", handle);

    root.resolveApprovalAsk("approval-child", 0);

    expect(child.resolveApprovalAsk).toHaveBeenCalledWith("approval-child", 0);
    expect(child.resumePendingTurn).toHaveBeenCalledOnce();
    expect(handle.lifecycle).toBe("running");
    expect(handle.status).toBe("working");
    expect(root._notifyLogListeners).toHaveBeenCalled();
  });

  it("does not produce an agent_result when a child turn stops for approval", () => {
    const root = makeSessionLike();
    const child = makeChildSession();
    const handle = makeHandle(child);
    root._childSessions.set("worker-1", handle);

    root._finishChildTurn(handle);

    expect(handle.lifecycle).toBe("blocked");
    expect(handle.status).toBe("idle");
    expect(handle.phase).toBe("waiting");
    expect(handle.lastOutcome).toBe("none");
    expect(root._log.some((entry: any) => entry.type === "agent_result")).toBe(false);
    expect(root._saveChildSession).toHaveBeenCalledWith(handle);
  });

  it("notifies the parent inbox when a child blocks on approval", () => {
    const root = makeSessionLike();
    root._agentState = "working";
    const child = makeChildSession();
    const handle = makeHandle(child);
    root._childSessions.set("worker-1", handle);

    root._finishChildTurn(handle);

    expect(root._inbox).toHaveLength(1);
    expect(root._inbox[0]).toMatchObject({
      type: "system_notice",
      sender: "system",
      content: expect.stringContaining("waiting for user approval"),
    });
    expect(handle.lifecycle).toBe("blocked");
    expect(root._hasActiveAgents()).toBe(false);
  });

  it("can interrupt a blocked child without treating it as a working child", () => {
    const root = makeSessionLike();
    const child = makeChildSession();
    const handle = makeHandle(child);
    handle.lifecycle = "blocked";
    handle.status = "idle";
    handle.phase = "waiting";
    handle.turnPromise = null;
    handle.abortController = null;
    root._childSessions.set("worker-1", handle);

    const decision = root.interruptChildSession("worker-1");

    expect(decision).toEqual({ accepted: true });
    expect(child._normalizeInterruptedTurnFromLog).toHaveBeenCalledWith(
      "Sub-agent was interrupted while waiting for user approval.",
    );
    expect(child.requestTurnInterrupt).toHaveBeenCalledOnce();
    expect(handle.lifecycle).toBe("archived");
    expect(handle.lastOutcome).toBe("interrupted");
    expect(root._hasActiveAgents()).toBe(false);
  });

  it("rejects sends to blocked children until approval is resolved", () => {
    const root = makeSessionLike();
    const child = makeChildSession();
    const handle = makeHandle(child);
    handle.mode = "persistent";
    handle.lifecycle = "blocked";
    handle.status = "idle";
    handle.phase = "waiting";
    handle.turnPromise = null;
    root._childSessions.set("worker-1", handle);

    const result = root._sendMessageToChild("worker-1", {
      type: "user_input",
      sender: "main",
      content: "new info",
      timestamp: Date.now(),
    });

    expect(result.content).toContain("waiting for user approval");
    expect(result.content).toMatch(/^ERROR:/);
    expect(child._deliverMessage).not.toHaveBeenCalled();
  });

  it("propagates permission mode changes to existing child sessions", () => {
    const root = makeSessionLike();
    const child = makeChildSession({ permissionMode: "reversible" });
    const handle = makeHandle(child);
    root._childSessions.set("worker-1", handle);

    root.permissionMode = "read_only";

    expect(root._permissionAdvisor.sessionMode).toBe("read_only");
    expect(child.permissionMode).toBe("read_only");
  });

  it("creates child sessions with the parent permission mode", () => {
    const artifactsDir = makeTempDir("fermi-child-permission-");
    try {
      const root = makeSessionLike();
      root._sessionArtifactsOverride = artifactsDir;
      root._subAgentCounter = 0;
      root._promptsDirs = undefined;
      root.config = { mcpServerConfigs: [] };
      root._permissionAdvisor.sessionMode = "read_only";
      const agent = {
        name: "worker",
        description: "",
        systemPrompt: "worker prompt",
        tools: [],
        modelConfig: {
          name: "test-model",
          provider: "openai",
          model: "gpt-5.4",
          apiKey: "sk-test",
          supportsMultimodal: false,
          contextLength: 8192,
        },
      };

      const handle = root._instantiateChildSession("worker-1", "explorer", "persistent", agent);

      expect(handle.session.permissionMode).toBe("read_only");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("includes pending ask state and display label in child snapshots", () => {
    const root = makeSessionLike();
    const child = makeChildSession();
    const handle = makeHandle(child);

    const snapshot = root._buildChildSessionSnapshot(handle);

    expect(snapshot.pendingAskId).toBe("approval-child");
    expect(snapshot.pendingAskKind).toBe("approval");
    expect(snapshot.phase).toBe("waiting");
    expect(snapshot.modelDisplayLabel).not.toMatch(/^runtime-/);
  });

  it("delivers completed child output through inbox while keeping agent_result display-only", () => {
    const root = makeSessionLike();
    root._agentState = "waiting";
    const child = makeChildSession({ pendingAsk: null, lastTurnEndStatus: "completed" });
    const handle = makeHandle(child);
    handle.resultText = "child says done";
    root._childSessions.set("worker-1", handle);

    root._finishChildTurn(handle);

    const agentResult = root._log.find((entry: any) => entry.type === "agent_result");
    expect(agentResult).toBeTruthy();
    expect(agentResult.apiRole).toBeNull();
    expect(root._inbox).toHaveLength(1);
    expect(root._inbox[0]).toMatchObject({
      type: "peer_message",
      sender: "worker-1",
      content: expect.stringContaining("child says done"),
    });
  });

  it("keeps mass-interrupted child completions out of the parent inbox", () => {
    const root = makeSessionLike();
    root._agentState = "working";
    const child = makeChildSession({ pendingAsk: null, lastTurnEndStatus: "interrupted" });
    const handle = makeHandle(child);
    handle.resultText = "interrupted";
    handle.terminationCause = "user_mass_interrupt";
    root._childSessions.set("worker-1", handle);

    root._finishChildTurn(handle);

    const agentResult = root._log.find((entry: any) => entry.type === "agent_result");
    expect(agentResult).toBeTruthy();
    expect(root._inbox).toHaveLength(0);
  });

  it("passes the active abort signal into approval-resumed tool execution", async () => {
    const root = makeSessionLike();
    const abortController = new AbortController();
    root._currentTurnSignal = abortController.signal;
    root._log.push(createToolCall(
      "tc-001",
      1,
      0,
      "write_file",
      { id: "tool-1", name: "write_file", arguments: { path: "a.txt" } },
      { toolCallId: "tool-1", toolName: "write_file", agentName: "Primary", contextId: "ctx-tool" },
    ));

    const executor = mock(async (_args: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => {
      expect(ctx?.signal).toBe(abortController.signal);
      return new ToolResult({ content: "ok" });
    });
    root._toolExecutors = { write_file: executor };
    root._beforeToolExecute = mock(async () => undefined);

    const suspended = await root._drainPendingToolCalls();

    expect(suspended).toBe(false);
    expect(executor).toHaveBeenCalledOnce();
  });
});
