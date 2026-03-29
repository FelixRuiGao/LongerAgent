/** @jsxImportSource @opentui/react */

import React from "react";

import type { ConversationPalette } from "../components/conversation-types.js";
import { SidebarTabs, type TabState } from "./sidebar-tabs.js";

const SIDEBAR_EXPANDED_WIDTH = 22;
const SIDEBAR_COLLAPSED_WIDTH = 4;

const LOGO_GRADIENT = ["#ffb703", "#fb8500", "#f05030", "#e81860", "#d01080", "#a010a0", "#5a0c92"];

interface SidebarProps {
  tabs: TabState[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  colors: ConversationPalette;
  /** Pre-rendered context usage section (passed from parent to avoid moving formatters) */
  contextSection?: React.ReactNode;
  /** Pre-rendered codex usage section */
  codexSection?: React.ReactNode;
}

function SidebarTitle(
  { expanded, colors }: { expanded: boolean; colors: ConversationPalette },
): React.ReactElement {
  const name = "VIGIL";
  const indices = [0, 1, 3, 5, 6];
  if (!expanded) {
    return (
      <box flexDirection="row">
        <text fg={LOGO_GRADIENT[0]} bold content="V" />
      </box>
    );
  }
  return (
    <box flexDirection="row">
      {name.split("").map((ch, i) => (
        <text key={`sidebar-title-${i}`} fg={LOGO_GRADIENT[indices[i]]} bold content={ch} />
      ))}
    </box>
  );
}

function LeftSidebarInner(props: SidebarProps): React.ReactElement {
  const {
    tabs,
    activeTabId,
    onSelectTab,
    onCloseTab,
    expanded,
    onToggleExpanded,
    colors,
    contextSection,
    codexSection,
  } = props;

  const width = expanded ? SIDEBAR_EXPANDED_WIDTH : SIDEBAR_COLLAPSED_WIDTH;

  return (
    <box
      width={width}
      minWidth={width}
      maxWidth={width}
      flexDirection="column"
      border={["right"] as any}
      borderColor={colors.border}
      borderStyle="single"
    >
      <box
        flexDirection="row"
        paddingLeft={1}
        hoverStyle={{ backgroundColor: colors.border }}
        onMouseDown={(e: any) => {
          e.stopPropagation();
          e.preventDefault();
          onToggleExpanded();
        }}
      >
        <text fg={colors.dim} content={expanded ? "▾ " : "▸ "} />
        <SidebarTitle expanded={expanded} colors={colors} />
      </box>

      <box height={1} />

      <SidebarTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        colors={colors}
        expanded={expanded}
      />

      {expanded && (contextSection || codexSection) ? (
        <>
          <box height={1} />
          <box paddingLeft={1} flexDirection="column" gap={1} width="100%">
            {contextSection}
            {codexSection}
          </box>
        </>
      ) : null}
    </box>
  );
}

export const LeftSidebar = React.memo(LeftSidebarInner);
export { SIDEBAR_EXPANDED_WIDTH, SIDEBAR_COLLAPSED_WIDTH };
