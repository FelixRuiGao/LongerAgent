import type { ReconciledConversationEntry } from "../transcript/types.js";

export type PresentationKind =
  | "user"
  | "thinking"
  | "tool_operation"
  | "assistant"
  | "system"
  | "turn_summary";

export type PresentationState = "active" | "done" | "error";

export type ToolCategory =
  | "file-read"
  | "file-modify"
  | "execute"
  | "web"
  | "orchestration"
  | "internal";

export interface InlineResultData {
  text: string;
  dim: boolean;
  maxLines: number;
  toolMetadata?: Record<string, unknown>;
}

export interface PresentationEntry {
  id: string;
  contentVersion: number;
  kind: PresentationKind;
  state: PresentationState;

  // kind=user
  userText?: string;
  userQueued?: boolean;
  userAttachments?: string[];

  // kind=thinking
  thinkingFullText?: string;

  // kind=tool_operation
  toolDisplayName?: string;
  toolCategory?: ToolCategory;
  toolText?: string;
  toolSuffix?: string;
  toolStartedAt?: number;
  toolElapsedMs?: number;
  toolInlineResult?: InlineResultData | null;
  toolResultFullText?: string;
  toolIntentMerged?: boolean;

  // kind=assistant
  assistantText?: string;
  assistantStreaming?: boolean;

  // kind=system
  systemText?: string;
  systemSeverity?: "info" | "error" | "compact" | "interrupted" | "sub_agent";

  // kind=turn_summary
  turnSummaryText?: string;

  // Original entries for detail tab rendering
  sourceEntries?: ReconciledConversationEntry[];
}
