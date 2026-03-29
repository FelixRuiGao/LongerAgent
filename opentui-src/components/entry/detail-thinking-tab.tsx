/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";

interface DetailThinkingTabProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  scrollRef: React.RefObject<any>;
}

function DetailThinkingTabInner(
  { entry, colors, scrollRef }: DetailThinkingTabProps,
): React.ReactElement {
  const text = entry.thinkingFullText ?? "";

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box paddingLeft={2} paddingBottom={1}>
        <text fg={colors.dim} bold content="Thinking" />
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
        <box paddingLeft={2} paddingRight={2}>
          <text fg={colors.dim} content={text} />
        </box>
      </scrollbox>
    </box>
  );
}

export const DetailThinkingTab = React.memo(
  DetailThinkingTabInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
