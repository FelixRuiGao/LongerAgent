/** @jsxImportSource @opentui/react */

import React from "react";

import { getTreeSitterClient } from "@opentui/core";

import { getLongerAgentAssistantRenderer } from "../forked/core/lib/diagnostic.js";

import type { ConversationEntryItemProps } from "./conversation-types.js";

const MARKDOWN_TREE_SITTER_CLIENT = getTreeSitterClient();
const ASSISTANT_RENDERER_MODE = getLongerAgentAssistantRenderer();

function AssistantEntryInner(
  { item, colors, markdownMode, markdownStyle, streaming }: ConversationEntryItemProps,
): React.ReactElement {
  const { entry } = item;
  return (
    <box paddingLeft={2} paddingTop={1}>
      {markdownMode === "raw" ? (
        <text fg={colors.text} content={entry.text} />
      ) : ASSISTANT_RENDERER_MODE === "code" ? (
        <code
          content={entry.text}
          filetype="markdown"
          syntaxStyle={markdownStyle}
          streaming={streaming}
          conceal={true}
          drawUnstyledText={false}
          fg={colors.text}
          width="100%"
        />
      ) : (
        <markdown
          content={entry.text}
          syntaxStyle={markdownStyle}
          treeSitterClient={MARKDOWN_TREE_SITTER_CLIENT}
          streaming={streaming}
          conceal={true}
          concealCode={false}
          width="100%"
          tableOptions={{
            borders: true,
            outerBorder: true,
            wrapMode: "word",
            selectable: true,
          }}
        />
      )}
    </box>
  );
}

export const AssistantEntry = React.memo(
  AssistantEntryInner,
  (previous, next) => (
    previous.item === next.item
    && previous.streaming === next.streaming
    && previous.markdownMode === next.markdownMode
    && previous.markdownStyle === next.markdownStyle
    && previous.colors === next.colors
  ),
);
