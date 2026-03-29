/** @jsxImportSource @opentui/react */

import React from "react";

import { getTreeSitterClient } from "@opentui/core";

import { getLongerAgentAssistantRenderer } from "../../forked/core/lib/diagnostic.js";
import type { PresentationEntryItemProps } from "../conversation-types.js";
import { ThinkingEntry } from "./thinking-entry.js";
import { ToolOperationEntry } from "./tool-operation-entry.js";
import { UserEntry } from "./user-entry.js";
import { SystemEntry } from "./system-entry.js";
import { TurnSummaryEntry } from "./turn-summary-entry.js";

const MARKDOWN_TREE_SITTER_CLIENT = getTreeSitterClient();
const ASSISTANT_RENDERER_MODE = getLongerAgentAssistantRenderer();

function PresentationEntryInner(
  props: PresentationEntryItemProps,
): React.ReactElement {
  const { entry, colors, contentWidth, markdownMode, markdownStyle, onEntryClick } = props;

  switch (entry.kind) {
    case "user":
      return <UserEntry entry={entry} colors={colors} />;

    case "thinking":
      return <ThinkingEntry entry={entry} colors={colors} onEntryClick={onEntryClick} />;

    case "tool_operation":
      return (
        <ToolOperationEntry
          entry={entry}
          colors={colors}
          contentWidth={contentWidth}
          onEntryClick={onEntryClick}
        />
      );

    case "assistant": {
      const text = entry.assistantText ?? "";
      const streaming = entry.assistantStreaming ?? false;

      return (
        <box paddingLeft={2} paddingTop={1}>
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

    case "system":
      return <SystemEntry entry={entry} colors={colors} />;

    case "turn_summary":
      return (
        <TurnSummaryEntry
          entry={entry}
          colors={colors}
          contentWidth={contentWidth}
        />
      );

    default:
      return <box />;
  }
}

export const PresentationEntryComponent = React.memo(
  PresentationEntryInner,
  (prev, next) => (
    prev.entry === next.entry
    && prev.markdownMode === next.markdownMode
    && prev.markdownStyle === next.markdownStyle
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth
  ),
);
