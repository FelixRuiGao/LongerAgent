/** @jsxImportSource opentui-jsx */


import * as React from "react";

import type { DisplayThemeColorTokens } from "../theme/index.js";

interface ScrollViewportProps {
  colors: DisplayThemeColorTokens;
  scrollRef: React.RefObject<any>;
  stickyScroll?: boolean;
  stickyStart?: "top" | "bottom";
  viewportPaddingRight?: number;
  children: React.ReactNode;
}

export function ScrollViewport({
  colors,
  scrollRef,
  stickyScroll = false,
  stickyStart = "bottom",
  viewportPaddingRight = 1,
  children,
}: ScrollViewportProps): React.ReactNode {
  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      flexShrink={1}
      stickyScroll={stickyScroll}
      stickyStart={stickyStart}
      viewportOptions={{ paddingRight: viewportPaddingRight }}
      verticalScrollbarOptions={{
        paddingLeft: 1,
        trackOptions: {
          backgroundColor: "transparent",
          foregroundColor: colors.scrollbarTrack,
        },
      }}
    >
      {children}
    </scrollbox>
  );
}
