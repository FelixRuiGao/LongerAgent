/** @jsxImportSource @opentui/react */

import React, { useEffect, useRef, useState } from "react";
import { execSync } from "node:child_process";
import path from "node:path";

import { RGBA } from "../../forked/core/lib/RGBA.js";
import type { PresentationEntry, ToolCategory } from "../../presentation/types.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";
import { InlineResult } from "./inline-result.js";
import { FileModifyBody } from "./file-modify-body.js";
import { DEFAULT_DISPLAY_THEME } from "../../display/theme/index.js";
import { getActivityIndicatorColor } from "../../display/entries/entry-variants.js";

// Left bar colors — muted variants of category colors, pre-computed constants.
const BAR_COLORS: Record<ToolCategory, string> = {
  observe: "#5b908a",
  modify: "#96804a",
  orchestrate: "#766a99",
};

// Unified tool name color — all tool names use this single color
const TOOL_NAME_COLOR = DEFAULT_DISPLAY_THEME.presentation.toolNameColor;
const TOOL_NAME_RGBA = RGBA.fromHex(TOOL_NAME_COLOR);
const TOOL_STREAM_MAX_LINES = 10;
const PATH_TOOL_NAMES = new Set(["Read", "Edit", "Write", "List"]);

function openFile(filePath: string): void {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    execSync(`open ${JSON.stringify(resolved)}`, { stdio: "ignore" });
  } catch { /* ignore open failures */ }
}

/** A file-path text element with hover highlight and click-to-open. */
function ClickablePath({ text, baseColor, hoverBg }: { text: string; baseColor: string; hoverBg: string }): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  return (
    <box
      flexShrink={1}
      backgroundColor={hovered ? hoverBg : undefined}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(e: any) => {
        e.stopPropagation();
        e.preventDefault();
        if (text) openFile(text);
      }}
    >
      <text
        fg={baseColor}
        underline
        content={text}
        wrapMode="truncate"
      />
    </box>
  );
}

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

/** Live elapsed seconds since a start timestamp (updates every second). Returns 0 when inactive. */
function useElapsedSince(startMs: number | undefined, active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!active || !startMs) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.floor((Date.now() - startMs) / 1000));
    tick();
    intervalRef.current = setInterval(tick, 1000);
    return () => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; } };
  }, [active, startMs]);
  return elapsed;
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

  const displayName = entry.toolDisplayName ?? "Tool";
  const shimmer = useShimmer(displayName, TOOL_NAME_RGBA, active);

  const indicator = active
    ? "›"
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

  const isWait = displayName === "Wait";
  const waitElapsed = useElapsedSince(entry.toolStartedAt, active && isWait);
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

  const category = entry.toolCategory ?? "observe";
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
        {isWait && active ? (
          <text fg={colors.dim} content={`${waitElapsed}s  Timeout: ${toolText} (Send a message to interrupt)`} flexShrink={0} />
        ) : PATH_TOOL_NAMES.has(displayName) && toolText && !active ? (
          <ClickablePath text={toolText} baseColor={colors.dim} hoverBg={colors.border} />
        ) : (
          <text fg={colors.dim} content={toolText} wrapMode="char" flexGrow={1} flexShrink={1} />
        )}
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
