import React, { useCallback, useEffect, useState } from "react";
import { useSession } from "../context";
import { theme, mono } from "../theme";

interface FileEntry {
  name: string;
  isDir: boolean;
  path: string;
}

// File type → icon color
function fileColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts": case "tsx": return "#3178C6";
    case "js": case "jsx": case "mjs": case "cjs": return "#F7DF1E";
    case "py": return "#3776AB";
    case "rs": return "#DEA584";
    case "go": return "#00ADD8";
    case "json": return "#E5C07B";
    case "md": case "mdx": return "#61AFEF";
    case "css": case "scss": case "sass": return "#C678DD";
    case "html": return "#E06C75";
    case "yaml": case "yml": case "toml": return "#98C379";
    case "sh": case "bash": case "zsh": return "#4EAA25";
    case "sql": return "#669DF6";
    case "svg": case "png": case "jpg": case "gif": return "#C4A24C";
    default: return theme.muted;
  }
}

function FileIcon({ name, isDir, isOpen }: { name: string; isDir: boolean; isOpen?: boolean }): React.ReactElement {
  if (isDir) {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
        stroke={isOpen ? theme.accent : "#C4A24C"}>
        {isOpen ? (
          <>
            <path d="M2 4h4l1.5 1.5H14v8H2z" />
            <path d="M2 6h12" />
          </>
        ) : (
          <path d="M2 3h4l1.5 1.5H14v9H2z" />
        )}
      </svg>
    );
  }

  const color = fileColor(name);
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5l-3-3z" />
      <path d="M10 2v3h3" />
    </svg>
  );
}

function TreeNode({
  entry,
  depth,
  onFileClick,
}: {
  entry: FileEntry;
  depth: number;
  onFileClick: (path: string) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);

  const toggleExpand = useCallback(async () => {
    if (!entry.isDir) {
      onFileClick(entry.path);
      return;
    }

    if (expanded) {
      setExpanded(false);
      return;
    }

    if (children.length === 0) {
      setLoading(true);
      const api = (window as any).api;
      if (api) {
        try {
          const result = await api.invoke("fs:listDir", entry.path);
          if (Array.isArray(result)) setChildren(result);
        } catch { /* ignore */ }
      }
      setLoading(false);
    }
    setExpanded(true);
  }, [entry, expanded, children.length, onFileClick]);

  return (
    <div>
      <div
        onClick={toggleExpand}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 8px",
          paddingLeft: 8 + depth * 14,
          cursor: "pointer",
          fontFamily: mono,
          fontSize: 11,
          color: hovered ? theme.text : theme.secondary,
          background: hovered ? theme.elevated : "transparent",
          borderRadius: 3,
          transition: "background 80ms ease, color 80ms ease",
          userSelect: "none",
        }}
      >
        {entry.isDir && (
          <span style={{ fontSize: 7, width: 8, textAlign: "center", color: theme.muted, flexShrink: 0 }}>
            {expanded ? "\u25BC" : "\u25B6"}
          </span>
        )}
        {!entry.isDir && <span style={{ width: 8 }} />}
        <FileIcon name={entry.name} isDir={entry.isDir} isOpen={expanded} />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.name}
        </span>
        {loading && (
          <span style={{ fontSize: 9, color: theme.muted, marginLeft: "auto" }}>...</span>
        )}
      </div>
      {expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              onFileClick={onFileClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree(): React.ReactElement {
  const { cwd, sendMessage } = useSession();
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    if (!cwd || !expanded) return;
    const api = (window as any).api;
    if (!api) return;
    api.invoke("fs:listDir", cwd).then((result: FileEntry[]) => {
      if (Array.isArray(result)) setRootEntries(result);
    }).catch(() => {});
  }, [cwd, expanded]);

  const handleFileClick = useCallback(
    (path: string) => {
      // Insert @file reference into the input
      const textarea = document.querySelector("textarea");
      if (textarea) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        const current = textarea.value;
        const insertText = `@${path} `;
        const needsSpace = current.length > 0 && !current.endsWith(" ") && !current.endsWith("\n");
        nativeInputValueSetter?.call(textarea, current + (needsSpace ? " " : "") + insertText);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.focus();
      }
    },
    [],
  );

  return (
    <div style={{ padding: "0 8px" }}>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "7px 8px",
          borderRadius: 4,
          cursor: "pointer",
          transition: "background 100ms ease",
          userSelect: "none",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = theme.elevated; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={theme.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3h4l1.5 1.5H14v9H2z" />
        </svg>
        <span style={{ fontSize: 8, color: theme.muted }}>{expanded ? "\u25BC" : "\u25B6"}</span>
        <span
          style={{
            fontFamily: mono,
            fontSize: 11,
            fontWeight: 500,
            color: theme.secondary,
            letterSpacing: "0.02em",
          }}
        >
          Files
        </span>
      </div>
      {expanded && (
        <div style={{ maxHeight: 300, overflowY: "auto", paddingBottom: 4 }}>
          {rootEntries.length === 0 && (
            <div style={{ fontSize: 11, color: theme.muted, padding: "6px 22px" }}>
              Loading...
            </div>
          )}
          {rootEntries.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              onFileClick={handleFileClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
