/** @jsxImportSource @opentui/react */

import React from "react";

import { ConversationEntry } from "./conversation-entry.js";
import type { ConversationPanelProps } from "./conversation-types.js";

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

function ConversationPanelInner(
  {
    items,
    colors,
    contentWidth,
    markdownMode,
    markdownStyle,
    processing,
    scrollRef,
    selectedChildId,
    showLogoInScroll,
  }: ConversationPanelProps,
): React.ReactElement {
  const lastAssistantIndex = [...items]
    .map((item, index) => ({ item, index }))
    .reverse()
    .find(({ item }) => item.entry.kind === "assistant")?.index ?? -1;

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
        {items.map((item, index) => {
          const previousItem = index > 0 ? items[index - 1] : null;
          const needsSpacing = item.entry.kind === "reasoning" && (
            previousItem?.entry.kind === "progress"
            || previousItem?.entry.kind === "tool_call"
          );

          return (
            <ConversationEntry
              key={item.id}
              item={item}
              streaming={processing && index === lastAssistantIndex}
              markdownMode={markdownMode}
              colors={colors}
              contentWidth={contentWidth}
              markdownStyle={markdownStyle}
              needsSpacing={needsSpacing}
            />
          );
        })}
      </box>
    </scrollbox>
  );
}

export const ConversationPanel = React.memo(
  ConversationPanelInner,
  (previous, next) => (
    previous.items === next.items
    && previous.processing === next.processing
    && previous.markdownMode === next.markdownMode
    && previous.colors === next.colors
    && previous.markdownStyle === next.markdownStyle
    && previous.scrollRef === next.scrollRef
    && previous.selectedChildId === next.selectedChildId
    && previous.showLogoInScroll === next.showLogoInScroll
  ),
);
