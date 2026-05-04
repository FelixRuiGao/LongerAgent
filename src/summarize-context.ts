/**
 * Log-native summarize tool implementation (append-only).
 *
 * The session log is the single source of truth. Summary entries are
 * appended to the log with `coveredContextIds`; projections compute
 * visibility dynamically via backward scan. Original entries are never
 * mutated.
 */

import { createSummary, type LogEntry } from "./log-entry.js";

export interface SummarizeOperation {
  from: string;
  to: string;
  context_ids: string[];
  summary: string;
  reason?: string;
}

export interface OperationResult {
  success: boolean;
  contextIds: string[];
  newContextId?: string;
  error?: string;
}

interface LogSpatialEntry {
  indices: number[];
}

interface LogValidationResult {
  valid: boolean;
  mergeRange?: [number, number];
  error?: string;
}

export interface LogSummarizeExecutionResult {
  output: string;
  results: OperationResult[];
  /** Summary entries to append to the log (caller appends). */
  newEntries: LogEntry[];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function getLogContextId(entry: LogEntry): string | null {
  if (entry.discarded) return null;
  const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
  if (ctxId === undefined || ctxId === null) return null;
  return String(ctxId);
}

function isTransparentLogEntry(entry: LogEntry): boolean {
  if (entry.discarded) return true;
  if (entry.type === "compact_context") return true;
  return getLogContextId(entry) === null;
}

function buildLogSpatialIndex(
  entries: LogEntry[],
  coveredSet: Set<string>,
): Map<string, LogSpatialEntry> {
  const index = new Map<string, LogSpatialEntry>();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "compact_context") continue;
    const ctxId = getLogContextId(entries[i]);
    if (!ctxId) continue;
    if (coveredSet.has(ctxId)) continue;

    registerIndex(index, ctxId, i);
  }
  return index;
}

function registerIndex(index: Map<string, LogSpatialEntry>, key: string, idx: number): void {
  const entry = index.get(key);
  if (entry) {
    if (!entry.indices.includes(idx)) entry.indices.push(idx);
    return;
  }
  index.set(key, { indices: [idx] });
}

function findLastCompactMarkerEntryIdx(entries: LogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compact_marker" && !entries[i].discarded) return i;
  }
  return -1;
}

function collectNearbyLogContextIds(
  entries: LogEntry[],
  minIdx: number,
  maxIdx: number,
  coveredSet: Set<string>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const start = Math.max(0, minIdx - 2);
  const end = Math.min(entries.length - 1, maxIdx + 2);

  for (let i = start; i <= end; i++) {
    const ctxId = getLogContextId(entries[i]);
    if (!ctxId || seen.has(ctxId) || coveredSet.has(ctxId)) continue;
    seen.add(ctxId);
    ids.push(ctxId);
  }

  return ids;
}

/**
 * Build the set of context IDs that are covered by existing summary entries.
 * Used to exclude already-summarized context IDs from the spatial index.
 */
export function buildCoveredContextIds(entries: LogEntry[]): Set<string> {
  const covered = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.discarded) continue;
    if (entry.type !== "summary") continue;
    const meta = entry.meta as Record<string, unknown>;
    const ids = meta.coveredContextIds as string[] | undefined;
    if (ids) {
      for (const id of ids) covered.add(id);
    }
  }
  return covered;
}

function parseOperations(args: Record<string, unknown>): SummarizeOperation[] {
  const operations = (args["operations"] as Array<Record<string, unknown>>) ?? [];
  return operations.map((raw) => ({
    from: typeof raw["from"] === "string" ? raw["from"] : "",
    to: typeof raw["to"] === "string" ? raw["to"] : "",
    context_ids: [],
    summary: typeof raw["content"] === "string" ? raw["content"] : "",
    reason: typeof raw["reason"] === "string" && raw["reason"].trim()
      ? raw["reason"]
      : undefined,
  }));
}

/**
 * Build the ordered list of unique context IDs as they appear in the log.
 * This is the spatial order the model sees via show_context.
 */
function buildSpatialOrder(
  entries: LogEntry[],
  coveredSet: Set<string>,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "compact_context") continue;
    const ctxId = getLogContextId(entries[i]);
    if (!ctxId) continue;
    if (coveredSet.has(ctxId)) continue;
    if (!seen.has(ctxId)) {
      seen.add(ctxId);
      order.push(ctxId);
    }
  }
  return order;
}

