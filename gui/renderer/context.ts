import React, { createContext, useContext, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ActiveSessionInfo, CurrentModelDisplay } from "../shared/ipc-protocol.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationEntry {
  id: string;
  kind: string;
  text: string;
  startedAt?: number;
  elapsedMs?: number;
  queued?: boolean;
  dim?: boolean;
  meta?: Record<string, unknown>;
}

export interface TokenInfo {
  inputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  contextBudget?: number;
}

export interface ModelInfo {
  name: string;
  label?: string;
  provider?: string;
}

export interface PendingAsk {
  id: string;
  kind: string;
  createdAt: string;
  summary: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
  options: string[];
}

export type SessionState = "idle" | "thinking" | "tool_calling" | "asking" | "cancelling";

export interface PlanCheckpoint {
  text: string;
  checked: boolean;
}

// ---------------------------------------------------------------------------
// Session Registry Context (lightweight, all sessions)
// ---------------------------------------------------------------------------

export interface SessionRegistryContextValue {
  activeSessions: ActiveSessionInfo[];
  foregroundSessionId: string | null;
  createSession: (projectPath: string) => Promise<string>;
  destroySession: (sessionId: string) => Promise<void>;
  setForeground: (sessionId: string) => void;
  loadSession: (sessionPath: string, projectPath: string) => Promise<string>;
}

const defaultRegistryValue: SessionRegistryContextValue = {
  activeSessions: [],
  foregroundSessionId: null,
  createSession: async () => "",
  destroySession: async () => {},
  setForeground: () => {},
  loadSession: async () => "",
};

export const SessionRegistryContext = createContext<SessionRegistryContextValue>(defaultRegistryValue);
export const useSessionRegistry = (): SessionRegistryContextValue => useContext(SessionRegistryContext);

interface ElectronAPI {
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, callback: (data: any) => void): () => void;
  off(channel: string, callback: (...args: any[]) => void): void;
}

export function SessionRegistryProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [activeSessions, setActiveSessions] = useState<ActiveSessionInfo[]>([]);
  const [foregroundSessionId, setForegroundSessionId] = useState<string | null>(null);

  // Listen for registry events
  useEffect(() => {
    const api = (window as any).api as ElectronAPI | undefined;
    if (!api) return;

    const unsubs: Array<() => void> = [];

    // State changes for all sessions (sidebar indicators)
    unsubs.push(
      api.on("session:stateChanged", (data: { sessionId: string; state: string }) => {
        setActiveSessions((prev) =>
          prev.map((s) => s.sessionId === data.sessionId ? { ...s, state: data.state as any } : s),
        );
      }),
    );

    // New session created
    unsubs.push(
      api.on("session:created", (data: { sessionId: string; projectPath: string }) => {
        setActiveSessions((prev) => [
          ...prev,
          { sessionId: data.sessionId, projectPath: data.projectPath, sessionPath: undefined, state: "idle", title: "", currentModel: "" },
        ]);
      }),
    );

    // Session destroyed
    unsubs.push(
      api.on("session:destroyed", (data: { sessionId: string }) => {
        setActiveSessions((prev) => prev.filter((s) => s.sessionId !== data.sessionId));
      }),
    );

    // Foreground changed
    unsubs.push(
      api.on("session:foregroundChanged", (data: { sessionId: string }) => {
        setForegroundSessionId(data.sessionId);
      }),
    );

    // Load initial state
    api.invoke("session:listActive").then((list: ActiveSessionInfo[]) => {
      if (Array.isArray(list)) setActiveSessions(list);
      // Find the foreground (the main process sets it during setup)
      if (list.length > 0) setForegroundSessionId(list[0].sessionId);
    }).catch(() => {});

    return () => { unsubs.forEach((fn) => fn()); };
  }, []);

  // Actions
  const createSession = useCallback(async (projectPath: string) => {
    const api = (window as any).api as ElectronAPI | undefined;
    if (!api) return "";
    const result = await api.invoke("session:create", projectPath);
    return result.sessionId;
  }, []);

  const destroySession = useCallback(async (sessionId: string) => {
    const api = (window as any).api as ElectronAPI | undefined;
    if (!api) return;
    await api.invoke("session:destroy", sessionId);
  }, []);

  const setForeground = useCallback((sessionId: string) => {
    const api = (window as any).api as ElectronAPI | undefined;
    if (!api) return;
    setForegroundSessionId(sessionId); // optimistic
    api.invoke("session:setForeground", sessionId).catch(() => {});
  }, []);

  const loadSession = useCallback(async (sessionPath: string, projectPath: string) => {
    const api = (window as any).api as ElectronAPI | undefined;
    if (!api) return "";
    const result = await api.invoke("session:loadIntoNew", sessionPath, projectPath);
    return result.sessionId;
  }, []);

  const value: SessionRegistryContextValue = {
    activeSessions,
    foregroundSessionId,
    createSession,
    destroySession,
    setForeground,
    loadSession,
  };

  return React.createElement(SessionRegistryContext.Provider, { value }, children);
}

