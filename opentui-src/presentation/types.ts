import type { ReconciledConversationEntry } from "../transcript/types.js";
import type { FileModifyDisplayData } from "../../src/diff-hunk.js";

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
  /** When true, diff lines are rendered without red/green background (for Create/Overwrite). */
  noDiffBackground?: boolean;
}

export interface ToolStreamSectionData {
  key: string;
  label: string;
  text: string;
  complete: boolean;
  contextBefore?: string;
  contextAfter?: string;
  contextResolved?: boolean;
  /** 1-indexed starting line number for this section (from file content probing). */
  startLineNumber?: number;
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
  toolStreamSections?: ToolStreamSectionData[];
  toolRepairedFromPartial?: boolean;
  toolExecState?: string;
  toolStreamState?: string;
  toolStreamLanguage?: string;
  toolStreamMode?: "replace" | "append" | "write";

  // kind=assistant
  assistantText?: string;
  assistantStreaming?: boolean;

  // kind=system
  systemText?: string;
  systemSeverity?: "info" | "error" | "compact" | "interrupted" | "sub_agent" | "no_reply";

  // kind=turn_summary
  turnSummaryText?: string;

  // Unified file-modify display data (replaces toolStreamSections for file-modify tools)
  fileModifyData?: FileModifyDisplayData;

  // Original entries for detail tab rendering
  sourceEntries?: ReconciledConversationEntry[];
}
