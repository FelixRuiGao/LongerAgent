/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import type { InlineResultData } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { buildToolResultArtifacts } from "../tool-result-artifacts.js";

interface InlineResultProps {
  data: InlineResultData;
  colors: ConversationPalette;
  contentWidth: number;
}

const TREE_PREFIX_FIRST = "└─ ";
const TREE_PREFIX_REST = "   ";

function InlineResultInner(
  { data, colors, contentWidth }: InlineResultProps,
): React.ReactElement {
  // For diff-type results, use existing artifact builder
  const artifacts = useMemo(() => {
    if (data.toolMetadata) {
      return buildToolResultArtifacts({
        text: data.text,
        dim: data.dim,
        toolMetadata: data.toolMetadata,
        wrapWidth: Math.max(8, contentWidth - 8),
        colors,
      });
    }
    return null;
  }, [data.text, data.dim, data.toolMetadata, contentWidth, colors]);

  if (artifacts) {
    const visibleArtifacts = artifacts.slice(0, data.maxLines);
    const artifactHiddenCount = Math.max(0, artifacts.length - data.maxLines);

    return (
      <box flexDirection="column" paddingLeft={4} gap={0}>
        {visibleArtifacts.map((artifact, idx) => (
          <box
            key={idx}
            flexDirection="row"
            width="100%"
            backgroundColor={artifact.rowBackgroundColor}
          >
            <text
              fg={colors.dim}
              content={idx === 0 ? TREE_PREFIX_FIRST : TREE_PREFIX_REST}
            />
            <text content={artifact.content} wrapMode="none" />
          </box>
        ))}
        {artifactHiddenCount > 0 && (
          <box flexDirection="row" width="100%" hoverStyle={{ backgroundColor: colors.border }}>
            <text fg={colors.dim} content={`${TREE_PREFIX_REST}... (${artifactHiddenCount} more lines)`} />
          </box>
        )}
      </box>
    );
  }

  // Plain text inline result
  const textColor = data.dim ? colors.dim : colors.text;
  const lines = data.text.split("\n");
  const visibleLines = lines.slice(0, data.maxLines);
  const hiddenCount = Math.max(0, lines.length - data.maxLines);

  return (
    <box flexDirection="column" paddingLeft={4} gap={0}>
      {visibleLines.map((line, idx) => (
        <box key={idx} flexDirection="row" width="100%">
          <text
            fg={colors.dim}
            content={idx === 0 ? TREE_PREFIX_FIRST : TREE_PREFIX_REST}
          />
          <text fg={textColor} content={line} wrapMode="none" />
        </box>
      ))}
      {hiddenCount > 0 && (
        <box flexDirection="row" width="100%" hoverStyle={{ backgroundColor: colors.border }}>
          <text fg={colors.dim} content={`${TREE_PREFIX_REST}... (${hiddenCount} more lines)`} />
        </box>
      )}
    </box>
  );
}

export const InlineResult = React.memo(
  InlineResultInner,
  (prev, next) =>
    prev.data === next.data
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth,
);
