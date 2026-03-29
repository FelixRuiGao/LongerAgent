/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { buildToolResultArtifacts } from "../tool-result-artifacts.js";

interface DetailToolTabProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  contentWidth: number;
  scrollRef: React.RefObject<any>;
}

function DetailToolTabInner(
  { entry, colors, contentWidth, scrollRef }: DetailToolTabProps,
): React.ReactElement {
  const text = entry.toolResultFullText ?? "";
  const displayName = entry.toolDisplayName ?? "Tool";
  const toolText = entry.toolText ?? "";
  const title = toolText ? `${displayName} ${toolText}` : displayName;

  const toolMetadata = entry.toolInlineResult?.toolMetadata;

  const artifacts = useMemo(() => {
    if (toolMetadata) {
      return buildToolResultArtifacts({
        text,
        toolMetadata,
        wrapWidth: Math.max(8, contentWidth - 6),
        colors,
      });
    }
    return null;
  }, [text, toolMetadata, contentWidth, colors]);

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box paddingLeft={2} paddingBottom={1}>
        <text fg={colors.dim} bold content={title} />
      </box>
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        flexShrink={1}
        stickyScroll={false}
        viewportOptions={{ paddingRight: 1 }}
        verticalScrollbarOptions={{
          paddingLeft: 1,
          trackOptions: {
            backgroundColor: "transparent",
            foregroundColor: colors.border + "44",
          },
        }}
      >
        {artifacts ? (
          <box flexDirection="column" paddingLeft={2} paddingRight={2}>
            {artifacts.map((artifact, idx) => (
              <box
                key={idx}
                width="100%"
                backgroundColor={artifact.rowBackgroundColor}
              >
                <text content={artifact.content} wrapMode="none" />
              </box>
            ))}
          </box>
        ) : (
          <box paddingLeft={2} paddingRight={2}>
            <text fg={colors.text} content={text} />
          </box>
        )}
      </scrollbox>
    </box>
  );
}

export const DetailToolTab = React.memo(
  DetailToolTabInner,
  (prev, next) =>
    prev.entry === next.entry
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth,
);
