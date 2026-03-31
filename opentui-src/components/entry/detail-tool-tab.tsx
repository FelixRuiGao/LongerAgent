/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { buildToolResultArtifacts } from "../tool-result-artifacts.js";
import { ScrollViewport } from "../../display/primitives/scroll-viewport.js";
import { SectionHeader } from "../../display/primitives/section-header.js";

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
  const streamSections = entry.toolStreamSections ?? [];
  const displayName = entry.toolDisplayName ?? "Tool";
  const toolText = entry.toolText ?? "";
  const title = toolText ? `${displayName} ${toolText}` : displayName;

  const toolMetadata = entry.toolInlineResult?.toolMetadata;
  const codePreviewOnly = entry.toolInlineResult?.noDiffBackground;

  const artifacts = useMemo(() => {
    if (toolMetadata) {
      return buildToolResultArtifacts({
        text,
        toolMetadata,
        wrapWidth: Math.max(8, contentWidth - 6),
        colors,
        codePreviewOnly,
      });
    }
    return null;
  }, [text, toolMetadata, contentWidth, colors, codePreviewOnly]);

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <SectionHeader label={title} color={colors.dim} paddingLeft={2} paddingBottom={1} />
      <ScrollViewport colors={colors} scrollRef={scrollRef}>
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
        ) : streamSections.length > 0 ? (
          <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={0}>
            {streamSections.map((section) => (
              <box key={section.key} flexDirection="column" paddingBottom={1}>
                <text fg={colors.dim} content={`${section.label}${section.complete ? "" : " (streaming)"}`} />
                <text fg={colors.text} content={section.text} wrapMode="char" />
              </box>
            ))}
            {entry.toolRepairedFromPartial ? (
              <text fg={colors.dim} content="(repaired from partial stream)" />
            ) : null}
          </box>
        ) : (
          <box paddingLeft={2} paddingRight={2}>
            <text fg={colors.text} content={text} />
          </box>
        )}
      </ScrollViewport>
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
