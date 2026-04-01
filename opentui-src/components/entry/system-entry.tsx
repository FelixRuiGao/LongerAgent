/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import { StyledText, RGBA } from "@opentui/core";
import type { TextChunk } from "../../forked/core/text-buffer.js";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { DEFAULT_DISPLAY_THEME } from "../../display/theme/index.js";
import { getSystemEntryColor } from "../../display/entries/entry-variants.js";

const NO_REPLY_LABEL = "NO REPLY";

function buildGradientLabel(label: string, gradient: readonly string[]): StyledText {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < label.length; i++) {
    const colorIdx = Math.floor((i / Math.max(1, label.length - 1)) * (gradient.length - 1));
    const fg = RGBA.fromHex(gradient[colorIdx]);
    chunks.push({ __isChunk: true, text: label[i], fg });
  }
  return new StyledText(chunks);
}

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

  if (severity === "no_reply") {
    const fullGradient = DEFAULT_DISPLAY_THEME.branding.logoGradient;
    // Use brighter portion of gradient — skip the darkest tail
    const gradient = useMemo(() => fullGradient.slice(0, 5), [fullGradient]);
    const gradientLabel = useMemo(
      () => buildGradientLabel(NO_REPLY_LABEL, gradient),
      [gradient],
    );
    // Strip any prefix like "[No reply] " from text to get the message part
    const message = text.replace(/^\[.*?\]\s*/, "");
    return (
      <box paddingLeft={1} paddingTop={1} width="100%" flexDirection="row">
        <text content={gradientLabel} bold />
        <text fg={colors.text} content={`  ${message}`} />
      </box>
    );
  }

  switch (severity) {
    case "error":
      return (
        <box paddingLeft={1} paddingTop={1} width="100%">
          <text fg={fg} bold content={`[!] ${text}`} />
        </box>
      );

    case "interrupted":
      return (
        <box paddingLeft={1} width="100%">
          <text fg={fg} content={text} />
        </box>
      );

    case "sub_agent":
      return (
        <box flexDirection="column" paddingLeft={1} width="100%">
          <text fg={fg} content={text} />
        </box>
      );

    case "compact":
      return (
        <box paddingLeft={1} paddingTop={1} width="100%">
          <text fg={fg} content={text} />
        </box>
      );

    default:
      return (
        <box paddingLeft={1} paddingTop={1} width="100%">
          <text fg={fg} content={text} />
        </box>
      );
  }
}

export const SystemEntry = React.memo(
  SystemEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
