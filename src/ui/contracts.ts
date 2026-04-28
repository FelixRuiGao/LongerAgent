/**
 * Shared terminal UI contract definitions.
 *
 * These types describe the boundary between the runtime and any terminal UI
 * implementation. They are intentionally renderer-agnostic.
 */

import type { ProgressReporter } from "../progress.js";
import type { PlanCheckpoint } from "../plan-state.js";
import type { SessionStore, LogSessionMeta } from "../persistence.js";
import type {
  PendingAskUi,
  AgentQuestionDecision,
} from "../ask.js";
import type { LogEntry, LogIdAllocator } from "../log-entry.js";
import type { ChildSessionSnapshot } from "../session-tree-types.js";
import type {
  CommandRegistry as ActualCommandRegistry,
  CommandContext,
  SlashCommand as ActualSlashCommand,
  CommandOption as ActualCommandOption,
} from "../commands.js";

export type CommandRegistry = ActualCommandRegistry;
export type SlashCommand = ActualSlashCommand;
export type CommandOption = ActualCommandOption;
export type { CommandContext };

import type { InlineImageInput } from "../session.js";
export type { InlineImageInput };

export interface Session {
  turn(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[] }): Promise<string>;
  close(): Promise<void>;
  requestTurnInterrupt?(): { accepted: boolean; reason?: "compact_in_progress" };
  cancelCurrentTurn?(): void;
  primaryAgent: {
    name: string;
    modelConfig?: {
      name?: string;
      provider?: string;
      model?: string;
      contextLength?: number;
    };
  };
  _progress?: ProgressReporter;
  _turnCount: number;
  _compactCount: number;
  _createdAt?: string;
  lastInputTokens: number;
  lastTotalTokens: number;
  lastCacheReadTokens?: number;
  onSaveRequest?: () => void;
  setStore(store: SessionStore | null): void;
  getPendingAsk(): PendingAskUi | null;
  resolveAgentQuestionAsk?(askId: string, decision: AgentQuestionDecision): void;
  resolveApprovalAsk?(askId: string, choiceIndex: number): void;
  permissionMode?: string;
  hookRuntime?: { hooks: readonly any[]; getAdditionalContext(): string | null };
  getGlobalPreferences?(): any;
  getRewindTargets?(): Array<{ turnIndex: number; entryIndex: number; preview: string; timestamp: number }>;
  rewind?(toTurnIndex: number): { removed: number; error?: string };
  resumePendingTurn?(options?: { signal?: AbortSignal }): Promise<string>;
  hasPendingTurnToResume?(): boolean;
  runManualSummarize?(instruction?: string, options?: { signal?: AbortSignal }): Promise<string>;
  runManualCompact?(instruction?: string, options?: { signal?: AbortSignal }): Promise<void>;
  thinkingLevel?: string;
  currentModelConfigName?: string;
  switchModel?(modelConfigName: string): void;
  config?: { modelNames: string[]; getModel(name: string): { provider: string; model: string; contextLength: number; supportsThinking: boolean; supportsMultimodal: boolean } };
  _resetTransientState(): void;
  _initConversation(): void;
  deliverMessage?(source: "user" | "system", content: string): void;
  log?: readonly LogEntry[];
  subscribeLog?(listener: () => void): () => void;
  getLogRevision?(): number;
  /** The ID of the currently active (streaming/executing) log entry, or null. */
  activeLogEntryId?: string | null;
  getChildSessionSnapshots?(): ChildSessionSnapshot[];
  getChildSessionLog?(childId: string): readonly LogEntry[] | null;
  interruptChildSession?(childId: string): { accepted: boolean; reason?: string };
  interruptAllChildSessions?(): { accepted: boolean; interrupted: number; reason?: string };
  restoreFromLog?(meta: LogSessionMeta, entries: LogEntry[], idAllocator: LogIdAllocator): void;
  getLogForPersistence?(): { meta: LogSessionMeta; entries: readonly LogEntry[] };
  resetForNewSession?(newStore?: any): void;
  appendStatusMessage?(text: string, statusType?: string): void;
  appendErrorMessage?(text: string, errorType?: string): void;
  getAllSkillNames?(): { name: string; description: string; enabled: boolean }[];
  setSkillEnabled?(name: string, enabled: boolean): void;
  reloadSkills?(): { added: string[]; removed: string[]; total: number };
  skills?: ReadonlyMap<string, unknown>;
  getPlanState?(): PlanCheckpoint[];
  subscribePlan?(listener: () => void): () => void;
}

export type ConversationEntryKind =
  | "user"
  | "agent_result"
  | "assistant"
  | "interrupted_marker"
  | "progress"
  | "sub_agent_rollup"
  | "sub_agent_done"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "status"
  | "error"
  | "compact_mark";

export interface ConversationEntry {
  kind: ConversationEntryKind;
  text: string;
  startedAt?: number;
  elapsedMs?: number;
  id?: string;
  queued?: boolean;
  dim?: boolean;
  meta?: Record<string, unknown>;
  /** Full untruncated result text (tool_result only). */
  fullText?: string;
}

export interface LaunchOptions {
  session: Session;
  commandRegistry?: CommandRegistry;
  sessionStore?: SessionStore | null;
  config?: { defaultModel?: string };
}
