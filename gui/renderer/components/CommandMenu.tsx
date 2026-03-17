import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { theme, mono, sans, shadows } from "../theme";

interface CommandInfo {
  name: string;
  description: string;
}

interface CommandMenuProps {
  filter: string;
  onSelect: (command: string) => void;
  onClose: () => void;
}

export function CommandMenu({ filter, onSelect, onClose }: CommandMenuProps): React.ReactElement {
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Load commands once
  useEffect(() => {
    const api = (window as any).api;
    if (!api) return;
    api.invoke("command:list").then((cmds: CommandInfo[]) => {
      if (Array.isArray(cmds)) setCommands(cmds);
    }).catch(() => {});
  }, []);

  // Filter commands by prefix
  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return commands.filter(
      (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
  }, [commands, filter]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex + 1] as HTMLElement; // +1 for header
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex].name);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  if (filtered.length === 0) return <></>;

  return (
    <div
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        right: 80,
        marginBottom: 4,
        background: theme.surface,
        border: `1px solid ${theme.borderHover}`,
        borderRadius: 4,
        maxHeight: 260,
        overflowY: "auto",
        zIndex: 100,
        fontFamily: sans,
      }}
      ref={listRef}
    >
      <div
        style={{
          padding: "6px 12px",
          fontFamily: mono,
          fontSize: 10,
          fontWeight: 500,
          color: theme.muted,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        Commands
      </div>
      {filtered.map((cmd, i) => {
        const isSelected = i === selectedIndex;
        return (
          <div
            key={cmd.name}
            onClick={() => onSelect(cmd.name)}
            onMouseEnter={() => setSelectedIndex(i)}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              padding: "7px 12px",
              cursor: "pointer",
              background: isSelected ? theme.elevated : "transparent",
              borderLeft: isSelected ? `2px solid ${theme.accent}` : "2px solid transparent",
              transition: "background 80ms ease",
            }}
          >
            <span
              style={{
                fontFamily: mono,
                fontSize: 12,
                fontWeight: 600,
                color: isSelected ? theme.accent : theme.text,
                flexShrink: 0,
              }}
            >
              {cmd.name}
            </span>
            <span
              style={{
                fontSize: 12,
                color: theme.muted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {cmd.description}
            </span>
          </div>
        );
      })}
    </div>
  );
}
