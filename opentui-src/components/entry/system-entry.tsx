/** @jsxImportSource @opentui/react */

import React from "react";

import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { DEFAULT_DISPLAY_THEME } from "../../display/theme/index.js";
import { getSystemEntryColor } from "../../display/entries/entry-variants.js";

interface SystemEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
}

function SystemEntryInner(
  { entry, colors }: SystemEntryProps,
): React.ReactElement {
  const text = entry.systemText ?? "";
  const severity = entry.systemSeverity ?? "info";
  const fg = getSystemEntryColor(severity, DEFAULT_DISPLAY_THEME);

  switch (severity) {
    case "error":
      return (
        <box paddingLeft={2} paddingTop={1} width="100%">
          <text fg={fg} bold content={`[!] ${text}`} />
        </box>
      );

    case "interrupted":
      return (
        <box paddingLeft={2} width="100%">
          <text fg={fg} content={text} />
        </box>
      );

    case "sub_agent":
      return (
        <box flexDirection="column" paddingLeft={2} width="100%">
          <text fg={fg} content={text} />
        </box>
      );

    case "compact":
      return (
        <box paddingLeft={2} paddingTop={1} width="100%">
          <text fg={fg} content={text} />
        </box>
      );

    default:
      return (
        <box paddingLeft={2} paddingTop={1} width="100%">
          <text fg={fg} content={text} />
        </box>
      );
  }
}

export const SystemEntry = React.memo(
  SystemEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
