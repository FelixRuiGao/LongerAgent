/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { FileModifyBody } from "./file-modify-body.js";
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
): React.ReactNode {
  const text = entry.toolResultFullText ?? "";
  const streamSections = entry.toolStreamSections ?? [];
  const displayName = entry.toolDisplayName ?? "Tool";
  const toolText = entry.toolText ?? "";
  const title = toolText ? `${displayName} ${toolText}` : displayName;

  const fmd = entry.fileModifyData;

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <SectionHeader label={title} color={colors.dim} paddingLeft={2} paddingBottom={1} />
      <ScrollViewport colors={colors} scrollRef={scrollRef}>
        {fmd && (fmd.hunks.length > 0 || (fmd.writeLines && fmd.writeLines.length > 0)) ? (
          <box paddingLeft={2} paddingRight={2}>
            <FileModifyBody
              data={fmd}
              colors={colors}
              contentWidth={Math.max(8, contentWidth - 6)}
              streaming={entry.state === "active"}
              maxVisibleLines={Infinity}
            />
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
