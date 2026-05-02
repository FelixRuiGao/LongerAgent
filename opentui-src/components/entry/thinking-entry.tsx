/** @jsxImportSource @opentui/react */

import React from "react";

import { RGBA, createTextAttributes } from "@opentui/core";
import type { PresentationEntry } from "../../presentation/types.js";
import { useShimmer } from "../../presentation/use-shimmer.js";
import type { ConversationPalette } from "../conversation-types.js";
import { SelectableRow } from "../../display/primitives/selectable-row.js";

interface ThinkingEntryProps {
  entry: PresentationEntry;
  colors: ConversationPalette;
  onEntryClick?: (entry: PresentationEntry) => void;
}

const LABEL_COLOR = "#7a8098";
const LABEL_RGBA = RGBA.fromHex(LABEL_COLOR);
const BODY_COLOR = "#5a6078";
const ATTRS_ITALIC = createTextAttributes({ italic: true });

const THINKING_PREVIEW_LINES = 10;
const LABEL_TEXT = "Thinking: ";

function ThinkingEntryInner(
  { entry, colors, onEntryClick }: ThinkingEntryProps,
): React.ReactNode {
  const active = entry.state === "active";
  const shimmer = useShimmer(LABEL_TEXT, LABEL_RGBA, active, ATTRS_ITALIC);
  const fullText = entry.thinkingFullText ?? "";
  const hasBody = fullText.trim().length > 0;
  const lines = fullText.split("\n");
  const truncated = lines.length > THINKING_PREVIEW_LINES;
  const visibleLines = truncated ? lines.slice(0, THINKING_PREVIEW_LINES) : lines;
  const hiddenCount = Math.max(0, lines.length - THINKING_PREVIEW_LINES);

  const isError = entry.state === "error";
  const firstLine = visibleLines[0] ?? "";
  const restLines = visibleLines.slice(1);

  return (
    <box
      flexDirection="column"
      paddingTop={1}
      width="100%"
      gap={0}
    >
      {/* Row 1: label (shimmer when active, static when done) + first body line inline */}
      <box flexDirection="row" width="100%">
        {active ? (
          <text content={shimmer} flexShrink={0} />
        ) : (
          <text
            fg={LABEL_COLOR}
            attributes={ATTRS_ITALIC}
            content={LABEL_TEXT}
            flexShrink={0}
          />
        )}
        {hasBody ? (
          <text
            fg={BODY_COLOR}
            attributes={ATTRS_ITALIC}
            content={firstLine}
            wrapMode="char"
          />
        ) : null}
      </box>

      {/* Remaining body lines, flush-left */}
      {hasBody && restLines.length > 0 ? (
        <box flexDirection="column" gap={0}>
          {restLines.map((line, idx) => (
            <box key={idx + 1} flexDirection="row" width="100%">
              <text
                fg={BODY_COLOR}
                attributes={ATTRS_ITALIC}
                content={line}
                wrapMode="char"
              />
            </box>
          ))}
        </box>
      ) : null}

      {/* Truncation hint */}
      {hasBody && truncated ? (
        <SelectableRow
          hoverBackgroundColor={colors.border}
          onPress={onEntryClick ? () => onEntryClick(entry) : undefined}
        >
          <text
            fg={BODY_COLOR}
            attributes={ATTRS_ITALIC}
            content={`... (${hiddenCount} more lines${onEntryClick ? ", CLICK to open" : ""})`}
          />
        </SelectableRow>
      ) : null}

      {/* Interrupted marker — orange, non-italic to stand out */}
      {isError ? (
        <text
          fg={colors.orange}
          content="[Interrupted — not sent to model]"
        />
      ) : null}
    </box>
  );
}

export const ThinkingEntry = React.memo(
  ThinkingEntryInner,
  (prev, next) => prev.entry === next.entry && prev.colors === next.colors,
);
