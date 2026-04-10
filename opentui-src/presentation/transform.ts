import type { ReconciledConversationEntry } from "../transcript/types.js";
import type {
  PresentationEntry,
  PresentationState,
  InlineResultData,
} from "./types.js";
import { basename } from "node:path";
import type { FileModifyDisplayData } from "../../src/diff-hunk.js";
import { PLAN_FILENAME } from "../../src/plan-state.js";
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

/** File-mutating tools whose `path` arg should be checked for plan file targeting. */
const FILE_MUTATING_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Check if a tool_call + its optional result represent a plan file operation.
 *
 * Two detection paths (earliest wins):
 *  1. **Streaming** — the tool_call args contain `path` whose basename is
 *     `plan.md`. Available as soon as the args are streamed in, so the TUI can
 *     suppress display immediately instead of waiting for execution to finish.
 *  2. **Post-execution** — the tool_result metadata has `planFileOperation: true`,
 *     set by `withPlanHook` in session.ts after the file write completes.
 */
function isPlanFileOperation(
  callEntry: ReconciledConversationEntry,
  nextEntry: ReconciledConversationEntry | undefined,
): boolean {
  // Path 1: early detection from tool_call args (works during streaming)
  const toolName = getToolName(callEntry);
  if (FILE_MUTATING_TOOLS.has(toolName)) {
    const args = getToolArgs(callEntry);
    const filePath = typeof args.path === "string" ? args.path : "";
    if (filePath && basename(filePath) === PLAN_FILENAME) return true;
  }

  // Path 2: post-execution metadata flag (authoritative, set by session.ts)
  if (nextEntry?.entry.kind === "tool_result") {
    const resultMeta = (nextEntry.entry.meta as Record<string, unknown>) ?? {};
    const toolMetadata = resultMeta.toolMetadata as Record<string, unknown> | undefined;
    if (toolMetadata?.planFileOperation === true) return true;
  }
  const callMeta = getMeta(callEntry);
  if ((callMeta.toolMetadata as Record<string, unknown> | undefined)?.planFileOperation === true) return true;

  return false;
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

function isTurnEndEntry(entry: ReconciledConversationEntry): boolean {
  return entry.entry.meta?.turnEndStatus !== undefined;
}

function formatElapsedMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function transformTurnEnd(entry: ReconciledConversationEntry): PresentationEntry {
  const meta = getMeta(entry);
  const status = meta.turnEndStatus as string;
  const elapsedMs = typeof entry.entry.elapsedMs === "number" ? entry.entry.elapsedMs : 0;
  const interruptHints = Array.isArray(meta.interruptHints) ? meta.interruptHints as string[] : [];
  const elapsedStr = formatElapsedMs(elapsedMs);

  const text = status === "interrupted"
    ? `Interrupted · ${elapsedStr}`
    : `Worked for ${elapsedStr}`;

  return {
    id: entry.id,
    contentVersion: entry.contentVersion,
    kind: "turn_summary",
    state: "done",
    turnSummaryText: text,
    turnSummaryInterrupted: status === "interrupted",
    turnSummaryHints: interruptHints.length > 0 ? interruptHints : undefined,
  };
}

/**
 * Matches the display text produced by session.ts for sub-agent completion:
 *   [#1 code-review-1] [done] (123.6s)\n<preview>
 *   [#2 foo] [error]\n<preview>
 * Groups: numericId, agentName, outcome, elapsedStr, preview
 */
const SUB_AGENT_END_PATTERN = /^\[#(\d+) ([^\]]+)\] \[(\w+)\](?: \(([\d.]+)s\))?(?:\n([\s\S]*))?$/;

function transformSubAgentDone(entry: ReconciledConversationEntry): PresentationEntry | null {
  const text = entry.entry.text ?? "";
  const match = text.match(SUB_AGENT_END_PATTERN);
  if (!match) return null;

  const [, , agentName, outcome, elapsedStr, previewRaw] = match;
  const preview = (previewRaw ?? "").trimEnd();

  const state: PresentationState = outcome === "error" || outcome === "interrupted"
    ? "error"
    : "done";

  const inlineResult: InlineResultData | null = preview.length > 0
    ? {
        text: preview,
        dim: false,
        maxLines: 50,
      }
    : null;

  return {
    id: entry.id,
    contentVersion: entry.contentVersion,
    kind: "tool_operation",
    state,
    toolDisplayName: "Agent",
    toolCategory: "orchestrate",
    toolText: agentName,
    toolSuffix: elapsedStr ? `(${elapsedStr}s)` : "",
    toolAgentName: agentName,
    toolInlineResult: inlineResult,
  };
}

function transformAgentResult(entry: ReconciledConversationEntry): PresentationEntry {
  const meta = getMeta(entry);
  const agentName = typeof meta.agentId === "string" && meta.agentId.trim()
    ? meta.agentId
    : "sub-agent";
  const outcome = typeof meta.outcome === "string" ? meta.outcome : "completed";
  const elapsedMs = typeof meta.elapsedMs === "number" ? meta.elapsedMs : 0;
  const preview = typeof meta.preview === "string" ? meta.preview.trimEnd() : "";

  const state: PresentationState = outcome === "failed" ? "error" : "done";
  const elapsedStr = elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : "";
  const outcomeSuffix = outcome === "completed"
    ? ""
    : outcome === "failed"
      ? ", error"
      : ", interrupted";
  const suffix = elapsedStr
    ? `(${elapsedStr}${outcomeSuffix})`
    : outcomeSuffix
      ? `(${outcomeSuffix.slice(2)})`
      : "";

  const inlineResult: InlineResultData | null = preview.length > 0
    ? { text: preview, dim: false, maxLines: 50 }
    : null;

  return {
    id: entry.id,
    contentVersion: entry.contentVersion,
    kind: "tool_operation",
    state,
    toolDisplayName: "Agent",
    toolCategory: "orchestrate",
    toolText: agentName,
    toolSuffix: suffix,
    toolInterrupted: outcome === "interrupted",
    toolAgentName: agentName,
    toolInlineResult: inlineResult,
  };
}

function transformSystem(entry: ReconciledConversationEntry): PresentationEntry {
  const kind = entry.entry.kind;
  let severity: PresentationEntry["systemSeverity"] = "info";
  if (kind === "error") severity = "error";
  else if (kind === "compact_mark") severity = "compact";
  else if (kind === "interrupted_marker") severity = "interrupted";
  else if (kind === "sub_agent_rollup" || kind === "sub_agent_done") severity = "sub_agent";
  else if (entry.entry.meta?.statusType === "no_reply") severity = "no_reply";

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
  const callMeta = getMeta(callEntry);
  const toolStreamSections = Array.isArray(callMeta.toolStreamSections)
    ? callMeta.toolStreamSections as PresentationEntry["toolStreamSections"]
    : undefined;
  const toolExecState = typeof callMeta.toolExecState === "string"
    ? callMeta.toolExecState
    : undefined;
  const toolStreamState = typeof callMeta.toolStreamState === "string"
    ? callMeta.toolStreamState
    : undefined;
  const toolRepairedFromPartial = callMeta.repairedFromPartial === true;
  const toolStreamLanguage = typeof callMeta.toolStreamLanguage === "string"
    ? callMeta.toolStreamLanguage : undefined;
  const toolStreamMode = typeof callMeta.toolStreamMode === "string"
    ? callMeta.toolStreamMode as PresentationEntry["toolStreamMode"] : undefined;
  const execFinished = toolExecState === "completed" || toolExecState === "failed";
  const toolStillWorking =
    !resultEntry && !execFinished && (
      toolExecState === "running"
      || toolExecState === "not_started"
      || toolStreamState === "partial"
      || toolStreamState === "partial_closed"
      || toolStreamState === "closed"
    );

  let state: PresentationState;
  let toolInterrupted = false;
  if (toolStillWorking) {
    state = "active";
  } else if (!resultEntry && activeEntryId && activeEntryId === callEntry.id) {
    state = "active";
  } else if (!resultEntry && toolExecState === "failed") {
    state = "error";
  } else if (!resultEntry) {
    // If another entry is active (streaming/executing), this one is queued — show as done
    state = (callEntry.entry.elapsedMs != null || activeEntryId) ? "done" : "active";
  } else if (isToolResultError(resultEntry)) {
    state = "error";
  } else if (isToolResultInterrupted(resultEntry)) {
    toolInterrupted = true;
    state = "error";
  } else {
    state = "done";
  }

  const resultMeta = resultEntry
    ? ((resultEntry.entry.meta as Record<string, unknown>)?.toolMetadata as Record<string, unknown>) ?? undefined
    : undefined;

  // Extract fileModifyData — tool_result (authoritative) takes priority over tool_call (streaming)
  let fileModifyData: FileModifyDisplayData | undefined;
  const resultFmd = resultMeta?.fileModifyData;
  if (resultFmd && typeof resultFmd === "object") {
    fileModifyData = resultFmd as FileModifyDisplayData;
  } else {
    const callFmd = callMeta.fileModifyData;
    if (callFmd && typeof callFmd === "object") {
      fileModifyData = callFmd as FileModifyDisplayData;
    }
  }

  // Resolve dynamic display name for variants
  let displayName = profile.displayName;
  let noDiffBackground = false;
  if (toolName === "write_file") {
    if (resultMeta) {
      noDiffBackground = true;
    }
  }

  let inlineResult: InlineResultData | null = null;
  if (resultEntry && state !== "active") {
    // Errors always show inline result regardless of profile setting
    const showResult = state === "error" || profile.inlineResult !== false;
    if (showResult) {
      const maxLines = profile.inlineResult !== false
        ? profile.inlineResult.maxLines
        : 8; // default for error-only display
      inlineResult = {
        text: resultEntry.entry.text,
        dim: resultEntry.entry.dim ?? false,
        maxLines,
        toolMetadata: resultMeta,
        noDiffBackground: noDiffBackground || undefined,
      };
    }
  }

  const sourceEntries: ReconciledConversationEntry[] = [callEntry];
  if (resultEntry) sourceEntries.push(resultEntry);

  // Spawn tool call: expose agent id for clickable arg rendering
  const toolAgentName = toolName === "spawn" && typeof toolArgs.id === "string"
    ? toolArgs.id as string
    : undefined;

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
    toolInterrupted,
    toolAgentName,
    toolStartedAt: callEntry.entry.startedAt,
    toolElapsedMs: callEntry.entry.elapsedMs,
    toolInlineResult: inlineResult,
    toolResultFullText: resultEntry?.entry.fullText ?? resultEntry?.entry.text,
    toolStreamSections,
    toolRepairedFromPartial,
    toolExecState,
    toolStreamState,
    toolStreamLanguage,
    toolStreamMode,
    fileModifyData,
    sourceEntries,
  };
}

// ------------------------------------------------------------------
// Explore grouping
// ------------------------------------------------------------------

/** Tools eligible for explore grouping (file-read category). */
const EXPLORE_TOOLS = new Set(["Read", "List", "Glob", "Search"]);

function isExploreTool(entry: PresentationEntry): boolean {
  return entry.kind === "tool_operation"
    && entry.toolCategory === "observe"
    && EXPLORE_TOOLS.has(entry.toolDisplayName ?? "");
}

const TOOL_UNIT: Record<string, string> = {
  Read: "file",
  List: "dir",
  Glob: "pattern",
  Search: "query",
};

function toolUnit(name: string, count: number): string {
  const singular = TOOL_UNIT[name] ?? "op";
  if (count === 1) return singular;
  // queries for query, otherwise just append "s"
  if (singular.endsWith("y")) return singular.slice(0, -1) + "ies";
  return singular + "s";
}

function buildGroupSummary(entries: PresentationEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const name = e.toolDisplayName ?? "?";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, count]) =>
    `${name} ${count} ${toolUnit(name, count)}`,
  );
  return `Explore  (${parts.join(", ")})`;
}

