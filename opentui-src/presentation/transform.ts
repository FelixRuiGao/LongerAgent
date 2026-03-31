import type { ReconciledConversationEntry } from "../transcript/types.js";
import type {
  PresentationEntry,
  PresentationState,
  InlineResultData,
} from "./types.js";
import { getToolProfile, HIDDEN_TOOLS } from "./tool-profiles.js";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const QUEUED_PREFIX = "[Queued user message]\n";
const MANUAL_SUMMARIZE = "[Manual summarize request]";
const ATTACHMENT_REGEX = /--- Begin content of (.+?) ---/g;

function extractUserText(raw: string): { text: string; queued: boolean } {
  if (raw.startsWith(QUEUED_PREFIX)) {
    return { text: raw.slice(QUEUED_PREFIX.length), queued: true };
  }
  if (raw === MANUAL_SUMMARIZE) {
    return { text: "/summarize", queued: false };
  }
  return { text: raw, queued: false };
}

function extractAttachments(raw: string): string[] {
  const attachments: string[] = [];
  let match: RegExpExecArray | null;
  ATTACHMENT_REGEX.lastIndex = 0;
  while ((match = ATTACHMENT_REGEX.exec(raw)) !== null) {
    attachments.push(match[1]);
  }
  return attachments;
}

function getMeta(entry: ReconciledConversationEntry): Record<string, unknown> {
  return (entry.entry.meta as Record<string, unknown>) ?? {};
}

function getToolArgs(entry: ReconciledConversationEntry): Record<string, unknown> {
  return (getMeta(entry).toolArgs as Record<string, unknown>) ?? {};
}

function getToolName(entry: ReconciledConversationEntry): string {
  return (getMeta(entry).toolName as string) ?? "";
}

function isToolResultError(entry: ReconciledConversationEntry): boolean {
  const meta = getMeta(entry);
  if (meta.isError === true) return true;
  if (meta.isError === false) return false;
  const text = entry.entry.text;
  return text.startsWith("ERROR:") || text.startsWith("Error:");
}

function isToolResultInterrupted(entry: ReconciledConversationEntry): boolean {
  return entry.entry.text.startsWith("[Interrupted]");
}

// ------------------------------------------------------------------
// Transform functions
// ------------------------------------------------------------------

function transformUser(entry: ReconciledConversationEntry): PresentationEntry {
  const { text, queued } = extractUserText(entry.entry.text);
  const attachments = extractAttachments(entry.entry.text);

  return {
    id: entry.id,
    contentVersion: entry.contentVersion,
    kind: "user",
    state: "done",
    userText: text,
    userQueued: queued || entry.entry.queued || false,
    userAttachments: attachments.length > 0 ? attachments : undefined,
  };
}

function transformThinking(entry: ReconciledConversationEntry, active: boolean): PresentationEntry {
  return {
    id: entry.id,
    contentVersion: entry.contentVersion,
    kind: "thinking",
    state: active ? "active" : "done",
    thinkingFullText: entry.entry.text,
  };
}

function transformAssistant(
  entry: ReconciledConversationEntry,
  streaming: boolean,
): PresentationEntry {
  return {
    id: entry.id,
    contentVersion: entry.contentVersion,
    kind: "assistant",
    state: streaming ? "active" : "done",
    assistantText: entry.entry.text,
    assistantStreaming: streaming,
  };
}

function transformSystem(entry: ReconciledConversationEntry): PresentationEntry {
  const kind = entry.entry.kind;
  let severity: PresentationEntry["systemSeverity"] = "info";
  if (kind === "error") severity = "error";
  else if (kind === "compact_mark") severity = "compact";
  else if (kind === "interrupted_marker") severity = "interrupted";
  else if (kind === "sub_agent_rollup" || kind === "sub_agent_done") severity = "sub_agent";

  return {
    id: entry.id,
    contentVersion: entry.contentVersion,
    kind: "system",
    state: "done",
    systemText: entry.entry.text,
    systemSeverity: severity,
  };
}

