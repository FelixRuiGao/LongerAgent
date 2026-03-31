/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";

interface TurnSummaryEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  contentWidth: number;
}

function TurnSummaryEntryInner(
  { entry, colors, contentWidth }: TurnSummaryEntryProps,
): React.ReactElement {
  const text = entry.turnSummaryText ?? "";
  const label = ` ${text} `;
  const totalDashes = Math.max(0, contentWidth - label.length - 4);
  const leftDashes = Math.floor(totalDashes / 2);
  const rightDashes = totalDashes - leftDashes;
  const line = "─".repeat(leftDashes) + label + "─".repeat(rightDashes);

  return (
    <box paddingLeft={1} width="100%" paddingTop={1}>
      <text fg={colors.dim} content={line} />
    </box>
  );
}

export const TurnSummaryEntry = React.memo(
  TurnSummaryEntryInner,
  (prev, next) =>
    prev.entry === next.entry
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth,
);
