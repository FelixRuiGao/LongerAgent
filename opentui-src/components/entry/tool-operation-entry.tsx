/** @jsxImportSource @opentui/react */

import React from "react";

import { RGBA } from "../../forked/core/lib/RGBA.js";
import type { PresentationEntry } from "../../presentation/types.js";
import { CATEGORY_COLORS, SUCCESS_COLOR, ERROR_COLOR } from "../../presentation/colors.js";
import {
  useSpinner,
  TOOL_SPINNER_FRAMES,
  TOOL_SPINNER_INTERVAL,
} from "../../presentation/use-spinner.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";
import { padToolName } from "./entry-utils.js";
import { InlineResult } from "./inline-result.js";

// Unified tool name color — all tool names use this single color
const TOOL_NAME_COLOR = "#86ded4";
const TOOL_NAME_RGBA = RGBA.fromHex(TOOL_NAME_COLOR);

interface ToolOperationEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  contentWidth: number;
}

function ToolOperationEntryInner(
  { entry, colors, contentWidth }: ToolOperationEntryProps,
): React.ReactElement {
  const active = entry.state === "active";

  const spinner = useSpinner(TOOL_SPINNER_FRAMES, TOOL_SPINNER_INTERVAL, active);
  const displayName = entry.toolDisplayName ?? "Tool";
  const shimmer = useShimmer(padToolName(displayName), TOOL_NAME_RGBA, active);

  // Use a consistent-width indicator: spinner chars are 1-col,
  // ✔/✖ are also rendered as 1-col with a trailing space for alignment.
  const indicator = active
    ? spinner
    : entry.state === "error"
      ? "✖"
      : "✔";

  const indicatorColor = active
    ? TOOL_NAME_COLOR
    : entry.state === "error"
      ? ERROR_COLOR
      : SUCCESS_COLOR;

  const toolText = entry.toolText ?? "";
  const suffix = entry.toolSuffix ?? "";

  return (
    <box flexDirection="column" width="100%" gap={0}>
      <box
        flexDirection="row"
        paddingLeft={2}
        paddingTop={1}
        width="100%"
        hoverStyle={{ backgroundColor: colors.border }}
      >
        <text fg={indicatorColor} content={indicator} />
        <text content=" " />
        {active ? (
          <text content={shimmer} />
        ) : (
          <text fg={TOOL_NAME_COLOR} content={padToolName(displayName)} />
        )}
        <text content="  " />
        <text fg={colors.dim} content={toolText} wrapMode="char" flexGrow={1} flexShrink={1} />
        {suffix ? (
          <text fg={colors.dim} content={`  ${suffix}`} />
        ) : null}
      </box>
      {entry.toolInlineResult && entry.state !== "active" ? (
        <InlineResult
          data={entry.toolInlineResult}
          colors={colors}
          contentWidth={contentWidth}
        />
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