function buildToolOperation(
  callEntry: ReconciledConversationEntry,
  resultEntry: ReconciledConversationEntry | null,
  activeEntryId: string | null = null,
): PresentationEntry {
  const toolName = getToolName(callEntry);
  const toolArgs = getToolArgs(callEntry);
  const profile = getToolProfile(toolName);

  let state: PresentationState;
  if (activeEntryId && activeEntryId === callEntry.id) {
    state = "active";
  } else if (!resultEntry) {
    // If another entry is active (streaming/executing), this one is queued — show as done
    state = (callEntry.entry.elapsedMs != null || activeEntryId) ? "done" : "active";
  } else if (isToolResultError(resultEntry)) {
    state = "error";
  } else if (isToolResultInterrupted(resultEntry)) {
    state = "error";
  } else {
    state = "done";
  }

  const resultMeta = resultEntry
    ? ((resultEntry.entry.meta as Record<string, unknown>)?.toolMetadata as Record<string, unknown>) ?? undefined
    : undefined;

  // Resolve dynamic display name for write_file variants
  let displayName = profile.displayName;
  let noDiffBackground = false;
  if (toolName === "write_file" && resultMeta) {
    if (resultMeta.isAppend === true) {
      displayName = "Append";
    } else if (resultMeta.isNewFile === true) {
      displayName = "Create";
      noDiffBackground = true;
    } else if (resultMeta.isNewFile === false) {
      displayName = "Overwrite";
      noDiffBackground = true;
    }
  }

  let inlineResult: InlineResultData | null = null;
  if (resultEntry && profile.inlineResult !== false && state !== "active") {
    inlineResult = {
      text: resultEntry.entry.text,
      dim: resultEntry.entry.dim ?? false,
      maxLines: profile.inlineResult.maxLines,
      toolMetadata: resultMeta,
      noDiffBackground: noDiffBackground || undefined,
    };
  }

  const sourceEntries: ReconciledConversationEntry[] = [callEntry];
  if (resultEntry) sourceEntries.push(resultEntry);

  return {
    id: callEntry.id,
    contentVersion: resultEntry
      ? Math.max(callEntry.contentVersion, resultEntry.contentVersion)
      : callEntry.contentVersion,
    kind: "tool_operation",
    state,
    toolDisplayName: displayName,
    toolCategory: profile.category,
    toolText: profile.text(toolArgs),
    toolSuffix: profile.suffix?.(resultMeta) ?? "",
    toolStartedAt: callEntry.entry.startedAt,
    toolElapsedMs: callEntry.entry.elapsedMs,
    toolInlineResult: inlineResult,
    toolResultFullText: resultEntry?.entry.text,
    sourceEntries,
  };
}

// ------------------------------------------------------------------
// Main transform
// ------------------------------------------------------------------

export function presentationTransform(
  entries: ReconciledConversationEntry[],
  previousOutput: PresentationEntry[],
  processing: boolean,
  activeEntryId: string | null = null,
): PresentationEntry[] {
  const result: PresentationEntry[] = [];
  const prevById = new Map<string, PresentationEntry>();
  for (const pe of previousOutput) {
    prevById.set(pe.id, pe);
  }

  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];
    const kind = entry.entry.kind;

    // 1. Skip hidden tools (wait)
    if (kind === "tool_call") {
      const toolName = getToolName(entry);
      if (HIDDEN_TOOLS.has(toolName)) {
        i++;
        if (i < entries.length && entries[i].entry.kind === "tool_result") {
          i++;
        }
        continue;
      }
    }

    // 2. Route by kind
    switch (kind) {
      case "user": {
        result.push(transformUser(entry));
        i++;
        break;
      }

      case "reasoning": {
        const reasoningComplete = getMeta(entry).reasoningComplete === true;
        let thinkingState: PresentationState;
        if (activeEntryId && activeEntryId === entry.id) {
          thinkingState = "active";
        } else if (!reasoningComplete && !processing) {
          thinkingState = "error"; // interrupted — not transmitted to model
        } else {
          thinkingState = "done";
        }
        result.push(transformThinking(entry, thinkingState === "active"));
        i++;
        break;
      }

      case "assistant": {
        const isLastAssistant = processing && !entries.slice(i + 1).some(
          (e) => e.entry.kind === "assistant" || e.entry.kind === "tool_call" || e.entry.kind === "reasoning",
        );
        result.push(transformAssistant(entry, isLastAssistant));
        i++;
        break;
      }

      case "tool_call": {
        const callEntry = entry;
        i++;
        let resultEntry: ReconciledConversationEntry | null = null;
        if (i < entries.length && entries[i].entry.kind === "tool_result") {
          resultEntry = entries[i];
          i++;
        }
        result.push(buildToolOperation(callEntry, resultEntry, activeEntryId));
        break;
      }

      case "tool_result": {
        result.push(transformSystem(entry));
        i++;
        break;
      }

      default: {
        result.push(transformSystem(entry));
        i++;
        break;
      }
    }
  }

  // 3. Activity bridging — removed. Replaced by system active indicator in input area.

  // 4. Memo optimization: reuse previous PresentationEntry by id+contentVersion
  for (let j = 0; j < result.length; j++) {
    const pe = result[j];
    const prev = prevById.get(pe.id);
    if (prev && prev.contentVersion === pe.contentVersion && prev.state === pe.state) {
      result[j] = prev;
    }
  }

  return result;
}
