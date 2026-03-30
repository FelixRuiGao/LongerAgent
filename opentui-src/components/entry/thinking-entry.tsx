/** @jsxImportSource @opentui/react */

import React, { useState } from "react";

import { RGBA } from "../../forked/core/lib/RGBA.js";
import type { PresentationEntry } from "../../presentation/types.js";
import { THINKING_COLOR, SUCCESS_COLOR, ERROR_COLOR } from "../../presentation/colors.js";
import {
  useSpinner,
  THINKING_SPINNER_FRAMES,
  THINKING_SPINNER_INTERVAL,
} from "../../presentation/use-spinner.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";

interface ThinkingEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  onEntryClick?: (entry: PresentationEntry) => void;
}

const thinkingBaseColor = RGBA.fromHex(THINKING_COLOR);

function ThinkingEntryInner(
  { entry, colors, onEntryClick }: ThinkingEntryProps,
): React.ReactElement {
  const active = entry.state === "active";
  const spinner = useSpinner(THINKING_SPINNER_FRAMES, THINKING_SPINNER_INTERVAL, active);
  const shimmer = useShimmer("Thinking", thinkingBaseColor, active);

  const indicator = active
    ? spinner
    : entry.state === "error"
      ? "✖"
      : "✔";

  const indicatorColor = active
    ? THINKING_COLOR
    : entry.state === "error"
      ? ERROR_COLOR
      : SUCCESS_COLOR;

  const [hovered, setHovered] = useState(false);

  return (
    <box
      flexDirection="row"
      paddingLeft={2}
      paddingTop={1}
      width="100%"
      backgroundColor={hovered ? colors.border : undefined}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(e: any) => { e.stopPropagation(); onEntryClick?.(entry); }}
    >
      <text fg={indicatorColor} content={`${indicator} `} flexShrink={0} />
      {active ? (
        <text content={shimmer} flexShrink={0} />
      ) : (
        <text fg={THINKING_COLOR} content="Thinking" flexShrink={0} />
      )}
    </box>
  );
}

export const ThinkingEntry = React.memo(
  ThinkingEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