/**
 * Expand a from/to range into the list of context IDs between them (inclusive)
 * using the spatial order derived from the log.
 */
function expandRange(
  from: string,
  to: string,
  spatialOrder: string[],
): { context_ids: string[]; error?: string } {
  const fromIdx = spatialOrder.indexOf(from);
  if (fromIdx < 0) {
    return { context_ids: [], error: `"from" context_id "${from}" not found in the active context.` };
  }
  const toIdx = spatialOrder.indexOf(to);
  if (toIdx < 0) {
    return { context_ids: [], error: `"to" context_id "${to}" not found in the active context.` };
  }
  if (fromIdx > toIdx) {
    return { context_ids: [], error: `"from" ("${from}") appears after "to" ("${to}") in spatial order. Swap them or check show_context.` };
  }
  return { context_ids: spatialOrder.slice(fromIdx, toIdx + 1) };
}

function validateLogOperation(
  op: SummarizeOperation,
  spatialIndex: Map<string, LogSpatialEntry>,
  entries: LogEntry[],
  lastCompactMarkerIdx: number,
  coveredSet: Set<string>,
): LogValidationResult {
  const { context_ids, summary } = op;

  if (!context_ids.length) {
    return { valid: false, error: "Empty range — from/to produced no context IDs." };
  }
  if (!summary.trim()) {
    return { valid: false, error: "Empty summary. Provide a non-empty summary string." };
  }

  for (const id of context_ids) {
    if (!spatialIndex.has(id)) {
      return { valid: false, error: `context_id "${id}" not found in the active context.` };
    }
  }

  const allIndices = new Set<number>();
  for (const id of context_ids) {
    for (const idx of spatialIndex.get(id)!.indices) {
      allIndices.add(idx);
    }
  }

  const sorted = [...allIndices].sort((a, b) => a - b);
  const minIdx = sorted[0];
  const maxIdx = sorted[sorted.length - 1];

  if (lastCompactMarkerIdx >= 0 && minIdx <= lastCompactMarkerIdx) {
    return {
      valid: false,
      error: "context_id(s) include entries before the last compact marker (not visible to the model).",
    };
  }

  for (let i = minIdx; i <= maxIdx; i++) {
    if (allIndices.has(i)) continue;
    if (isTransparentLogEntry(entries[i])) continue;
    const entryCtxId = getLogContextId(entries[i]);
    if (entryCtxId && coveredSet.has(entryCtxId)) continue;

    const nearbyIds = collectNearbyLogContextIds(entries, minIdx, maxIdx, coveredSet);
    const rangeLabel = op.from === op.to ? op.from : `${op.from}..${op.to}`;
    return {
      valid: false,
      error:
        `Not spatially contiguous in range ${rangeLabel}. Current spatial order near that region: ` +
        `${nearbyIds.join(", ")}. Split into separate operations if needed.`,
    };
  }

  return { valid: true, mergeRange: [minIdx, maxIdx] };
}

function buildSummaryEntry(
  op: SummarizeOperation,
  entries: LogEntry[],
  allocateContextId: () => string,
  allocateLogId: () => string,
  turnIndex: number,
  validation: LogValidationResult,
): { result: OperationResult; entry: LogEntry } {
  const [startIdx, endIdx] = validation.mergeRange!;
  const newContextId = allocateContextId();
  const summaryEntryId = allocateLogId();

  let summaryDepth = 1;
  const coveredContextIds: string[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const entry = entries[i];
    if (entry.type === "summary") {
      const depth = Number((entry.meta as Record<string, unknown>)["summaryDepth"] ?? 1);
      summaryDepth = Math.max(summaryDepth, depth + 1);
    }
    const ctxId = getLogContextId(entry);
    if (ctxId && !coveredContextIds.includes(ctxId)) {
      coveredContextIds.push(ctxId);
    }
  }

  const rangeLabel = op.from === op.to ? op.from : `${op.from}..${op.to}`;
  let display = `[Summary of ${rangeLabel}]\n`;
  if (op.reason) {
    display += `Reason: ${op.reason}\n`;
  }
  const content = `${display}Summary: ${op.summary}`;
  display += `Summary: ${op.summary}`;

  const summaryEntry = createSummary(
    summaryEntryId,
    turnIndex,
    display,
    content,
    newContextId,
    coveredContextIds,
    summaryDepth,
  );

  return {
    result: {
      success: true,
      contextIds: op.context_ids,
      newContextId,
    },
    entry: summaryEntry,
  };
}

