/** @jsxImportSource @opentui/react */

import React from "react";

import { RGBA } from "../../forked/core/lib/RGBA.js";
import type { PresentationEntry } from "../../presentation/types.js";
import { THINKING_COLOR } from "../../presentation/colors.js";
import {
  useSpinner,
  THINKING_SPINNER_FRAMES,
  THINKING_SPINNER_INTERVAL,
} from "../../presentation/use-spinner.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";
import { getActivityIndicatorColor } from "../../display/entries/entry-variants.js";
import { DEFAULT_DISPLAY_THEME } from "../../display/theme/index.js";
import { SelectableRow } from "../../display/primitives/selectable-row.js";

interface ThinkingEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  onEntryClick?: (entry: PresentationEntry) => void;
}

const thinkingBaseColor = RGBA.fromHex(THINKING_COLOR);
const THINKING_PREVIEW_LINES = 10;
const LINE_PREFIX = "  ";

function ThinkingEntryInner(
  { entry, colors, onEntryClick }: ThinkingEntryProps,
): React.ReactElement {
  const active = entry.state === "active";
  const spinner = useSpinner(THINKING_SPINNER_FRAMES, THINKING_SPINNER_INTERVAL, active);
  const shimmer = useShimmer("Thinking", thinkingBaseColor, active);
  const fullText = entry.thinkingFullText ?? "";
  const lines = fullText.split("\n");
  const truncated = lines.length > THINKING_PREVIEW_LINES;
  const visibleLines = truncated ? lines.slice(0, THINKING_PREVIEW_LINES) : lines;
  const hiddenCount = Math.max(0, lines.length - THINKING_PREVIEW_LINES);

  const indicator = active
    ? spinner
    : entry.state === "error"
      ? "✗"
      : "✓";

  const indicatorColor = getActivityIndicatorColor(
    {
      active,
      error: entry.state === "error",
    },
    DEFAULT_DISPLAY_THEME,
    "thinking",
  );

  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingTop={1}
      width="100%"
      gap={0}
    >
      <box flexDirection="row" width="100%">
        <text fg={indicatorColor} content={`${indicator} `} flexShrink={0} />
        {active ? (
          <text content={shimmer} flexShrink={0} />
        ) : (
          <text fg={THINKING_COLOR} content="Thinking" flexShrink={0} />
        )}
      </box>
      {fullText.trim().length > 0 ? (
        <box flexDirection="column" paddingLeft={1} paddingTop={1} gap={0}>
          {visibleLines.map((line, idx) => (
            <box key={idx} flexDirection="row" width="100%">
              <text fg={colors.dim} content={LINE_PREFIX} />
              <text fg={colors.dim} content={line} wrapMode="char" />
            </box>
          ))}
          {truncated ? (
            <SelectableRow
              hoverBackgroundColor={colors.border}
              onPress={onEntryClick ? () => onEntryClick(entry) : undefined}
            >
              <text
                fg={colors.dim}
                content={`${LINE_PREFIX}... (${hiddenCount} more lines${onEntryClick ? ", CLICK to open" : ""})`}
              />
            </SelectableRow>
          ) : null}
          {entry.state === "error" ? (
            <text fg={colors.orange} content={`${LINE_PREFIX}[Interrupted — not sent to model]`} />
          ) : null}
        </box>
      ) : null}
      {entry.state === "error" && !fullText.trim() ? (
        <box paddingLeft={1} paddingTop={1}>
          <text fg={colors.orange} content={`${LINE_PREFIX}[Interrupted — not sent to model]`} />
        </box>
      ) : null}
    </box>
  );
}

export const ThinkingEntry = React.memo(
  ThinkingEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
