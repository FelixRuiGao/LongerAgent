/** @jsxImportSource @opentui/react */

import React from "react";

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
}

const thinkingBaseColor = RGBA.fromHex(THINKING_COLOR);

function ThinkingEntryInner(
  { entry, colors }: ThinkingEntryProps,
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

  return (
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
        <text fg={THINKING_COLOR} content="Thinking" />
      )}
    </box>
  );
}

export const ThinkingEntry = React.memo(
  ThinkingEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
