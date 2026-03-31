/** @jsxImportSource @opentui/react */

/**
 * Unified file-modify body — renders identically during streaming and after completion.
 *
 * Input: FileModifyDisplayData (shared type from src/diff-hunk.ts)
 *
 * Modes:
 *   replace — DiffHunk[]: contextBefore + red lines + green lines + contextAfter, with ⋮
 *   append  — DiffHunk[]: ⋮ top + green lines (no ⋮ bottom)
 *   write   — writeLines: syntax-highlighted code lines with line numbers (no ⋮)
 */

import React, { useMemo } from "react";

import { RGBA, StyledText } from "@opentui/core";
import type { TextChunk } from "../../forked/core/text-buffer.js";
import { highlightToChunks } from "../../forked/patch-opentui-markdown.js";
import type { FileModifyDisplayData, DiffHunk } from "../../../src/diff-hunk.js";
import type { ConversationPalette } from "../conversation-types.js";
import { SelectableRow } from "../../display/primitives/selectable-row.js";
import {
  DIFF_BRIGHTNESS_ADDITION,
  DIFF_BRIGHTNESS_DELETION,
  DIFF_BRIGHTNESS_CONTEXT,
  createChunk,
  cloneChunksWithBaseStyle,
  chunkDisplayWidth,
  type ToolResultLineArtifact,
} from "../syntax-highlight-utils.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ADDITION_BG = "#285438";
const DELETION_BG = "#6a3232";
const DEFAULT_MAX_VISIBLE = 25;

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function highlightLine(
  text: string,
  language: string | undefined,
  fallbackFg: RGBA,
  brightness?: number,
): TextChunk[] {
  const highlighted = language ? highlightToChunks(text, language) : null;
  if (highlighted && highlighted.length > 0) {
    return cloneChunksWithBaseStyle(highlighted, { fallbackFg, brightness });
  }
  return [createChunk(text || " ", { fg: fallbackFg })];
}

function buildLine(
  content: StyledText,
  rowBackgroundColor?: string,
): ToolResultLineArtifact {
  return { content, rowBackgroundColor };
}

function lineNumStr(num: number, width: number): string {
  return String(num).padStart(width);
}

function lineNumBlank(width: number): string {
  return " ".repeat(width);
}

function truncateChunks(
  chunks: TextChunk[],
  maxWidth: number,
  ellipsisFg: RGBA,
): TextChunk[] {
  let totalWidth = 0;
  for (const chunk of chunks) {
    totalWidth += chunkDisplayWidth(chunk.text);
  }
  if (totalWidth <= maxWidth) return chunks;

  const result: TextChunk[] = [];
  let usedWidth = 0;
  const targetWidth = maxWidth - 1;

  for (const chunk of chunks) {
    const cw = chunkDisplayWidth(chunk.text);
    if (usedWidth + cw <= targetWidth) {
      result.push(chunk);
      usedWidth += cw;
    } else {
      const remaining = targetWidth - usedWidth;
      if (remaining > 0) {
        let truncText = "";
        let truncWidth = 0;
        for (const ch of chunk.text) {
          const charW = chunkDisplayWidth(ch);
          if (truncWidth + charW > remaining) break;
          truncText += ch;
          truncWidth += charW;
        }
        if (truncText) {
          result.push({ ...chunk, text: truncText });
        }
      }
      result.push(createChunk("…", { fg: ellipsisFg }));
      return result;
    }
  }
  return result;
}

// ------------------------------------------------------------------
// Ellipsis line builder
// ------------------------------------------------------------------

function buildEllipsis(numW: number, dimFg: RGBA): ToolResultLineArtifact {
  return buildLine(new StyledText([
    createChunk(numW ? `${lineNumBlank(numW)} ` : "", { fg: dimFg }),
    createChunk("⋮", { fg: dimFg }),
  ]));
}

// ------------------------------------------------------------------
// Artifact builders
// ------------------------------------------------------------------

