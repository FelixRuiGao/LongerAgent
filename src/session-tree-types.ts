export type ChildSessionMode = "oneshot" | "persistent";

export type ChildSessionLifecycle = "running" | "blocked" | "idle" | "archived";

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
  modelDisplayLabel?: string;
  pendingAskId?: string | null;
  pendingAskKind?: "agent_question" | "approval" | null;
  activeLogEntryId: string | null;
  turnElapsed: number;
  cacheReadTokens: number;
}

export interface ChildSessionMetaRecord {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  lifecycle: ChildSessionLifecycle;
  outcome?: ChildSessionOutcome;
  order: number;
  inbox?: MessageEnvelope[];
}

/** Message type determines rendering category — not the sender string. */
export type MessageType = "user_input" | "peer_message" | "system_notice";

/** Typed message envelope for inter-session communication. */
export interface MessageEnvelope {
  type: MessageType;
  sender: string;        // display only — not used for routing
  content: string;
  timestamp: number;
  /** When true, the TUI entry created from this message is visible to the user. Default: false for system_notice/peer_message. */
  tuiVisible?: boolean;
  /** Stable input entry created when the user submitted the message. */
  inputId?: string;
  /** User-visible input index. Present for real user input. */
  inputIndex?: number;
  /** Context id assigned to the input before delivery to the model. */
  contextId?: string;
}

/**
 * @deprecated Use MessageEnvelope. Kept as alias during migration.
 */
export type AgentMessage = MessageEnvelope;

/** Record kept for archived children (Session instance released). */
export interface ArchivedChildRecord {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  outcome: ChildSessionOutcome;
  order: number;
  sessionDir: string;
  artifactsDir: string;
}
