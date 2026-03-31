/** @jsxImportSource @opentui/react */

import React from "react";

import { RGBA } from "../../forked/core/lib/RGBA.js";
import type { PresentationEntry } from "../../presentation/types.js";
import {
  useSpinner,
  TOOL_SPINNER_FRAMES,
  TOOL_SPINNER_INTERVAL,
} from "../../presentation/use-spinner.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";
import { InlineResult } from "./inline-result.js";
import { DEFAULT_DISPLAY_THEME } from "../../display/theme/index.js";
import { getActivityIndicatorColor } from "../../display/entries/entry-variants.js";

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

  // Use a consistent-width indicator: spinner chars are 1-col,
  // ✔/✖ are also rendered as 1-col with a trailing space for alignment.
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
  const showStreamBody = streamSections.length > 0 && !entry.toolInlineResult;

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
      {showStreamBody ? (
        <box flexDirection="column" paddingLeft={5} paddingTop={1} gap={0}>
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
      ) : null}
      {entry.toolInlineResult && entry.state !== "active" ? (
        entry.toolInlineResult.text.startsWith("[Interrupted]") ? (
          <box paddingLeft={1} paddingTop={1}>
            <text fg={colors.dim} content={entry.toolInlineResult.text} />
          </box>
        ) : (
          <InlineResult
            data={entry.toolInlineResult}
            colors={colors}
            contentWidth={contentWidth}
            onOpenDetail={onEntryClick ? () => onEntryClick(entry) : undefined}
          />
        )
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
