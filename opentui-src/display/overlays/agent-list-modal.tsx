/** @jsxImportSource opentui-jsx */


import * as React from "react";
import { RGBA, createTextAttributes } from "../../core/index.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });
const ATTRS_NONE = createTextAttributes({});
import type { ChildSessionSnapshot } from "../../../src/session-tree-types.js";
import type { DisplayThemeColorTokens } from "../theme/types.js";
import { CenteredModal } from "./centered-modal.js";
import { formatCompactTokensShort } from "../utils/format.js";

export interface AgentListModalProps {
  visible: boolean;
  agents: readonly ChildSessionSnapshot[];
  selectedIndex: number;
  terminalWidth: number;
  terminalHeight: number;
  colors: DisplayThemeColorTokens;
  onClose: () => void;
  onSelect: (agentId: string) => void;
}

function lifecycleIcon(lifecycle: string): string {
  switch (lifecycle) {
    case "running": return "●";
    case "idle": return "○";
    default: return "◌";
  }
}

function lifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case "running": return "running";
    case "idle": return "idle";
    default: return "done";
  }
}

function lifecycleColor(lifecycle: string, colors: DisplayThemeColorTokens): string {
  switch (lifecycle) {
    case "running": return colors.workingStatus;
    case "idle": return colors.green;
    default: return colors.muted;
  }
}

/**
 * A single row in the agent list — one line:
 *   ● agent-name                   running  model-name
 * Selected row gets accent background, OpenCode style.
 */
function AgentRow({
  agent,
  selected,
  colors,
  onClick,
}: {
  agent: ChildSessionSnapshot;
  selected: boolean;
  colors: DisplayThemeColorTokens;
  onClick: () => void;
}): React.ReactNode {
  const icon = lifecycleIcon(agent.lifecycle);
  const label = lifecycleLabel(agent.lifecycle);
  const statusColor = lifecycleColor(agent.lifecycle, colors);
  // Selected row: dark text on accent background (accent = #ffb703 golden)
  const SELECTED_FG = "#1a1620";
  const fg = selected ? SELECTED_FG : colors.text;
  const descFg = selected ? SELECTED_FG : colors.muted;
  const selectedBg = colors.accent;

  const statsLine = `└ ${agent.lifetimeToolCallCount} tools used, ${formatCompactTokensShort(agent.lastTotalTokens)} tokens`;

  return (
    <box
      flexDirection="column"
      width="100%"
      backgroundColor={selected ? selectedBg : RGBA.fromInts(0, 0, 0, 0)}
      paddingLeft={2}
      paddingRight={2}
      onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onClick(); }}
    >
      {/* Primary row: icon name [label] — left-aligned together */}
      <box flexDirection="row" width="100%">
        <text fg={selected ? fg : statusColor} content={`${icon} `} flexShrink={0} />
        <text
          fg={fg}
          attributes={selected ? ATTRS_BOLD : ATTRS_NONE}
          content={agent.id}
          flexShrink={1}
          truncate
        />
        <text fg={selected ? fg : statusColor} content={` [${label}]`} flexShrink={0} />
        <box flexGrow={1} />
      </box>
      {/* Secondary row: └ N tools used, Xk tokens */}
      <box flexDirection="row" width="100%" paddingLeft={2}>
        <text fg={descFg} content={statsLine} truncate />
      </box>
    </box>
  );
}

export function AgentListModal({
  visible,
  agents,
  selectedIndex,
  terminalWidth,
  terminalHeight,
  colors,
  onClose,
  onSelect,
}: AgentListModalProps): React.ReactNode {
  if (!visible || agents.length === 0) return null;

  const modalWidth = Math.min(60, terminalWidth - 2);
  // 2 lines per agent + 3 for header/padding; minimum 10 lines, capped at half terminal
  const contentHeight = agents.length * 2 + 3;
  const modalHeight = Math.min(
    Math.max(contentHeight, 10),
    Math.floor(terminalHeight / 2),
  );

  return (
    <CenteredModal
      visible={visible}
      title="SUB AGENTS"
      width={modalWidth}
      height={modalHeight}
      terminalWidth={terminalWidth}
      terminalHeight={terminalHeight}
      colors={colors}
    >
      {agents.map((agent, index) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          selected={index === selectedIndex}
          colors={colors}
          onClick={() => onSelect(agent.id)}
        />
      ))}
    </CenteredModal>
  );
}
