/** @jsxImportSource @opentui/react */

import React from "react";

import { getTreeSitterClient } from "@opentui/core";

import { getFermiAssistantRenderer } from "../../forked/core/lib/diagnostic.js";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../../components/conversation-types.js";

const MARKDOWN_TREE_SITTER_CLIENT = getTreeSitterClient();
const ASSISTANT_RENDERER_MODE = getFermiAssistantRenderer();

interface AssistantEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  markdownMode: "rendered" | "raw";
  markdownStyle: any;
}

export function AssistantEntry({
  entry,
  colors,
  markdownMode,
  markdownStyle,
}: AssistantEntryProps): React.ReactNode {
  const text = entry.assistantText ?? "";
  const streaming = entry.assistantStreaming ?? false;

  return (
    <box paddingLeft={1} paddingTop={1}>
      {markdownMode === "raw" ? (
        <text fg={colors.text} content={text} />
      ) : ASSISTANT_RENDERER_MODE === "code" ? (
        <code
          content={text}
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
          content={text}
          syntaxStyle={markdownStyle}
          treeSitterClient={MARKDOWN_TREE_SITTER_CLIENT}
          streaming={streaming}
          conceal={true}
          concealCode={false}
          width="100%"
          tableOptions={{
            widthMode: "content",
            borders: true,
            outerBorder: true,
            borderStyle: "single",
            borderColor: colors.text,
            wrapMode: "word",
            cellPaddingX: 1,
            selectable: true,
          }}
        />
      )}
    </box>
  );
}