function buildExploreGroup(entries: PresentationEntry[]): PresentationEntry {
  const last = entries[entries.length - 1];
  const active = last.state === "active";
  const hasError = entries.every((e) => e.state === "error");
  const maxVersion = Math.max(...entries.map((e) => e.contentVersion));

  return {
    id: `explore-group:${entries[0].id}`,
    contentVersion: maxVersion,
    kind: "tool_group",
    state: active ? "active" : hasError ? "error" : "done",
    groupEntries: entries,
    groupSummary: buildGroupSummary(entries),
    groupActive: active,
    groupLatestToolName: last.toolDisplayName,
    groupLatestToolText: last.toolText,
  };
}

/**
 * In-place: replace consecutive runs of explore tool_operations with
 * a single tool_group entry. Minimum group size: 2 (single tools stay as-is).
 */
function collapseExploreGroups(result: PresentationEntry[]): void {
  let i = 0;
  while (i < result.length) {
    if (!isExploreTool(result[i])) {
      i++;
      continue;
    }
    // Found start of a potential group — scan forward.
    const start = i;
    while (i < result.length && isExploreTool(result[i])) {
      i++;
    }
    const groupLen = i - start;
    if (groupLen >= 2) {
      const group = buildExploreGroup(result.slice(start, i));
      result.splice(start, groupLen, group);
      i = start + 1;
    }
  }
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

    // 1. Skip hidden tools (wait) and plan file operations
    if (kind === "tool_call") {
      const toolName = getToolName(entry);
      const isPlanOp = isPlanFileOperation(entry, entries[i + 1]);
      if (HIDDEN_TOOLS.has(toolName) || isPlanOp) {
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

      case "agent_result": {
        result.push(transformAgentResult(entry));
        i++;
        break;
      }

      default: {
        if (isTurnEndEntry(entry)) {
          result.push(transformTurnEnd(entry));
        } else if (entry.entry.meta?.statusType === "sub_agent_end") {
          const synthetic = transformSubAgentDone(entry);
          result.push(synthetic ?? transformSystem(entry));
        } else {
          result.push(transformSystem(entry));
        }
        i++;
        break;
      }
    }
  }

  // 3. Explore grouping — collapse consecutive file-read tool_operations into tool_group entries.
  collapseExploreGroups(result);

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
