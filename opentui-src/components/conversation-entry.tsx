/** @jsxImportSource @opentui/react */

import React from "react";

import { AssistantEntry } from "./assistant-entry.js";
import { LightEntry } from "./light-entry.js";
import { ReasoningEntry } from "./reasoning-entry.js";
import { ToolResultEntry } from "./tool-result-entry.js";
import type { ConversationEntryItemProps } from "./conversation-types.js";

function ConversationEntryInner(
  props: ConversationEntryItemProps,
): React.ReactElement {
  switch (props.item.entry.kind) {
    case "assistant":
      return <AssistantEntry {...props} />;
    case "reasoning":
      return <ReasoningEntry {...props} />;
    case "tool_result":
      return <ToolResultEntry {...props} />;
    default:
      return <LightEntry {...props} />;
  }
}

export const ConversationEntry = React.memo(
  ConversationEntryInner,
  (previous, next) => (
    previous.item === next.item
    && previous.streaming === next.streaming
    && previous.markdownMode === next.markdownMode
    && previous.needsSpacing === next.needsSpacing
    && previous.markdownStyle === next.markdownStyle
    && previous.colors === next.colors
  ),
);
