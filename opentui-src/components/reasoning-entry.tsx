/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import { RGBA, StyledText } from "@opentui/core";

import type { ConversationEntryItemProps } from "./conversation-types.js";

function ReasoningEntryInner(
  { item, colors }: ConversationEntryItemProps,
): React.ReactElement {
  const styledContent = useMemo(
    () =>
      new StyledText([
        { __isChunk: true, text: "Thinking: ", fg: RGBA.fromHex(colors.thinkingStatus ?? colors.dim), attributes: 1 },
        { __isChunk: true, text: item.entry.text.replace(/^\n+/, ""), fg: RGBA.fromHex(colors.thinking ?? colors.dim) },
      ]),
    [colors.dim, colors.thinking, colors.thinkingStatus, item.entry.text],
  );

  return (
    <box paddingLeft={2} paddingTop={1}>
      <text content={styledContent} wrapMode="word" width="100%" />
    </box>
  );
}

export const ReasoningEntry = React.memo(
  ReasoningEntryInner,
  (previous, next) => previous.item === next.item && previous.colors === next.colors,
);
