/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import type { ConversationEntryItemProps } from "./conversation-types.js";
import { buildToolResultArtifacts, getToolResultMetadata } from "./tool-result-artifacts.js";

function ToolResultEntryInner(
  { item, colors, contentWidth }: ConversationEntryItemProps,
): React.ReactElement {
  const lineArtifacts = useMemo(
    () => buildToolResultArtifacts({
      text: item.entry.text,
      dim: item.entry.dim,
      toolMetadata: getToolResultMetadata(item.entry),
      wrapWidth: Math.max(8, contentWidth),
      colors,
    }),
    [colors, contentWidth, item.entry.dim, item.entry.meta, item.entry.text],
  );

  return (
    <box flexDirection="column" paddingLeft={2} width="100%">
      {lineArtifacts.map((artifact, index) => (
        <box
          key={`${item.id}-${index}`}
          width="100%"
          backgroundColor={artifact.rowBackgroundColor}
          paddingLeft={2}
          paddingRight={1}
        >
          <text content={artifact.content} wrapMode="none" width="100%" />
        </box>
      ))}
    </box>
  );
}

export const ToolResultEntry = React.memo(
  ToolResultEntryInner,
  (previous, next) => previous.item === next.item && previous.colors === next.colors,
);