// ---------------------------------------------------------------------------
// Session Context (foreground session only)
// ---------------------------------------------------------------------------

/** Activity phase — mirrors TUI's ActivityPhase from status-bar.tsx */
export type ActivityPhase = "idle" | "working" | "thinking" | "generating" | "waiting";

export interface SessionContextValue {
  state: SessionState;
  activityPhase: ActivityPhase;
  messages: ConversationEntry[];
  pendingAsk: PendingAsk | null;
  tokenInfo: TokenInfo;
  currentModel: string;
  currentModelDisplay: CurrentModelDisplay | null;
  models: ModelInfo[];
  cwd: string;
  planCheckpoints: PlanCheckpoint[] | null;
  sendMessage: (text: string) => Promise<void>;
  cancelTurn: () => void;
  resolveAsk: (askId: string, decision: Record<string, unknown>) => void;
  switchModel: (name: string) => void;
  resetSession: () => void;
}

const defaultSessionValue: SessionContextValue = {
  state: "idle",
  activityPhase: "idle",
  messages: [],
  pendingAsk: null,
  tokenInfo: { inputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
  currentModel: "",
  currentModelDisplay: null,
  models: [],
  cwd: "",
  planCheckpoints: null,
  sendMessage: async () => {},
  cancelTurn: () => {},
  resolveAsk: () => {},
  switchModel: () => {},
  resetSession: () => {},
};

export const SessionContext = createContext<SessionContextValue>(defaultSessionValue);
export const useSession = (): SessionContextValue => useContext(SessionContext);

// ---------------------------------------------------------------------------
// Session state reducer
// ---------------------------------------------------------------------------

interface SessionReducerState {
  state: SessionState;
  activityPhase: ActivityPhase;
  messages: ConversationEntry[];
  pendingAsk: PendingAsk | null;
  tokenInfo: TokenInfo;
  currentModel: string;
  currentModelDisplay: CurrentModelDisplay | null;
  models: ModelInfo[];
  cwd: string;
  planCheckpoints: PlanCheckpoint[] | null;
}

type SessionAction =
  | { type: "SET_STATE"; payload: SessionState }
  | { type: "SET_ACTIVITY_PHASE"; payload: ActivityPhase }
  | { type: "SET_MESSAGES"; payload: ConversationEntry[] }
  | { type: "SET_PENDING_ASK"; payload: PendingAsk | null }
  | { type: "SET_TOKEN_INFO"; payload: TokenInfo }
  | { type: "SET_CURRENT_MODEL"; payload: { model: string; display: CurrentModelDisplay | null } }
  | { type: "SET_MODELS"; payload: ModelInfo[] }
  | { type: "SET_CWD"; payload: string }
  | { type: "SET_PLAN_CHECKPOINTS"; payload: PlanCheckpoint[] | null }
  | { type: "RESET" };

const initialReducerState: SessionReducerState = {
  state: "idle",
  activityPhase: "idle",
  messages: [],
  pendingAsk: null,
  tokenInfo: { inputTokens: 0, totalTokens: 0, cacheReadTokens: 0 },
  currentModel: "",
  currentModelDisplay: null,
  models: [],
  cwd: "",
  planCheckpoints: null,
};

function sessionReducer(
  prevState: SessionReducerState,
  action: SessionAction,
): SessionReducerState {
  switch (action.type) {
    case "SET_STATE":
      return { ...prevState, state: action.payload };
    case "SET_ACTIVITY_PHASE":
      return { ...prevState, activityPhase: action.payload };
    case "SET_MESSAGES":
      return { ...prevState, messages: action.payload };
    case "SET_PENDING_ASK":
      return { ...prevState, pendingAsk: action.payload };
    case "SET_TOKEN_INFO":
      return { ...prevState, tokenInfo: action.payload };
    case "SET_CURRENT_MODEL":
      return {
        ...prevState,
        currentModel: action.payload.model,
        currentModelDisplay: action.payload.display,
      };
    case "SET_MODELS":
      return { ...prevState, models: action.payload };
    case "SET_CWD":
      return { ...prevState, cwd: action.payload };
    case "SET_PLAN_CHECKPOINTS":
      return { ...prevState, planCheckpoints: action.payload };
    case "RESET":
      return { ...initialReducerState, models: prevState.models, cwd: prevState.cwd };
    default:
      return prevState;
  }
}

// ---------------------------------------------------------------------------
// Session Provider (scoped to foreground session)
// ---------------------------------------------------------------------------

export function SessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { foregroundSessionId } = useSessionRegistry();
  const [s, dispatch] = useReducer(sessionReducer, initialReducerState);

  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // Track foreground ID in a ref so event handlers always see the latest
  const fgIdRef = useRef(foregroundSessionId);

  // When foreground changes: update ref immediately and reset state.
  // The main process setForeground() will then push fresh data via events.
  if (fgIdRef.current !== foregroundSessionId) {
    fgIdRef.current = foregroundSessionId;
    // Synchronous reset so stale data doesn't flash
    dispatch({ type: "RESET" });
  }

  // ---- Activity phase management (mirrors TUI's setTransientActivity / setStableActivity) ----
  const activityFallbackSeqRef = useRef(0);
  const activityFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ACTIVITY_DETAIL_FALLBACK_MS = 3000;

  const clearActivityFallback = useCallback(() => {
    activityFallbackSeqRef.current += 1;
    if (activityFallbackTimerRef.current) {
      clearTimeout(activityFallbackTimerRef.current);
      activityFallbackTimerRef.current = null;
    }
  }, []);

  const setStableActivity = useCallback((phase: "idle" | "working" | "waiting") => {
    clearActivityFallback();
    dispatch({ type: "SET_ACTIVITY_PHASE", payload: phase });
  }, [clearActivityFallback]);

  const setTransientActivity = useCallback((phase: "thinking" | "generating") => {
    clearActivityFallback();
    const seq = activityFallbackSeqRef.current;
    dispatch({ type: "SET_ACTIVITY_PHASE", payload: phase });
    activityFallbackTimerRef.current = setTimeout(() => {
      if (activityFallbackSeqRef.current !== seq) return;
      activityFallbackTimerRef.current = null;
      dispatch({ type: "SET_ACTIVITY_PHASE", payload: "working" });
    }, ACTIVITY_DETAIL_FALLBACK_MS);
  }, [clearActivityFallback]);

  // ---- IPC subscriptions (filtered by foreground sessionId) ----
  useEffect(() => {
    const api = (window as any).api as ElectronAPI | undefined;
    if (!api) return;

    const unsubs: Array<() => void> = [];

    unsubs.push(
      api.on("session:foregroundChanged", (data: any) => {
        if (data.projectPath) {
          dispatchRef.current({ type: "SET_CWD", payload: data.projectPath });
        }
      }),
    );

    unsubs.push(
      api.on("log:updated", (data: any) => {
        if (data.sessionId !== fgIdRef.current) return;
        dispatchRef.current({ type: "SET_MESSAGES", payload: data.entries });
      }),
    );

    unsubs.push(
      api.on("progress:event", (evt: any) => {
        if (evt.sessionId !== fgIdRef.current) return;
        const hasSubAgentId = evt.extra?.sub_agent_id !== undefined;

        // Activity phase updates (primary agent only, same as TUI)
        if (!hasSubAgentId) {
          switch (evt.action) {
            case "reasoning_chunk":
              setTransientActivity("thinking");
              break;
            case "text_chunk":
              setTransientActivity("generating");
              break;
            case "tool_call":
              setStableActivity("working");
              break;
            case "agent_no_reply":
              setStableActivity("waiting");
              break;
          }
        }

        // Ask events
        if (evt.action === "ask_requested") {
          setStableActivity("waiting");
        }

        // Plan panel
        if (evt.action === "plan_submit" || evt.action === "plan_update") {
          const cps = evt.extra?.checkpoints as PlanCheckpoint[] | undefined;
          if (cps) dispatchRef.current({ type: "SET_PLAN_CHECKPOINTS", payload: cps });
        } else if (evt.action === "plan_finish") {
          dispatchRef.current({ type: "SET_PLAN_CHECKPOINTS", payload: null });
        }
      }),
    );

    unsubs.push(
      api.on("session:stateChanged", (data: any) => {
        if (data.sessionId !== fgIdRef.current) return;
        dispatchRef.current({ type: "SET_STATE", payload: data.state });
        // Sync activity phase with session state
        if (data.state === "idle") {
          setStableActivity("idle");
        } else if (data.state === "thinking") {
          // Initial "thinking" state from turn start — will be refined by progress events
          setStableActivity("working");
        }
      }),
    );

    unsubs.push(
      api.on("ask:pending", (data: any) => {
        if (data.sessionId !== fgIdRef.current) return;
        dispatchRef.current({ type: "SET_PENDING_ASK", payload: data.ask ?? null });
        if (data.ask) {
          dispatchRef.current({ type: "SET_STATE", payload: "asking" });
        }
      }),
    );

    unsubs.push(
      api.on("token:update", (data: any) => {
        if (data.sessionId !== fgIdRef.current) return;
        dispatchRef.current({
          type: "SET_TOKEN_INFO",
          payload: {
            inputTokens: data.inputTokens,
            totalTokens: data.totalTokens,
            cacheReadTokens: data.cacheReadTokens,
            contextBudget: data.contextBudget,
          },
        });
      }),
    );

    unsubs.push(
      api.on("session:modelChanged", (data: any) => {
        if (data.sessionId !== fgIdRef.current) return;
        dispatchRef.current({
          type: "SET_CURRENT_MODEL",
          payload: { model: data.model, display: data.display ?? null },
        });
      }),
    );

    // Load initial models (global)
    api.invoke("session:getModels").then((models: ModelInfo[]) => {
      if (Array.isArray(models)) {
        dispatchRef.current({ type: "SET_MODELS", payload: models });
      }
    }).catch(() => {});

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, []);

  // ---- Actions (pass foreground sessionId) ----
  const sendMessage = useCallback(async (text: string) => {
    const api = (window as any).api as ElectronAPI | undefined;
    const sid = fgIdRef.current;
    if (!api || !sid) return;
    dispatch({ type: "SET_STATE", payload: "thinking" });
    try {
      await api.invoke("session:turn", sid, text);
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      dispatch({ type: "SET_STATE", payload: "idle" });
      dispatch({
        type: "SET_MESSAGES",
        payload: [
          ...s.messages,
          { id: `__user_${Date.now()}`, kind: "user", text },
          { id: `__error_${Date.now()}`, kind: "error", text: errorText },
        ],
      });
    }
  }, [s.messages]);

  const cancelTurn = useCallback(() => {
    const api = (window as any).api as ElectronAPI | undefined;
    const sid = fgIdRef.current;
    if (!api || !sid) return;
    api.invoke("session:cancel", sid).catch(() => {});
  }, []);

  const resolveAsk = useCallback((askId: string, decision: Record<string, unknown>) => {
    const api = (window as any).api as ElectronAPI | undefined;
    const sid = fgIdRef.current;
    if (!api || !sid) return;
    api.invoke("ask:resolve", sid, askId, decision).catch(() => {});
    dispatch({ type: "SET_PENDING_ASK", payload: null });
  }, []);

  const switchModel = useCallback((name: string) => {
    const api = (window as any).api as ElectronAPI | undefined;
    const sid = fgIdRef.current;
    if (!api || !sid) return;
    api.invoke("session:switchModel", sid, name).catch(() => {});
  }, []);

  const resetSession = useCallback(() => {
    const api = (window as any).api as ElectronAPI | undefined;
    const sid = fgIdRef.current;
    if (!api || !sid) return;
    api.invoke("session:reset", sid).then(() => {
      dispatch({ type: "RESET" });
    }).catch(() => {});
  }, []);

  const contextValue: SessionContextValue = {
    state: s.state,
    activityPhase: s.activityPhase,
    messages: s.messages,
    pendingAsk: s.pendingAsk,
    tokenInfo: s.tokenInfo,
    currentModel: s.currentModel,
    currentModelDisplay: s.currentModelDisplay,
    models: s.models,
    cwd: s.cwd,
    planCheckpoints: s.planCheckpoints,
    sendMessage,
    cancelTurn,
    resolveAsk,
    switchModel,
    resetSession,
  };

  return React.createElement(SessionContext.Provider, { value: contextValue }, children);
}
