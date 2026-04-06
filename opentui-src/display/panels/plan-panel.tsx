/** @jsxImportSource @opentui/react */

import React, { useState } from "react";
import { StyledText, RGBA, createTextAttributes, type TextChunk } from "@opentui/core";
import { useShimmer } from "../../presentation/use-shimmer.js";

import type { PlanCheckpoint } from "../../../src/plan-state.js";

// ── Color spec ───────────────────────────────────────────────
const COLORS = {
  label: RGBA.fromHex("#5a6078"),
  countDigit: RGBA.fromHex("#e8e8e8"),
  countSlash: RGBA.fromHex("#4a4a5c"),
  barDone: RGBA.fromHex("#8ab4f8"),
  barActive: RGBA.fromHex("#4a5d81"),
  barPending: RGBA.fromHex("#282838"),
  stateSummary: RGBA.fromHex("#4a5468"),

  doneMark: RGBA.fromHex("#4e6a88"),
  doneText: RGBA.fromHex("#4a4a58"),

  activeMark: RGBA.fromHex("#8ab4f8"),
  activeText: RGBA.fromHex("#c8d8ea"),

  pendingMark: RGBA.fromHex("#3a3a48"),
  pendingText: RGBA.fromHex("#3a3a48"),
} as const;

const SHIMMER_BASE = RGBA.fromHex("#4a5468");

const ATTRS_BOLD = createTextAttributes({ bold: true });
const ATTRS_STRIKE = createTextAttributes({ strikethrough: true });

// ── Glyphs ───────────────────────────────────────────────────
const BAR_CHAR = "━";
const MARK_DONE = "✓";
const MARK_ACTIVE = "▸";
const MARK_PENDING = "◇";

// ── Helpers ──────────────────────────────────────────────────

function chunk(text: string, fg?: RGBA, attributes?: number): TextChunk {
  return { __isChunk: true as const, text, fg, attributes };
}

// ── Progress bar header ──────────────────────────────────────

function PlanBarLine({
  checkpoints,
  contentWidth,
  hovered,
  onToggle,
  onMouseOver,
  onMouseOut,
}: {
  checkpoints: readonly PlanCheckpoint[];
  contentWidth: number;
  hovered: boolean;
  onToggle: () => void;
  onMouseOver: () => void;
  onMouseOut: () => void;
}): React.ReactNode {
  const total = checkpoints.length;
  const doneCount = checkpoints.filter((c) => c.status === "done").length;
  const activeCount = checkpoints.filter((c) => c.status === "active").length;

  // Right side: shimmer "3 active" or nothing
  const activeLabel = activeCount > 0 ? `${activeCount} active` : "";
  const shimmer = useShimmer(activeLabel, SHIMMER_BASE, activeCount > 0);

  // Left fixed: "PLAN  9/9  "
  const prefixStr = "PLAN  ";
  const doneStr = `${doneCount}`;
  const slashStr = "/";
  const totalStr = `${total}`;
  const gapStr = "  ";
  const leftFixedLen = prefixStr.length + doneStr.length + slashStr.length + totalStr.length + gapStr.length;

  // Right fixed: "  3 active"
  const rightFixedLen = activeLabel ? activeLabel.length + 2 : 0;

  // Bar takes ~half of the remaining space
  const available = Math.max(4, contentWidth - leftFixedLen - rightFixedLen);
  const barLen = Math.max(2, Math.round(available * 0.5));

  const segDone = Math.round((doneCount / total) * barLen);
  const segActive = Math.round((activeCount / total) * barLen);
  const segPending = Math.max(0, barLen - segDone - segActive);

  const barChunks: TextChunk[] = [
    chunk(prefixStr, COLORS.label),
    chunk(doneStr, COLORS.countDigit, ATTRS_BOLD),
    chunk(slashStr, COLORS.countSlash),
    chunk(totalStr, COLORS.countDigit, ATTRS_BOLD),
    chunk(gapStr),
  ];
  if (segDone > 0) barChunks.push(chunk(BAR_CHAR.repeat(segDone), COLORS.barDone));
  if (segActive > 0) barChunks.push(chunk(BAR_CHAR.repeat(segActive), COLORS.barActive));
  if (segPending > 0) barChunks.push(chunk(BAR_CHAR.repeat(segPending), COLORS.barPending));

  const barContent = new StyledText(barChunks);

  return (
    <box
      flexDirection="row"
      width="100%"
      flexShrink={0}
      backgroundColor={hovered ? "#252535" : undefined}
      onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onToggle(); }}
      onMouseOver={onMouseOver}
      onMouseOut={onMouseOut}
    >
      <text content={barContent} truncate />
      <box flexGrow={1} />
      {activeLabel ? <text content={shimmer} /> : null}
    </box>
  );
}

// ── Checkpoint rows ──────────────────────────────────────────

function buildCheckpointStyledText(cp: PlanCheckpoint): StyledText {
  switch (cp.status) {
    case "done":
      return new StyledText([
        chunk(`  ${MARK_DONE} `, COLORS.doneMark),
        chunk(cp.text, COLORS.doneText, ATTRS_STRIKE),
      ]);
    case "active":
      return new StyledText([
        chunk(`  ${MARK_ACTIVE} `, COLORS.activeMark),
        chunk(cp.text, COLORS.activeText),
      ]);
    default:
      return new StyledText([
        chunk(`  ${MARK_PENDING} `, COLORS.pendingMark),
        chunk(cp.text, COLORS.pendingText),
      ]);
  }
}

// ── Main panel ───────────────────────────────────────────────

export interface PlanPanelProps {
  checkpoints: readonly PlanCheckpoint[];
  expanded: boolean;
  contentWidth: number;
  onToggle: () => void;
}

export function PlanPanel({
  checkpoints,
  expanded,
  contentWidth,
  onToggle,
}: PlanPanelProps): React.ReactNode {
  if (checkpoints.length === 0) return null;

  const [hovered, setHovered] = useState(false);
  const innerWidth = Math.max(20, contentWidth - 2);

  // Sort: undone (active + pending) first in original order, then done in original order
  const undone = checkpoints
    .map((cp, i) => ({ cp, i }))
    .filter(({ cp }) => cp.status !== "done");
  const done = checkpoints
    .map((cp, i) => ({ cp, i }))
    .filter(({ cp }) => cp.status === "done");
  const sorted = [...undone, ...done];

  return (
    <box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
      gap={0}
    >
      <PlanBarLine
        checkpoints={checkpoints}
        contentWidth={innerWidth}
        hovered={hovered}
        onToggle={onToggle}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
      />
      {expanded ? (
        sorted.map(({ cp, i }) => (
          <text
            key={`cp-${i}`}
            content={buildCheckpointStyledText(cp)}
            truncate
          />
        ))
      ) : null}
    </box>
  );
}
