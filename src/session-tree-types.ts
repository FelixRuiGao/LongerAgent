export type ChildSessionMode = "oneshot" | "persistent";

export type ChildSessionLifecycle = "live" | "completed" | "terminated";

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
}
