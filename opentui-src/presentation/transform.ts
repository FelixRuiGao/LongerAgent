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
  // Only mark as error when explicitly tagged true
  if (meta.isError === true) return true;
  if (meta.isError === false) return false;
  // Fallback: only for very explicit error patterns
  const text = entry.entry.text;
  return text.startsWith("ERROR:") || text.startsWith("Error:");
}

// ------------------------------------------------------------------
// Intent buffer types
// ------------------------------------------------------------------

interface IntentBufferEntry {
  callEntry: ReconciledConversationEntry;
  resultEntry: ReconciledConversationEntry | null;
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
  overrides?: { intentMerged?: boolean; displayNameOverride?: string },
): PresentationEntry {
  const toolName = getToolName(callEntry);
  const toolArgs = getToolArgs(callEntry);
  const profile = getToolProfile(toolName);

  let state: PresentationState;
  if (!resultEntry) {
    // No result yet — active unless elapsedMs is set (tuiVisible=false result)
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
    toolDisplayName: overrides?.displayNameOverride ?? profile.displayName,
    toolCategory: profile.category,
    toolText: profile.text(toolArgs),
    toolSuffix: profile.suffix?.(resultMeta) ?? "",
    toolStartedAt: callEntry.entry.startedAt,
    toolElapsedMs: callEntry.entry.elapsedMs,
    toolInlineResult: inlineResult,
    toolResultFullText: resultEntry?.entry.text,
    toolIntentMerged: overrides?.intentMerged,
    sourceEntries,
  };
}

function flushIntentBuffer(buffer: IntentBufferEntry): PresentationEntry {
  const pe = buildToolOperation(buffer.callEntry, buffer.resultEntry);
  pe.state = "error";
  return pe;
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

  let intentBuffer: IntentBufferEntry | null = null;
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];
    const kind = entry.entry.kind;

    // 1. Skip hidden tools (wait)
    if (kind === "tool_call") {
      const toolName = getToolName(entry);
      if (HIDDEN_TOOLS.has(toolName)) {
        i++;
        // Also skip following tool_result if present
        if (i < entries.length && entries[i].entry.kind === "tool_result") {
          i++;
        }
        continue;
      }
    }

    // 2. Flush intent buffer if next entry doesn't match
    if (intentBuffer && kind === "tool_call") {
      const nextToolName = getToolName(entry);
      if (nextToolName !== "spawn" && nextToolName !== "spawn_file") {
        result.push(flushIntentBuffer(intentBuffer));
        intentBuffer = null;
      }
    } else if (intentBuffer && kind !== "tool_call" && kind !== "tool_result") {
      // Non-tool entry after intent buffer — flush as error
      result.push(flushIntentBuffer(intentBuffer));
      intentBuffer = null;
    }

    // 3. Route by kind
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
        // Determine if this is the last assistant entry and streaming
        const isLastAssistant = processing && !entries.slice(i + 1).some(
          (e) => e.entry.kind === "assistant" || e.entry.kind === "tool_call" || e.entry.kind === "reasoning",
        );
        result.push(transformAssistant(entry, isLastAssistant));
        i++;
        break;
      }

      case "tool_call": {
        const toolName = getToolName(entry);
        const toolArgs = getToolArgs(entry);

        // Intent buffering for write_file/edit_file with intent="spawn"
        if (
          (toolName === "write_file" || toolName === "edit_file") &&
          toolArgs.intent === "spawn"
        ) {
          const callEntry = entry;
          i++;
          let resultEntry: ReconciledConversationEntry | null = null;
          if (i < entries.length && entries[i].entry.kind === "tool_result") {
            resultEntry = entries[i];
            i++;
          }
          intentBuffer = { callEntry, resultEntry };
          break;
        }

        // Intent fulfillment for spawn/spawn_file
        if (intentBuffer && (toolName === "spawn" || toolName === "spawn_file")) {
          const spawnCallEntry = entry;
          i++;
          let spawnResultEntry: ReconciledConversationEntry | null = null;
          if (i < entries.length && entries[i].entry.kind === "tool_result") {
            spawnResultEntry = entries[i];
            i++;
          }
          // Merge: use spawn's call but combine source entries
          const pe = buildToolOperation(spawnCallEntry, spawnResultEntry, {
            intentMerged: true,
          });
          if (intentBuffer.callEntry) {
            pe.sourceEntries = [
              intentBuffer.callEntry,
              ...(intentBuffer.resultEntry ? [intentBuffer.resultEntry] : []),
              ...(pe.sourceEntries ?? []),
            ];
          }
          result.push(pe);
          intentBuffer = null;
          break;
        }

        // Normal: pair tool_call with following tool_result
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
        // Orphan tool_result — render as system
        result.push(transformSystem(entry));
        i++;
        break;
      }

      default: {
        // status, error, compact_mark, interrupted_marker, progress,
        // sub_agent_rollup, sub_agent_done
        result.push(transformSystem(entry));
        i++;
        break;
      }
    }
  }

  // 4. Flush remaining intent buffer as error
  if (intentBuffer) {
    result.push(flushIntentBuffer(intentBuffer));
    intentBuffer = null;
  }

  // 5. Activity bridging: if processing and last entry is a done tool_operation,
  //    keep it showing as active so the spinner persists
  if (processing && result.length > 0) {
    const last = result[result.length - 1];
    if (last.kind === "tool_operation" && last.state === "done") {
      result[result.length - 1] = { ...last, state: "active" };
    }
  }

  // 6. Memo optimization: reuse previous PresentationEntry by id+contentVersion
  for (let j = 0; j < result.length; j++) {
    const pe = result[j];
    const prev = prevById.get(pe.id);
    if (prev && prev.contentVersion === pe.contentVersion && prev.state === pe.state) {
      result[j] = prev;
    }
  }

  return result;
}
