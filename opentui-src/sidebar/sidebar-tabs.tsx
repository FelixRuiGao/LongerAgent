/** @jsxImportSource @opentui/react */

import React from "react";

import type { ConversationPalette } from "../components/conversation-types.js";

export interface TabState {
  id: string;
  label: string;
  icon: string;
  closeable: boolean;
  kind: "main" | "child" | "detail-thinking" | "detail-tool";
}

interface SidebarTabsProps {
  tabs: TabState[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  colors: ConversationPalette;
  expanded: boolean;
}

function SidebarTabsInner(
  { tabs, activeTabId, onSelect, onClose, colors, expanded }: SidebarTabsProps,
): React.ReactElement {
  return (
    <box flexDirection="column" width="100%">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <box
            key={tab.id}
            flexDirection="row"
            width="100%"
            backgroundColor={isActive ? colors.border : "transparent"}
            onMouseDown={(e: any) => {
              e.stopPropagation();
              e.preventDefault();
              onSelect(tab.id);
            }}
          >
            <text
              fg={isActive ? colors.accent : colors.dim}
              content={expanded ? ` ${tab.icon} ${tab.label}` : ` ${tab.icon}`}
            />
            {expanded && tab.closeable ? (
              <box
                flexGrow={1}
                onMouseDown={(e: any) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onClose(tab.id);
                }}
              >
                <text fg={colors.dim} content=" ×" />
              </box>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

export const SidebarTabs = React.memo(SidebarTabsInner);
