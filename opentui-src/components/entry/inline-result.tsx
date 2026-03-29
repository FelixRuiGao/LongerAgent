/** @jsxImportSource @opentui/react */

import React, { useMemo } from "react";

import type { InlineResultData } from "../../presentation/types.js";
import { SUCCESS_COLOR, ERROR_COLOR } from "../../presentation/colors.js";
import type { ConversationPalette } from "../conversation-types.js";
import { buildToolResultArtifacts, type ToolResultLineArtifact } from "../tool-result-artifacts.js";

interface InlineResultProps {
  data: InlineResultData;
  colors: ConversationPalette;
  contentWidth: number;
}

const TREE_PREFIX_FIRST = "└ ";
const TREE_PREFIX_REST = "  ";

/** Count added/removed lines from raw diff text. */
function countDiffLines(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

/** Filter out --- and +++ header lines from diff artifacts. */
function filterDiffHeaders(artifacts: ToolResultLineArtifact[]): ToolResultLineArtifact[] {
  return artifacts.filter((a) => {
    const firstChunk = a.content.chunks[0];
    if (!firstChunk) return true;
    const text = firstChunk.text;
    return !text.startsWith("--- ") && !text.startsWith("+++ ");
  });
}

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
    const isDiff = data.text.includes("--- ") && data.text.includes("+++ ");
    const filteredArtifacts = isDiff ? filterDiffHeaders(artifacts) : artifacts;
    const diffCounts = isDiff ? countDiffLines(data.text) : null;

    const visibleArtifacts = filteredArtifacts.slice(0, data.maxLines);
    const artifactHiddenCount = Math.max(0, filteredArtifacts.length - data.maxLines);

    return (
      <box flexDirection="column" paddingLeft={4} gap={0}>
        {/* Diff summary line: └ (-N +M) */}
        {diffCounts ? (
          <box flexDirection="row" width="100%">
            <text fg={colors.dim} content={TREE_PREFIX_FIRST} />
            <text fg={colors.dim} content="(" />
            <text fg={ERROR_COLOR} content={`-${diffCounts.removed}`} />
            <text fg={colors.dim} content=" " />
            <text fg={SUCCESS_COLOR} content={`+${diffCounts.added}`} />
            <text fg={colors.dim} content=")" />
          </box>
        ) : null}
        {visibleArtifacts.map((artifact, idx) => (
          <box
            key={idx}
            flexDirection="row"
            width="100%"
            backgroundColor={artifact.rowBackgroundColor}
          >
            <text
              fg={colors.dim}
              content={!diffCounts && idx === 0 ? TREE_PREFIX_FIRST : TREE_PREFIX_REST}
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
