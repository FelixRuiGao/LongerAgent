export type ChildSessionMode = "oneshot" | "persistent";

export type ChildSessionLifecycle = "running" | "idle" | "archived";

export type ChildSessionPhase =
  | "idle"
  | "thinking"
  | "tool_calling"
  | "generating"
  | "waiting";

export type ChildSessionOutcome =
  | "none"
  | "completed"
  | "interrupted"
  | "error";

export interface ChildSessionSnapshot {
  id: string;
  numericId: number;
  logRevision: number;
  template: string;
  mode: ChildSessionMode;
  teamId: string | null;
  lifecycle: ChildSessionLifecycle;
  phase: ChildSessionPhase;
  outcome: ChildSessionOutcome;
  running: boolean;
  lifetimeToolCallCount: number;
  lastTotalTokens: number;
  lastToolCallSummary: string;
  recentEvents: string[];
  pendingInboxCount: number;
  lastActivityAt: number;
  // Phase 1 Step 3: child page chrome fields
  inputTokens: number;
  contextBudget: number;
  modelConfigName: string;
  modelProvider: string;
  activeLogEntryId: string | null;
  turnElapsed: number;
  cacheReadTokens: number;
}

export interface ChildSessionMetaRecord {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  teamId?: string | null;
  lifecycle: ChildSessionLifecycle;
  outcome?: ChildSessionOutcome;
  order: number;
  inbox?: AgentMessage[];
}

/** Minimal message envelope for inter-agent communication. */
export interface AgentMessage {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

/** Record kept for archived children (Session instance released). */
export interface ArchivedChildRecord {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  teamId: string | null;
  outcome: ChildSessionOutcome;
  order: number;
  sessionDir: string;
  artifactsDir: string;
}