function formatExecutionOutput(ops: SummarizeOperation[], results: OperationResult[]): string {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const lines: string[] = [];
  lines.push(`Operations: ${ops.length} submitted, ${succeeded} succeeded, ${failed} failed.`);
  lines.push("");
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const op = ops[i];
    const rangeLabel = op.from === op.to ? op.from : `${op.from}..${op.to}`;
    if (result.success) {
      lines.push(`✓ [${rangeLabel}] → Replaced with context_id ${String(result.newContextId)}.`);
    } else {
      lines.push(`✗ [${rangeLabel}] → Error: ${result.error}`);
    }
  }
  return lines.join("\n");
}

/**
 * Truncate long summarize content in projected tool arguments.
 * The full content is preserved in the summary entry; this only shrinks the
 * duplicated copy inside the tool_call before provider submission.
 */
export function truncateSummarizeContent(content: string, newContextId?: string | number): string {
  if (content.length <= 100) return content;

  let cutPoint: number;
  const spaceIdx = content.indexOf(" ", 100);
  if (spaceIdx >= 0 && spaceIdx <= 120) {
    cutPoint = spaceIdx;
  } else {
    cutPoint = Math.min(content.length, 120);
  }

  const kept = content.slice(0, cutPoint);
  const ctxRef = newContextId !== undefined ? ` in context_id ${String(newContextId)}` : "";
  return `${kept}... [truncated — full content preserved${ctxRef}]`;
}

/**
 * Execute summarize operations on the log. Append-only: original entries are
 * never mutated. Returns new summary entries for the caller to append.
 */
export function execSummarizeContextOnLog(
  args: Record<string, unknown>,
  entries: LogEntry[],
  contextIdAllocator: () => string,
  logIdAllocator: () => string,
  turnIndex: number,
): LogSummarizeExecutionResult {
  const ops = parseOperations(args);
  if (!ops.length) {
    const results: OperationResult[] = [{
      success: false,
      contextIds: [],
      error: "Error: no operations provided.",
    }];
    return {
      output: "Error: no operations provided.",
      results,
      newEntries: [],
    };
  }

  const coveredSet = buildCoveredContextIds(entries);
  const spatialIndex = buildLogSpatialIndex(entries, coveredSet);
  const spatialOrder = buildSpatialOrder(entries, coveredSet);
  const lastCompactMarkerIdx = findLastCompactMarkerEntryIdx(entries);
  const orderedResults: Array<OperationResult | undefined> = new Array(ops.length);
  const newEntries: LogEntry[] = [];
  const claimedIds = new Set<string>();

  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const op = ops[opIndex];

    if (!op.from || !op.to) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: [],
        error: "Missing required fields: from and to.",
      };
      continue;
    }

    const expanded = expandRange(op.from, op.to, spatialOrder);
    if (expanded.error) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: [],
        error: expanded.error,
      };
      continue;
    }
    op.context_ids = expanded.context_ids;

    const duplicates = op.context_ids.filter((id) => claimedIds.has(id));
    if (duplicates.length > 0) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: op.context_ids,
        error: `context_id(s) ${duplicates.map((d) => `"${d}"`).join(", ")} already referenced by another operation in this call.`,
      };
      continue;
    }

    const validation = validateLogOperation(op, spatialIndex, entries, lastCompactMarkerIdx, coveredSet);
    if (!validation.valid) {
      orderedResults[opIndex] = {
        success: false,
        contextIds: op.context_ids,
        error: validation.error,
      };
      continue;
    }

    const { result, entry } = buildSummaryEntry(
      op,
      entries,
      contextIdAllocator,
      logIdAllocator,
      turnIndex,
      validation,
    );
    orderedResults[opIndex] = result;
    newEntries.push(entry);
    for (const id of op.context_ids) claimedIds.add(id);
  }

  const finalizedResults = orderedResults.map((result, idx) => result ?? ({
    success: false,
    contextIds: ops[idx].context_ids,
    error: "Internal error: missing operation result.",
  }));

  return {
    output: formatExecutionOutput(ops, finalizedResults),
    results: finalizedResults,
    newEntries,
  };
}
