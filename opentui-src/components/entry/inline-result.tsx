/** @jsxImportSource @opentui/react */

import React, { useState, useMemo } from "react";

import type { InlineResultData } from "../../presentation/types.js";
import type { ConversationPalette } from "../conversation-types.js";
import { buildToolResultArtifacts, type ToolResultLineArtifact } from "../tool-result-artifacts.js";

/** Clickable fold indicator with hover highlight. */
function FoldIndicator(
  { text, colors, onClick }: { text: string; colors: ConversationPalette; onClick?: () => void },
): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  return (
    <box
      flexDirection="row"
      width="100%"
      backgroundColor={hovered && onClick ? colors.border : undefined}
      onMouseOver={onClick ? () => setHovered(true) : undefined}
      onMouseOut={onClick ? () => setHovered(false) : undefined}
      onMouseDown={onClick ? (e: any) => { e.stopPropagation(); onClick(); } : undefined}
    >
      <text fg={colors.dim} content={text} />
    </box>
  );
}

interface InlineResultProps {
  data: InlineResultData;
  colors: ConversationPalette;
  contentWidth: number;
  onOpenDetail?: () => void;
}

const LINE_PREFIX = "  ";
const MAX_LINES_PER_HUNK = 20;
const CONTEXT_LINES = 3;



interface Hunk {
  artifacts: ToolResultLineArtifact[];
  isChanged: boolean;
}

/**
 * Split artifacts into hunks. A "changed" hunk contains lines with row
 * background color (additions/deletions). Consecutive unchanged context
 * lines form a separate "unchanged" hunk.
 */
function splitIntoHunks(artifacts: ToolResultLineArtifact[]): Hunk[] {
  const hunks: Hunk[] = [];
  let current: ToolResultLineArtifact[] = [];
  let currentIsChanged = false;

  for (const artifact of artifacts) {
    const isChanged = !!artifact.rowBackgroundColor;
    if (current.length > 0 && isChanged !== currentIsChanged) {
      hunks.push({ artifacts: current, isChanged: currentIsChanged });
      current = [];
    }
    currentIsChanged = isChanged;
    current.push(artifact);
  }
  if (current.length > 0) {
    hunks.push({ artifacts: current, isChanged: currentIsChanged });
  }
  return hunks;
}

