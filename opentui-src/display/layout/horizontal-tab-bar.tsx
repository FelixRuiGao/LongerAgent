/** @jsxImportSource @opentui/react */

import React, { useState } from "react";

import type { DisplayThemeColorTokens } from "../theme/index.js";
import type { TabState } from "../../sidebar/sidebar-tabs.js";
import { truncateToWidth } from "../utils/format.js";

interface HorizontalTabBarProps {
  tabs: TabState[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  colors: DisplayThemeColorTokens;
  maxTabWidth?: number;
}

const DEFAULT_MAX_TAB_WIDTH = 18;

function formatTabLabel(tab: TabState, maxWidth: number): string {
  const raw = ` ${tab.icon} ${tab.label} `;
  return truncateToWidth(raw, maxWidth);
}

function TabButton({
  tab,
  isActive,
  maxWidth,
  colors,
  onSelect,
  onClose,
}: {
  tab: TabState;
  isActive: boolean;
  maxWidth: number;
  colors: DisplayThemeColorTokens;
  onSelect: () => void;
  onClose: () => void;
}): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const label = formatTabLabel(tab, maxWidth);

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      backgroundColor={undefined}
      border={true}
      borderStyle="rounded"
      borderColor={isActive ? colors.dim : hovered ? colors.dim : colors.border}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onSelect(); }}
    >
      <text
        fg={isActive ? colors.accent : colors.dim}
        content={label}
      />
      {tab.closeable ? (
        <box
          onMouseDown={(e: any) => {
            e.stopPropagation();
            e.preventDefault();
            onClose();
          }}
        >
          <text fg={colors.dim} content="✕ " />
        </box>
      ) : null}
    </box>
  );
}

function HorizontalTabBarInner({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  colors,
  maxTabWidth = DEFAULT_MAX_TAB_WIDTH,
}: HorizontalTabBarProps): React.ReactElement {
  return (
    <box flexDirection="row" width="100%" gap={1} flexShrink={0}>
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          maxWidth={maxTabWidth}
          colors={colors}
          onSelect={() => onSelectTab(tab.id)}
          onClose={() => onCloseTab(tab.id)}
        />
      ))}
    </box>
  );
}

export const HorizontalTabBar = React.memo(HorizontalTabBarInner);
