/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationPanelProps } from "../conversation-types.js";
import { PresentationEntryComponent } from "./presentation-entry.js";

const LOGO_LINES = [
  "▒██    ▒██ ▒██████  ▒██████  ▒██████▒██         ",
  "▒██    ▒██   ▒██   ▒██   ▒██   ▒██  ▒██         ",
  "▒██    ▒██   ▒██  ▒██          ▒██  ▒██         ",
  "▒██    ▒██   ▒██  ▒██  █████   ▒██  ▒██         ",
  " ▒██  ▒██    ▒██  ▒██     ██   ▒██  ▒██         ",
  "  ▒██▒██     ▒██   ▒██  ▒███   ▒██  ▒██         ",
  "   ▒███    ▒██████  ▒█████▒█ ▒██████▒██████████ ",
];
const LOGO_GRADIENT = ["#ffb703", "#fb8500", "#f05030", "#e81860", "#d01080", "#a010a0", "#5a0c92"];

function LogoBlock(): React.ReactElement {
  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="column" width="100%" paddingBottom={1}>
      {LOGO_LINES.map((line, index) => (
        <text key={`logo-${index}`} fg={LOGO_GRADIENT[index]} content={line} />
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
  }: PresentationPanelProps,
): React.ReactElement {
  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      flexShrink={1}
      stickyScroll={true}
      stickyStart="bottom"
      viewportOptions={{ paddingRight: 1 }}
      verticalScrollbarOptions={{
        paddingLeft: 1,
        trackOptions: {
          backgroundColor: "transparent",
          foregroundColor: colors.border + "44",
        },
      }}
    >
      <box flexDirection="column" gap={0}>
        {showLogoInScroll ? <LogoBlock /> : null}
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
          />
        ))}
      </box>
    </scrollbox>
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
  ),
);
