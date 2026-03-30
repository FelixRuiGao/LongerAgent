/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationPanelProps } from "../conversation-types.js";
import { PresentationEntryComponent } from "./presentation-entry.js";
import { ScrollViewport } from "../../display/primitives/scroll-viewport.js";

function LogoBlock(
  { lines, gradient }: { lines: readonly string[]; gradient: readonly string[] },
): React.ReactElement {
  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="column" width="100%" paddingBottom={1}>
      {lines.map((line, index) => (
        <text key={`logo-${index}`} fg={gradient[index]} content={line} />
      ))}
    </box>
  );
}

function PresentationPanelInner(
  {
    items,
    colors,
    contentWidth,
    markdownMode,
    markdownStyle,
    scrollRef,
    selectedChildId,
    showLogoInScroll,
    branding,
    onEntryClick,
  }: PresentationPanelProps,
): React.ReactElement {
  return (
    <ScrollViewport
      colors={colors}
      scrollRef={scrollRef}
      stickyScroll={true}
      stickyStart="bottom"
    >
      <box flexDirection="column" gap={0}>
        {showLogoInScroll ? <LogoBlock lines={branding.logoLines} gradient={branding.logoGradient} /> : null}
        {selectedChildId ? (
          <box flexDirection="column" paddingLeft={2} paddingBottom={1}>
            <text fg={colors.accent} bold content={`SUB-SESSION ${selectedChildId}`} />
            <text fg={colors.dim} content="Esc back to primary session · Ctrl+C interrupt child turn" />
          </box>
        ) : null}
        {items.map((entry) => (
          <PresentationEntryComponent
            key={entry.id}
            entry={entry}
            colors={colors}
            contentWidth={contentWidth}
            markdownMode={markdownMode}
            markdownStyle={markdownStyle}
            onEntryClick={onEntryClick}
          />
        ))}
      </box>
    </ScrollViewport>
  );
}

export const PresentationPanel = React.memo(
  PresentationPanelInner,
  (previous, next) => (
    previous.items === next.items
    && previous.processing === next.processing
    && previous.contentWidth === next.contentWidth
    && previous.markdownMode === next.markdownMode
    && previous.colors === next.colors
    && previous.markdownStyle === next.markdownStyle
    && previous.scrollRef === next.scrollRef
    && previous.selectedChildId === next.selectedChildId
    && previous.showLogoInScroll === next.showLogoInScroll
    && previous.branding === next.branding
  ),
);
