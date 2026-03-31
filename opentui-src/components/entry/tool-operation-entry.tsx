/** @jsxImportSource @opentui/react */

import React from "react";

import { RGBA } from "../../forked/core/lib/RGBA.js";
import type { PresentationEntry, ToolCategory } from "../../presentation/types.js";
import {
  useSpinner,
  TOOL_SPINNER_FRAMES,
  TOOL_SPINNER_INTERVAL,
} from "../../presentation/use-spinner.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import { CATEGORY_COLORS } from "../../presentation/colors.js";
import type { ConversationPalette } from "../conversation-types.js";
import { InlineResult } from "./inline-result.js";
import { FileModifyBody } from "./file-modify-body.js";
import { DEFAULT_DISPLAY_THEME } from "../../display/theme/index.js";
import { getActivityIndicatorColor } from "../../display/entries/entry-variants.js";

// Dim category colors for the left bar — 40% toward background to avoid being too loud.
const BAR_COLORS: Record<ToolCategory, string> = Object.fromEntries(
  (Object.entries(CATEGORY_COLORS) as [ToolCategory, string][]).map(([cat, hex]) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const mix = (c: number, bg: number) => Math.round(c * 0.6 + bg * 0.4);
    const dr = mix(r, 26); const dg = mix(g, 26); const db = mix(b, 28);
    return [cat, `#${dr.toString(16).padStart(2, "0")}${dg.toString(16).padStart(2, "0")}${db.toString(16).padStart(2, "0")}`];
  }),
) as Record<ToolCategory, string>;

// Unified tool name color — all tool names use this single color
const TOOL_NAME_COLOR = DEFAULT_DISPLAY_THEME.presentation.toolNameColor;
const TOOL_NAME_RGBA = RGBA.fromHex(TOOL_NAME_COLOR);
const TOOL_STREAM_MAX_LINES = 10;

function buildSectionPreview(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

interface ToolOperationEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  contentWidth: number;
  onEntryClick?: (entry: PresentationEntry) => void;
}

function ToolOperationEntryInner(
  { entry, colors, contentWidth, onEntryClick }: ToolOperationEntryProps,
): React.ReactElement {
  const active = entry.state === "active";

  const spinner = useSpinner(TOOL_SPINNER_FRAMES, TOOL_SPINNER_INTERVAL, active);
  const displayName = entry.toolDisplayName ?? "Tool";
  const shimmer = useShimmer(displayName, TOOL_NAME_RGBA, active);

  const indicator = active
    ? spinner
    : entry.state === "error"
      ? "✖"
      : "✔";

  const indicatorColor = getActivityIndicatorColor(
    {
      active,
      error: entry.state === "error",
    },
    DEFAULT_DISPLAY_THEME,
    "tool",
  );

  const toolText = entry.toolText ?? "";
  const suffix = entry.toolSuffix ?? "";
  const streamSections = entry.toolStreamSections ?? [];

  // File-modify tools use FileModifyBody with unified FileModifyDisplayData
  const fmd = entry.fileModifyData;
  const showFileModify = fmd
    && (fmd.hunks.length > 0 || (fmd.writeLines && fmd.writeLines.length > 0))
    && entry.state !== "error";

  // Fallback: legacy streaming body for non-file-modify tools
  // (file-modify tools should never show raw section labels — they use FileModifyBody or InlineResult)
  const isFileModifyTool = entry.toolStreamMode === "replace"
    || entry.toolStreamMode === "append"
    || entry.toolStreamMode === "write";
  const showStreamBody = !showFileModify
    && !isFileModifyTool
    && streamSections.length > 0
    && !entry.toolInlineResult;

  // Fallback: InlineResult for non-file-modify tools after completion
  const showInlineResult = !showFileModify
    && !showStreamBody
    && entry.toolInlineResult
    && entry.state !== "active";

  const category = entry.toolCategory ?? "internal";
  const barColor = BAR_COLORS[category];
  const hasBody = showFileModify || showStreamBody || showInlineResult;

  return (
    <box flexDirection="column" width="100%" gap={0}>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingTop={1}
        width="100%"
      >
        <text fg={indicatorColor} content={`${indicator} `} flexShrink={0} />
        {active ? (
          <text content={shimmer} flexShrink={0} />
        ) : (
          <text fg={TOOL_NAME_COLOR} content={displayName} flexShrink={0} />
        )}
        {suffix ? (
          <text fg={colors.dim} content={` ${suffix}`} flexShrink={0} />
        ) : null}
        <text content="  " flexShrink={0} />
        <text fg={colors.dim} content={toolText} wrapMode="char" flexGrow={1} flexShrink={1} />
      </box>
      {hasBody ? (
        <box
          flexDirection="column"
          marginLeft={3}
          marginTop={1}
          marginBottom={1}
          border={["left"] as any}
          borderColor={barColor}
          borderStyle="single"
          paddingLeft={1}
          gap={0}
        >
          {showFileModify ? (
            <FileModifyBody
              data={fmd!}
              colors={colors}
              contentWidth={contentWidth - 5}
              streaming={entry.state === "active"}
              onOpenDetail={onEntryClick ? () => onEntryClick(entry) : undefined}
            />
          ) : showStreamBody ? (
            <box flexDirection="column" gap={0}>
              {streamSections.map((section) => {
                const preview = buildSectionPreview(section.text, TOOL_STREAM_MAX_LINES);
                return (
                  <box key={section.key} flexDirection="column" width="100%" paddingBottom={1}>
                    <text fg={colors.dim} content={`${section.label}${section.complete ? "" : " (streaming)"}`} />
                    <text fg={colors.text} content={preview.text} wrapMode="char" />
                    {preview.truncated ? (
                      <text fg={colors.dim} content="(... more lines, click to open)" />
                    ) : null}
                  </box>
                );
              })}
              {entry.toolRepairedFromPartial ? (
                <text fg={colors.dim} content="(repaired from partial stream)" />
              ) : null}
            </box>
          ) : showInlineResult ? (
            entry.toolInlineResult!.text.startsWith("[Interrupted]") ? (
              <text fg={colors.dim} content={entry.toolInlineResult!.text} />
            ) : (
              <InlineResult
                data={entry.toolInlineResult!}
                colors={colors}
                contentWidth={contentWidth - 5}
                onOpenDetail={onEntryClick ? () => onEntryClick(entry) : undefined}
              />
            )
          ) : null}
        </box>
      ) : null}
    </box>
  );
}

export const ToolOperationEntry = React.memo(
  ToolOperationEntryInner,
  (prev, next) =>
    prev.entry === next.entry
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth,
);