function InlineResultInner(
  { data, colors, contentWidth, onOpenDetail }: InlineResultProps,
): React.ReactElement {
  const artifacts = useMemo(() => {
    if (data.toolMetadata) {
      return buildToolResultArtifacts({
        text: data.text,
        dim: data.dim,
        toolMetadata: data.toolMetadata,
        wrapWidth: Math.max(8, contentWidth - 8),
        colors,
        codePreviewOnly: data.noDiffBackground,
      });
    }
    return null;
  }, [data.text, data.dim, data.toolMetadata, data.noDiffBackground, contentWidth, colors]);

  if (artifacts) {
    const isDiff = artifacts.some((a) => !!a.rowBackgroundColor);

    if (isDiff) {
      const hunks = splitIntoHunks(artifacts);
      const elements: React.ReactElement[] = [];
      let elementKey = 0;

      const pushSeparator = () => {
        elements.push(
          <box key={`sep-${elementKey++}`} flexDirection="row" width="100%">
            <text fg={colors.dim} content={`${LINE_PREFIX}⋮`} />
          </box>,
        );
      };

      const pushArtifact = (artifact: ToolResultLineArtifact) => {
        elements.push(
          <box
            key={`a-${elementKey++}`}
            flexDirection="row"
            width="100%"
            backgroundColor={artifact.rowBackgroundColor}
          >
            <text fg={colors.dim} content={LINE_PREFIX} />
            <text content={artifact.content} wrapMode="none" />
          </box>,
        );
      };

      for (let hi = 0; hi < hunks.length; hi++) {
        const hunk = hunks[hi];
        const isFirst = hi === 0;
        const isLast = hi === hunks.length - 1;

        if (!hunk.isChanged) {
          // Unchanged context hunk: show up to CONTEXT_LINES at each edge
          const n = hunk.artifacts.length;
          const prevIsChanged = hi > 0 && hunks[hi - 1].isChanged;
          const nextIsChanged = hi < hunks.length - 1 && hunks[hi + 1].isChanged;

          if (isFirst) {
            // Leading context: ⋮ then last CONTEXT_LINES
            pushSeparator();
            const start = Math.max(0, n - CONTEXT_LINES);
            for (let j = start; j < n; j++) pushArtifact(hunk.artifacts[j]);
          } else if (isLast) {
            // Trailing context: first CONTEXT_LINES then ⋮
            const end = Math.min(n, CONTEXT_LINES);
            for (let j = 0; j < end; j++) pushArtifact(hunk.artifacts[j]);
            pushSeparator();
          } else if (n <= CONTEXT_LINES * 2) {
            // Between two changed hunks, small gap: show all
            for (const a of hunk.artifacts) pushArtifact(a);
          } else {
            // Between two changed hunks, large gap: first N + ⋮ + last N
            for (let j = 0; j < CONTEXT_LINES; j++) pushArtifact(hunk.artifacts[j]);
            pushSeparator();
            for (let j = n - CONTEXT_LINES; j < n; j++) pushArtifact(hunk.artifacts[j]);
          }
          continue;
        }

        // If first hunk is changed, add leading ⋮
        if (isFirst) pushSeparator();

        // Changed hunk: truncate at MAX_LINES_PER_HUNK
        const visible = hunk.artifacts.slice(0, MAX_LINES_PER_HUNK);
        const hidden = hunk.artifacts.length - visible.length;

        for (const artifact of visible) pushArtifact(artifact);

        if (hidden > 0) {
          const hasMoreChangedHunks = hunks.slice(hi + 1).some((h) => h.isChanged);
          const clickSuffix = !hasMoreChangedHunks && onOpenDetail
            ? ", CLICK to open"
            : "";
          elements.push(
            <FoldIndicator
              key={`fold-${elementKey++}`}
              text={`${LINE_PREFIX}... (${hidden} more changed lines${clickSuffix})`}
              colors={colors}
              onClick={onOpenDetail && !hasMoreChangedHunks ? onOpenDetail : undefined}
            />,
          );
        }

        // If last hunk is changed, add trailing ⋮
        if (isLast) pushSeparator();
      }

      return (
        <box flexDirection="column" paddingLeft={4} gap={0}>
          {elements}
        </box>
      );
    }

    // Non-diff artifacts (plain tool result with metadata, or Create/Overwrite with stripped bg)
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
              content={LINE_PREFIX}
            />
            <text content={artifact.content} wrapMode="none" />
          </box>
        ))}
        {artifactHiddenCount > 0 && (
          <FoldIndicator
            text={`${LINE_PREFIX}... (${artifactHiddenCount} more lines${onOpenDetail ? ", CLICK to open" : ""})`}
            colors={colors}
            onClick={onOpenDetail}
          />
        )}
      </box>
    );
  }

  // Plain text inline result (no toolMetadata)
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
            content={LINE_PREFIX}
          />
          <text fg={textColor} content={line} wrapMode="none" />
        </box>
      ))}
      {hiddenCount > 0 && (
        <FoldIndicator
          text={`${LINE_PREFIX}... (${hiddenCount} more lines${onOpenDetail ? ", CLICK to open" : ""})`}
          colors={colors}
          onClick={onOpenDetail}
        />
      )}
    </box>
  );
}

export const InlineResult = React.memo(
  InlineResultInner,
  (prev, next) =>
    prev.data === next.data
    && prev.colors === next.colors
    && prev.contentWidth === next.contentWidth
    && prev.onOpenDetail === next.onOpenDetail,
);
