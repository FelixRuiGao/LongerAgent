/**
 * RPC method bindings for Session.
 *
 * Maps a curated subset of `Session` methods/properties to JSON-RPC method
 * names. Each binding takes raw `params` (as JSON value) and returns a
 * JSON-serializable result.
 *
 * Also subscribes to Session log/state changes and emits events to the peer.
 */

import type { RpcServer } from "./rpc-transport.js";
import type { Session } from "../session.js";
import type { LogEntry } from "../log-entry.js";

export interface SessionRpcOptions {
  readonly session: Session;
  readonly server: RpcServer;
  readonly sessionDir: string | null;
  readonly workDir: string;
  /** Called when the server has fully shut down. */
  readonly onShutdown: () => Promise<void>;
}

/** A snapshot of a log entry suitable for JSON serialization. */
type SerializedLogEntry = LogEntry;

interface MetaPayload {
  readonly title: string | undefined;
  readonly displayName: string;
  readonly sessionDir: string | null;
  readonly workDir: string;
  readonly modelConfigName: string;
  readonly modelProvider: string;
  readonly thinkingLevel: string;
  readonly accentColor: string | undefined;
  readonly turnCount: number;
}

interface StatusPayload {
  readonly currentTurnRunning: boolean;
  readonly sessionPhase: string;
  readonly lastTurnEndStatus: string | null;
  readonly pendingInboxCount: number;
  readonly lifetimeToolCallCount: number;
  readonly lastToolCallSummary: string;
  readonly lastInputTokens: number;
  readonly lastTotalTokens: number;
  readonly lastCacheReadTokens: number;
  readonly contextBudget: number;
  readonly activeLogEntryId: string | null;
  readonly hasPendingTurn: boolean;
}

function buildMeta(s: Session, workDir: string, sessionDir: string | null): MetaPayload {
  return {
    title: s.getTitle(),
    displayName: s.getDisplayName(),
    sessionDir,
    workDir,
    modelConfigName: s.currentModelConfigName ?? "",
    modelProvider: s.primaryAgent?.modelConfig?.provider ?? "",
    thinkingLevel: s.thinkingLevel ?? "none",
    accentColor: s.accentColor,
    turnCount: s._turnCount,
  };
}

function buildStatus(s: Session): StatusPayload {
  return {
    currentTurnRunning: s.currentTurnRunning,
    sessionPhase: s.sessionPhase,
    lastTurnEndStatus: s.lastTurnEndStatus,
    pendingInboxCount: s.pendingInboxCount,
    lifetimeToolCallCount: s.lifetimeToolCallCount,
    lastToolCallSummary: s.lastToolCallSummary,
    lastInputTokens: s.lastInputTokens,
    lastTotalTokens: s.lastTotalTokens,
    lastCacheReadTokens: s.lastCacheReadTokens,
    contextBudget: s.contextBudget,
    activeLogEntryId: s.activeLogEntryId,
    hasPendingTurn: s.hasPendingTurnToResume(),
  };
}

