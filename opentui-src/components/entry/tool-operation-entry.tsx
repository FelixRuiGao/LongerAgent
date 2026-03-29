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

interface ToolOperationEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  contentWidth: number;
}

function ToolOperationEntryInner(
  { entry, colors, contentWidth }: ToolOperationEntryProps,
): React.ReactElement {
  const active = entry.state === "active";
  const category = entry.toolCategory ?? "internal";
  const categoryColor = CATEGORY_COLORS[category];
  const categoryRGBA = RGBA.fromHex(categoryColor);

  const spinner = useSpinner(TOOL_SPINNER_FRAMES, TOOL_SPINNER_INTERVAL, active);
  const displayName = entry.toolDisplayName ?? "Tool";
  const shimmer = useShimmer(padToolName(displayName), categoryRGBA, active);

  const indicator = active
    ? spinner
    : entry.state === "error"
      ? "✖"
      : "✔";

  const indicatorColor = active
    ? categoryColor
    : entry.state === "error"
      ? ERROR_COLOR
      : SUCCESS_COLOR;

  const toolText = entry.toolText ?? "";
  const suffix = entry.toolSuffix ?? "";

  return (
    <box flexDirection="column" width="100%">
      <box
        flexDirection="row"
        paddingLeft={2}
        width="100%"
        hoverStyle={{ backgroundColor: colors.border }}
      >
        <text fg={indicatorColor} content={`${indicator} `} />
        {active ? (
          <text content={shimmer} />
        ) : (
          <text fg={categoryColor} content={padToolName(displayName)} />
        )}
        <text fg={categoryColor} content={" "} />
        <text fg={colors.text} content={toolText} wrapMode="none" />
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
