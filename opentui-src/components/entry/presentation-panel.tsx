/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationPanelProps } from "../conversation-types.js";
import { PresentationEntryComponent } from "./presentation-entry.js";

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

/**
 * Pure entry list — renders logo, sub-session indicator, and conversation entries.
 * Does NOT own a scrollbox; the parent (OpenTuiScreen) wraps this in a ScrollViewport.
 */
function PresentationPanelInner(
  {
    items,
    colors,
    contentWidth,
    markdownMode,
    markdownStyle,
    selectedChildId,
    showLogoInScroll,
    branding,
    onEntryClick,
    onAgentClick,
  }: PresentationPanelProps,
): React.ReactElement {
  return (
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
          onAgentClick={onAgentClick}
        />
      ))}
    </box>
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
    && previous.selectedChildId === next.selectedChildId
    && previous.showLogoInScroll === next.showLogoInScroll
    && previous.branding === next.branding
  ),
);