function expectObject(params: unknown, method: string): Record<string, unknown> {
  if (params == null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${method}: params must be an object`);
  }
  return params as Record<string, unknown>;
}

function expectString(params: Record<string, unknown>, key: string, method: string): string {
  const v = params[key];
  if (typeof v !== "string") throw new Error(`${method}: '${key}' must be a string`);
  return v;
}

function optString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

function optNumber(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Register all session-related RPC handlers on the given server, and wire
 * up event emission for log changes and state transitions.
 */
export function registerSessionRpc(opts: SessionRpcOptions): { dispose: () => void } {
  const { session, server, workDir, sessionDir, onShutdown } = opts;
  const disposers: Array<() => void> = [];

  // ── Lifecycle ──
  server.on("server.hello", () => ({
    name: "fermi-server",
    version: 1,
    capabilities: ["session.submitTurn", "session.getLogSnapshot", "session.subscribe"],
  }));

  server.on("server.shutdown", async () => {
    // Schedule the shutdown so we can return a response first.
    setImmediate(() => {
      void onShutdown();
    });
    return { ok: true };
  });

  // ── Session metadata ──
  server.on("session.getMeta", () => buildMeta(session, workDir, sessionDir));
  server.on("session.getStatus", () => buildStatus(session));

  // ── Log access ──
  server.on("session.getLogRevision", () => session.getLogRevision());

  server.on("session.getLogSnapshot", (params) => {
    const p = expectObject(params, "session.getLogSnapshot");
    const sinceRevision = optNumber(p, "sinceRevision");
    // Always return the full log since we don't track per-entry revision.
    // The `sinceRevision` arg is reserved for future incremental updates.
    void sinceRevision;
    const entries: SerializedLogEntry[] = [...session.log];
    return {
      revision: session.getLogRevision(),
      entries,
      activeLogEntryId: session.activeLogEntryId,
    };
  });

  server.on("session.getChildLog", (params) => {
    const p = expectObject(params, "session.getChildLog");
    const childId = expectString(p, "childId", "session.getChildLog");
    const entries = session.getChildSessionLog(childId);
    return entries ? [...entries] : null;
  });

  server.on("session.getChildSnapshots", () => session.getChildSessionSnapshots());

  server.on("session.getPlanState", () => session.getPlanState());

  // ── Turn submission ──
  server.on("session.submitTurn", (params) => {
    const p = expectObject(params, "session.submitTurn");
    const input = expectString(p, "input", "session.submitTurn");
    // Fire-and-forget: do not block the RPC response on the turn completion.
    // The peer subscribes to log events to observe progress.
    void (async () => {
      try {
        server.emit("turn.started", { input, turnCount: session._turnCount + 1 });
        await session.turn(input);
        server.emit("turn.ended", {
          status: session.lastTurnEndStatus ?? "completed",
          turnCount: session._turnCount,
        });
      } catch (err) {
        server.emit("turn.ended", {
          status: "error",
          turnCount: session._turnCount,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return { ok: true };
  });

  server.on("session.resumePendingTurn", () => {
    void (async () => {
      try {
        server.emit("turn.started", { resumed: true, turnCount: session._turnCount });
        await session.resumePendingTurn();
        server.emit("turn.ended", {
          status: session.lastTurnEndStatus ?? "completed",
          turnCount: session._turnCount,
        });
      } catch (err) {
        server.emit("turn.ended", {
          status: "error",
          turnCount: session._turnCount,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return { ok: true };
  });

  server.on("session.requestTurnInterrupt", () => session.requestTurnInterrupt());
  server.on("session.cancelCurrentTurn", () => {
    session.cancelCurrentTurn();
    return { ok: true };
  });

  // ── Ask resolution ──
  server.on("session.getPendingAsk", () => session.getPendingAsk());

  server.on("session.resolveApprovalAsk", (params) => {
    const p = expectObject(params, "session.resolveApprovalAsk");
    const askId = expectString(p, "askId", "session.resolveApprovalAsk");
    const choiceIndex = optNumber(p, "choiceIndex") ?? 0;
    session.resolveApprovalAsk(askId, choiceIndex);
    return { ok: true };
  });

  server.on("session.resolveAgentQuestionAsk", (params) => {
    const p = expectObject(params, "session.resolveAgentQuestionAsk");
    const askId = expectString(p, "askId", "session.resolveAgentQuestionAsk");
    const decision = p["decision"] as { answers: unknown[] } | undefined;
    if (!decision || !Array.isArray(decision.answers)) {
      throw new Error("session.resolveAgentQuestionAsk: 'decision.answers' must be an array");
    }
    session.resolveAgentQuestionAsk(askId, decision as never);
    return { ok: true };
  });

  // ── Model selection ──
  server.on("session.listAvailableModels", () => {
    const cfg = session.config;
    return cfg.modelNames.map((name) => {
      const m = cfg.getModel(name);
      return {
        name,
        provider: m.provider,
        model: m.model,
        contextLength: m.contextLength,
        supportsThinking: m.supportsThinking,
        supportsMultimodal: m.supportsMultimodal,
      };
    });
  });

  server.on("session.selectModel", (params) => {
    const p = expectObject(params, "session.selectModel");
    const name = expectString(p, "name", "session.selectModel");
    session.switchModel(name);
    server.emit("model.changed", { name });
    return buildMeta(session, workDir, sessionDir);
  });

  // ── Skills ──
  server.on("session.listSkills", () => session.getAllSkillNames());
  server.on("session.setSkillEnabled", (params) => {
    const p = expectObject(params, "session.setSkillEnabled");
    const name = expectString(p, "name", "session.setSkillEnabled");
    const enabled = p["enabled"] === true;
    session.setSkillEnabled(name, enabled);
    return { ok: true };
  });

  // ── Title ──
  server.on("session.setTitle", (params) => {
    const p = expectObject(params, "session.setTitle");
    const title = expectString(p, "title", "session.setTitle");
    session.setTitle(title);
    return { ok: true };
  });

  // ── Manual context commands ──
  server.on("session.summarize", (params) => {
    const p = expectObject(params, "session.summarize");
    const targetContextIds = p["targetContextIds"] as string[] | undefined;
    const focusPrompt = optString(p, "focusPrompt");
    void session.runManualSummarize({ targetContextIds: targetContextIds ?? undefined, focusPrompt: focusPrompt ?? undefined }).catch((err) => {
      server.emit("turn.ended", {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { ok: true };
  });

  server.on("session.compact", (params) => {
    const p = expectObject(params, "session.compact");
    const instruction = optString(p, "instruction");
    void session.runManualCompact(instruction).catch((err) => {
      server.emit("turn.ended", {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { ok: true };
  });

  // ── Rewind ──
  server.on("session.getRewindTargets", () => session.getRewindTargets());
  server.on("session.rewind", (params) => {
    const p = expectObject(params, "session.rewind");
    const toTurnIndex = optNumber(p, "toTurnIndex");
    if (typeof toTurnIndex !== "number") {
      throw new Error("session.rewind: 'toTurnIndex' must be a number");
    }
    return session.rewind(toTurnIndex);
  });

  // ── Subscriptions ──
  // Coalesce log change emissions: TUI fires subscribeLog hundreds of times
  // per turn. We schedule a microtask that emits once with the latest revision.
  let pendingLogEmit = false;
  let lastEmittedRevision = -1;
  const onLogChange = (): void => {
    if (pendingLogEmit) return;
    pendingLogEmit = true;
    queueMicrotask(() => {
      pendingLogEmit = false;
      const revision = session.getLogRevision();
      if (revision === lastEmittedRevision) return;
      lastEmittedRevision = revision;
      server.emit("log.changed", {
        revision,
        activeLogEntryId: session.activeLogEntryId,
        status: buildStatus(session),
      });
    });
  };
  const unsubscribeLog = session.subscribeLog(onLogChange);
  disposers.push(unsubscribeLog);

  const onPlanChange = (): void => {
    server.emit("plan.changed", { state: session.getPlanState() });
  };
  const unsubscribePlan = session.subscribePlan(onPlanChange);
  disposers.push(unsubscribePlan);

  // Ask polling — Session doesn't expose a subscription, so we poll on every
  // log change (asks always create log entries). The renderer also calls
  // session.getPendingAsk on demand.
  let lastAskId: string | null = null;
  const onLogChangeForAsk = (): void => {
    const ask = session.getPendingAsk();
    const askId = ask?.id ?? null;
    if (askId !== lastAskId) {
      lastAskId = askId;
      if (ask) server.emit("ask.pending", ask);
      else server.emit("ask.resolved", {});
    }
  };
  const unsubscribeAsk = session.subscribeLog(onLogChangeForAsk);
  disposers.push(unsubscribeAsk);

  // Save-on-checkpoint: Session expects an external persister.
  session.onSaveRequest = () => {
    // The store persists automatically on checkpoint; nothing to do here
    // unless we want to emit a "saved" event for the GUI to show.
    server.emit("session.saved", { revision: session.getLogRevision() });
  };

  return {
    dispose: () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
          // ignore
        }
      }
    },
  };
}