function buildReplaceArtifacts(
  data: FileModifyDisplayData,
  colors: ConversationPalette,
): ToolResultLineArtifact[] {
  const dimFg = RGBA.fromHex(colors.dim);
  const redFg = RGBA.fromHex(colors.red);
  const greenFg = RGBA.fromHex(colors.green);
  const language = data.language;

  // Compute global line number column width across all hunks
  let maxLineNo = 0;
  for (const hunk of data.hunks) {
    const afterStart = hunk.startLine + hunk.deletions.length;
    const endLine = afterStart + hunk.contextAfter.length;
    if (endLine > maxLineNo) maxLineNo = endLine;
  }
  const numW = maxLineNo > 0 ? Math.max(String(maxLineNo).length, 2) : 0;

  const artifacts: ToolResultLineArtifact[] = [];

  for (let i = 0; i < data.hunks.length; i++) {
    const hunk = data.hunks[i];
    const isFirst = i === 0;
    const isLast = i === data.hunks.length - 1;

    // ⋮ top: only if there are hidden lines above
    if (isFirst) {
      const firstDisplayLine = hunk.startLine - hunk.contextBefore.length;
      if (firstDisplayLine > 1) {
        artifacts.push(buildEllipsis(numW, dimFg));
      }
    } else {
      // Between hunks: only show ⋮ if there are hidden lines between them
      const prevHunk = data.hunks[i - 1];
      const prevHunkEnd = prevHunk.startLine + prevHunk.deletions.length + prevHunk.contextAfter.length;
      const currHunkStart = hunk.startLine - hunk.contextBefore.length;
      if (currHunkStart > prevHunkEnd) {
        artifacts.push(buildEllipsis(numW, dimFg));
      }
    }

    // Context before
    const ctxBeforeStartLine = hunk.startLine - hunk.contextBefore.length;
    for (let j = 0; j < hunk.contextBefore.length; j++) {
      const lineNo = ctxBeforeStartLine + j;
      const chunks = highlightLine(hunk.contextBefore[j], language, dimFg, DIFF_BRIGHTNESS_CONTEXT);
      artifacts.push(buildLine(new StyledText([
        createChunk(numW ? `${lineNumStr(lineNo, numW)} ` : "", { fg: dimFg }),
        createChunk(" ", { fg: dimFg }),
        ...chunks,
      ])));
    }

    // Deletions (red)
    for (let j = 0; j < hunk.deletions.length; j++) {
      const lineNo = hunk.startLine + j;
      const chunks = highlightLine(hunk.deletions[j], language, redFg, DIFF_BRIGHTNESS_DELETION);
      artifacts.push(buildLine(
        new StyledText([
          createChunk(numW ? `${lineNumStr(lineNo, numW)} ` : "", { fg: dimFg }),
          createChunk("-", { fg: redFg }),
          ...chunks,
        ]),
        DELETION_BG,
      ));
    }

    // Additions (green)
    for (let j = 0; j < hunk.additions.length; j++) {
      const lineNo = hunk.startLine + j;
      const chunks = highlightLine(hunk.additions[j], language, greenFg, DIFF_BRIGHTNESS_ADDITION);
      artifacts.push(buildLine(
        new StyledText([
          createChunk(numW ? `${lineNumStr(lineNo, numW)} ` : "", { fg: dimFg }),
          createChunk("+", { fg: greenFg }),
          ...chunks,
        ]),
        ADDITION_BG,
      ));
    }

    // Context after
    const afterStartLine = hunk.startLine + hunk.deletions.length;
    for (let j = 0; j < hunk.contextAfter.length; j++) {
      const lineNo = afterStartLine + j;
      const chunks = highlightLine(hunk.contextAfter[j], language, dimFg, DIFF_BRIGHTNESS_CONTEXT);
      artifacts.push(buildLine(new StyledText([
        createChunk(numW ? `${lineNumStr(lineNo, numW)} ` : "", { fg: dimFg }),
        createChunk(" ", { fg: dimFg }),
        ...chunks,
      ])));
    }

    // ⋮ bottom: only if there are hidden lines below
    if (isLast) {
      const lastDisplayLine = afterStartLine + hunk.contextAfter.length - 1;
      if (data.totalLineCount > 0 && lastDisplayLine < data.totalLineCount) {
        artifacts.push(buildEllipsis(numW, dimFg));
      }
    }
  }

  return artifacts;
}

