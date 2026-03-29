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

function transformThinking(entry: ReconciledConversationEntry): PresentationEntry {
  return {
    id: entry.id,
    contentVersion: entry.contentVersion,
    kind: "thinking",
    state: "done",
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
): PresentationEntry {
  const toolName = getToolName(callEntry);
  const toolArgs = getToolArgs(callEntry);
  const profile = getToolProfile(toolName);

  let state: PresentationState;
  if (!resultEntry) {
    state = callEntry.entry.elapsedMs != null ? "done" : "active";
  } else {
    state = isToolResultError(resultEntry) ? "error" : "done";
  }

  const resultMeta = resultEntry
    ? ((resultEntry.entry.meta as Record<string, unknown>)?.toolMetadata as Record<string, unknown>) ?? undefined
    : undefined;

  let inlineResult: InlineResultData | null = null;
  if (resultEntry && profile.inlineResult !== false && state !== "active") {
    inlineResult = {
      text: resultEntry.entry.text,
      dim: resultEntry.entry.dim ?? false,
      maxLines: profile.inlineResult.maxLines,
      toolMetadata: resultMeta,
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
    toolDisplayName: profile.displayName,
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
        result.push(transformThinking(entry));
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
        result.push(buildToolOperation(callEntry, resultEntry));
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

  // 3. Activity bridging
  if (processing && result.length > 0) {
    const last = result[result.length - 1];
    if (last.kind === "tool_operation" && last.state === "done") {
      result[result.length - 1] = { ...last, state: "active" };
    }
  }

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