function buildAppendArtifacts(
  data: FileModifyDisplayData,
  colors: ConversationPalette,
): ToolResultLineArtifact[] {
  const dimFg = RGBA.fromHex(colors.dim);
  const greenFg = RGBA.fromHex(colors.green);
  const language = data.language;

  if (data.hunks.length === 0) return [];
  const hunk = data.hunks[0];

  const lines = hunk.additions;
  const startLine = hunk.startLine;
  const maxLineNo = startLine + lines.length - 1;
  const numW = startLine > 0 ? Math.max(String(maxLineNo).length, 2) : 0;

  const artifacts: ToolResultLineArtifact[] = [];

  // ⋮ top: always (there's existing file content above)
  artifacts.push(buildEllipsis(numW, dimFg));

  for (let idx = 0; idx < lines.length; idx++) {
    const chunks = highlightLine(lines[idx], language, greenFg, DIFF_BRIGHTNESS_ADDITION);
    const ln = startLine && numW ? `${lineNumStr(startLine + idx, numW)} ` : "";
    artifacts.push(buildLine(
      new StyledText([
        createChunk(ln, { fg: dimFg }),
        createChunk("+", { fg: greenFg }),
        ...chunks,
      ]),
      ADDITION_BG,
    ));
  }

  // No ⋮ bottom — append content IS the end of the file

  return artifacts;
}

function buildWriteArtifacts(
  data: FileModifyDisplayData,
  colors: ConversationPalette,
): ToolResultLineArtifact[] {
  const textFg = RGBA.fromHex(colors.text);
  const dimFg = RGBA.fromHex(colors.dim);
  const language = data.language;

  const lines = data.writeLines ?? [];
  if (lines.length === 0) return [];

  const numW = Math.max(String(lines.length).length, 2);

  // No ⋮ — write shows the full file content
  // No brightness boost — this is neutral file content, not a diff addition
  return lines.map((line, idx) => {
    const chunks = highlightLine(line, language, textFg);
    return buildLine(new StyledText([
      createChunk(`${lineNumStr(idx + 1, numW)} `, { fg: dimFg }),
      ...chunks,
    ]));
  });
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

interface FileModifyBodyProps {
  data: FileModifyDisplayData;
  colors: ConversationPalette;
  contentWidth: number;
  streaming: boolean;
  maxVisibleLines?: number;
  onOpenDetail?: () => void;
}

function FileModifyBodyInner({
  data,
  colors,
  contentWidth,
  streaming,
  maxVisibleLines = DEFAULT_MAX_VISIBLE,
  onOpenDetail,
}: FileModifyBodyProps): React.ReactElement {
  const rawArtifacts = useMemo(() => {
    switch (data.mode) {
      case "replace": return buildReplaceArtifacts(data, colors);
      case "append": return buildAppendArtifacts(data, colors);
      case "write": return buildWriteArtifacts(data, colors);
    }
  }, [data, colors]);

  const artifacts = useMemo(() => {
    if (contentWidth <= 0) return rawArtifacts;
    const dimFg = RGBA.fromHex(colors.dim);
    return rawArtifacts.map((a) => {
      const truncated = truncateChunks(a.content.chunks, contentWidth, dimFg);
      if (truncated === a.content.chunks) return a;
      return { ...a, content: new StyledText(truncated) };
    });
  }, [rawArtifacts, contentWidth, colors]);

  const total = artifacts.length;
  const overflowCount = Math.max(0, total - maxVisibleLines);
  const visibleArtifacts = overflowCount > 0
    ? artifacts.slice(total - maxVisibleLines)
    : artifacts;

  return (
    <box flexDirection="column" gap={0}>
      {overflowCount > 0 ? (
        <SelectableRow
          hoverBackgroundColor={colors.border}
          onPress={onOpenDetail}
        >
          <text fg={colors.dim} content={`...(${overflowCount} earlier lines${onOpenDetail ? ", CLICK to open" : ""})`} />
        </SelectableRow>
      ) : null}
      {visibleArtifacts.map((artifact, idx) => (
        <box
          key={idx}
          flexDirection="row"
          width="100%"
          backgroundColor={artifact.rowBackgroundColor}
        >
          <text content={artifact.content} wrapMode="none" />
        </box>
      ))}
    </box>
  );
}

export const FileModifyBody = React.memo(
  FileModifyBodyInner,
  (prev, next) =>
    prev.data === next.data
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth
    && prev.streaming === next.streaming
    && prev.maxVisibleLines === next.maxVisibleLines,
);
