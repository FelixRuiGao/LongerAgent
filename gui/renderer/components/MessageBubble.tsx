import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationEntry } from "../context";
import { theme, mono, shadows } from "../theme";
import { highlightCode } from "./SyntaxHighlight";
import { useToast } from "./Toast";

interface MessageBubbleProps {
  entry: ConversationEntry;
  isStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// Minimal markdown-to-HTML converter
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function markdownToHtml(text: string): string {
  // Extract code blocks first to protect them from other transforms
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const trimmedCode = code.replace(/\n$/, "");
    const highlighted = lang ? highlightCode(trimmedCode, lang) : escapeHtml(trimmedCode);
    const langLabel = lang ? `<div class="code-lang">${lang}</div>` : "";
    const placeholder = `\x00CODE${codeBlocks.length}\x00`;
    codeBlocks.push(`${langLabel}<pre class="code-block"><code>${highlighted}</code></pre>`);
    return placeholder;
  });

  // Extract tables before other processing
  const tableBlocks: string[] = [];
  processed = processed.replace(
    /(?:^|\n)((?:\|[^\n]+\|\n)+)/g,
    (_match, tableBlock: string) => {
      const rows = tableBlock.trim().split("\n").filter((r: string) => r.trim());
      if (rows.length < 2) return _match;

      // Check if second row is a separator (|---|---|)
      const sepRow = rows[1];
      const isSeparator = /^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|$/.test(sepRow.trim());

      let thead = "";
      let bodyStart = 0;

      if (isSeparator) {
        const headerCells = rows[0].split("|").filter((c: string) => c.trim() !== "");
        thead = `<thead><tr>${headerCells.map((c: string) => `<th>${escapeHtml(c.trim())}</th>`).join("")}</tr></thead>`;
        bodyStart = 2;
      }

      const bodyRows = rows.slice(bodyStart);
      const tbody = bodyRows.map((row: string) => {
        const cells = row.split("|").filter((c: string) => c.trim() !== "");
        return `<tr>${cells.map((c: string) => `<td>${escapeHtml(c.trim())}</td>`).join("")}</tr>`;
      }).join("");

      const placeholder = `\x00TABLE${tableBlocks.length}\x00`;
      tableBlocks.push(`<table class="md-table">${thead}<tbody>${tbody}</tbody></table>`);
      return `\n${placeholder}\n`;
    },
  );

  let html = escapeHtml(processed);

  // Restore code blocks
  codeBlocks.forEach((block, i) => {
    html = html.replace(`\x00CODE${i}\x00`, block);
  });

  // Restore tables
  tableBlocks.forEach((block, i) => {
    html = html.replace(escapeHtml(`\x00TABLE${i}\x00`), block);
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Headings
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  // Horizontal rules
  html = html.replace(/^---+$/gm, `<hr/>`);

  // Blockquotes
  html = html.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/<\/blockquote>\s*<blockquote>/g, "<br/>");

  // Unordered lists
  html = html.replace(/^(?:[-*])\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
  html = html.replace(/<\/ul>\s*<ul>/g, "");

  // Ordered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");

  // Line breaks
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br/>");

  if (!html.startsWith("<")) {
    html = `<p>${html}</p>`;
  }

  return html;
}

const markdownStyles = `
  h1, h2, h3 { margin: 12px 0 6px 0; font-weight: 600; letter-spacing: -0.01em; }
  h1 { font-size: 1.25em; }
  h2 { font-size: 1.1em; }
  h3 { font-size: 1.0em; color: ${theme.accent}; }
  p { margin: 6px 0; line-height: 1.7; }
  a { color: ${theme.accent}; text-decoration: none; border-bottom: 1px solid ${theme.accentBorder}; }
  a:hover { border-bottom-color: ${theme.accent}; }
  strong { font-weight: 600; }
  ul, ol { margin: 8px 0 8px 6px; padding-left: 16px; }
  li { margin: 4px 0; line-height: 1.65; }
  li::marker { color: ${theme.accent}; }
  blockquote {
    border-left: 2px solid ${theme.accentBorder};
    margin: 8px 0 8px 4px;
    padding: 4px 0 4px 14px;
    color: ${theme.secondary};
    font-style: italic;
  }
  .code-lang {
    font-size: 10px;
    color: ${theme.muted};
    background: ${theme.crust};
    padding: 6px 14px 0;
    border-radius: 4px 4px 0 0;
    border: 1px solid ${theme.borderHover};
    border-bottom: none;
    margin: 10px 0 0 0;
    font-family: ${mono};
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .code-block {
    background: ${theme.crust};
    border-radius: 0 0 4px 4px;
    padding: 14px 16px;
    overflow-x: auto;
    margin: 0 0 10px 0;
    font-family: ${mono};
    font-size: 13px;
    line-height: 1.6;
    color: ${theme.text};
    border: 1px solid ${theme.borderHover};
    border-top: none;
    counter-reset: line-num;
  }
  .code-lang + .code-block { margin-top: 0; border-radius: 0 0 4px 4px; }
  .code-block:not(.code-lang + .code-block) { border-radius: 4px; border-top: 1px solid ${theme.borderHover}; margin-top: 10px; }
  .code-block code { background: none; padding: 0; font-size: inherit; }
  .code-block:hover { border-color: ${theme.accentBorder}; }
  .inline-code {
    background: ${theme.crust};
    padding: 2px 7px;
    border-radius: 3px;
    font-family: ${mono};
    font-size: 0.88em;
    color: ${theme.accent};
    border: 1px solid ${theme.border};
  }
  .md-table {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0;
    font-size: 13px;
  }
  .md-table th, .md-table td {
    padding: 8px 12px;
    text-align: left;
    border: 1px solid ${theme.borderHover};
  }
  .md-table th {
    background: ${theme.surface};
    color: ${theme.accent};
    font-weight: 600;
    font-family: ${mono};
    font-size: 12px;
    letter-spacing: 0.02em;
  }
  .md-table td {
    color: ${theme.text};
  }
  .md-table tr:nth-child(even) td {
    background: rgba(255, 255, 255, 0.02);
  }
  .md-table tr:hover td {
    background: rgba(203, 138, 90, 0.04);
  }
  hr {
    border: none;
    height: 1px;
    background: ${theme.borderHover};
    margin: 16px 0;
  }
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MessageBubble({
  entry,
  isStreaming = false,
}: MessageBubbleProps): React.ReactElement {
  const { kind, text, dim, meta } = entry;
  const opacity = dim ? 0.6 : 1;

  // --- user message ---
  if (kind === "user") {
    const timestamp = entry.startedAt ? new Date(entry.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: 16, opacity, animation: "fadeInUp 200ms ease-out" }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            fontWeight: 500,
            color: theme.secondary,
            marginBottom: 5,
            marginRight: 2,
            letterSpacing: "0.04em",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          {timestamp && <span style={{ color: theme.muted, fontSize: 10, fontWeight: 400 }}>{timestamp}</span>}
          you
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
            <circle cx="8" cy="6" r="3" />
            <path d="M2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
          </svg>
        </div>
        <div
          style={{
            maxWidth: "75%",
            backgroundColor: theme.elevated,
            color: theme.text,
            padding: "10px 16px",
            borderRadius: "4px 4px 2px 4px",
            lineHeight: 1.65,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            border: `1px solid ${theme.borderHover}`,
          }}
        >
          {text}
        </div>
      </div>
    );
  }

  // --- assistant message ---
  if (kind === "assistant") {
    return (
      <AssistantBubble
        text={text}
        opacity={opacity}
        isStreaming={isStreaming}
      />
    );
  }

  // --- reasoning ---
  if (kind === "reasoning") {
    return <ReasoningBlock text={text} opacity={opacity} isStreaming={isStreaming} />;
  }

  // --- tool_call ---
  if (kind === "tool_call") {
    return (
      <div style={{ maxWidth: "88%", marginBottom: 2 }}>
        <ToolCallBlock entry={entry} opacity={opacity} />
      </div>
    );
  }

  // --- tool_result ---
  if (kind === "tool_result") {
    return (
      <div style={{ maxWidth: "88%", marginBottom: 8, marginTop: -2 }}>
        <ToolResultBlock entry={entry} opacity={opacity} />
      </div>
    );
  }

  // --- status ---
  if (kind === "status") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
        <div
          style={{
            fontFamily: mono,
            color: theme.muted,
            fontSize: 10,
            padding: "3px 10px",
            backgroundColor: theme.surface,
            borderRadius: 3,
            letterSpacing: "0.04em",
            border: `1px solid ${theme.border}`,
            opacity,
          }}
        >
          {text}
        </div>
      </div>
    );
  }

  // --- error ---
  if (kind === "error") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          color: theme.error,
          fontSize: 13,
          margin: "8px 0",
          padding: "10px 14px 10px 12px",
          backgroundColor: "rgba(191, 96, 96, 0.06)",
          borderRadius: "0 4px 4px 0",
          borderLeft: `2px solid ${theme.error}`,
          opacity,
          lineHeight: 1.5,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 2, flexShrink: 0 }}>
          <circle cx="8" cy="8" r="6"/>
          <path d="M8 5v4"/>
          <circle cx="8" cy="11.5" r="0.5" fill="currentColor"/>
        </svg>
        <span>{text}</span>
      </div>
    );
  }

  // --- compact_mark ---
  if (kind === "compact_mark") {
    return <DividerLine label="context compacted" />;
  }

  // --- interrupted_marker ---
  if (kind === "interrupted_marker") {
    return <DividerLine label="interrupted" />;
  }

  // --- sub_agent_rollup ---
  if (kind === "sub_agent_rollup") {
    const agentName =
      (meta?.agentName as string) || (meta?.name as string) || "sub-agent";
    return (
      <div style={{ animation: "fadeInUp 200ms ease-out" }}>
        <SubAgentRollup name={agentName} text={text} opacity={opacity} />
      </div>
    );
  }

  // --- fallback ---
  return (
    <div
      style={{
        marginBottom: 8,
        fontFamily: mono,
        color: theme.muted,
        fontSize: 11,
        opacity,
        whiteSpace: "pre-wrap",
      }}
    >
      [{kind}] {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StreamingCursor(): React.ReactElement {
  return (
    <span
      style={{
        display: "inline-block",
        width: 2,
        height: 14,
        backgroundColor: theme.accent,
        marginLeft: 2,
        verticalAlign: "text-bottom",
        borderRadius: 1,
        opacity: 0.7,
        animation: "forge-cursor-blink 1s ease-in-out infinite",
      }}
    />
  );
}

function CopyIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="5" width="9" height="9" rx="1.5"/>
      <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2"/>
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2,8 6,12 14,4"/>
    </svg>
  );
}

function AssistantBubble({
  text,
  opacity,
  isStreaming,
}: {
  text: string;
  opacity: number;
  isStreaming?: boolean;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const htmlContent = useMemo(() => markdownToHtml(text), [text]);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  // Add copy buttons to code blocks
  useEffect(() => {
    if (!contentRef.current || isStreaming) return;
    const blocks = contentRef.current.querySelectorAll("pre.code-block");
    blocks.forEach((block) => {
      if (block.querySelector(".code-copy-btn")) return;
      const btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.textContent = "Copy";
      btn.title = "Copy code";
      Object.assign(btn.style, {
        position: "absolute",
        top: "6px",
        right: "6px",
        padding: "2px 8px",
        fontSize: "10px",
        fontWeight: "500",
        borderRadius: "3px",
        border: `1px solid ${theme.borderHover}`,
        background: theme.surface,
        color: theme.muted,
        cursor: "pointer",
        opacity: "0",
        transition: "opacity 0.15s",
        fontFamily: mono,
        letterSpacing: "0.04em",
      });
      (block as HTMLElement).style.position = "relative";
      block.addEventListener("mouseenter", () => {
        btn.style.opacity = "1";
      });
      block.addEventListener("mouseleave", () => {
        btn.style.opacity = "0";
      });
      btn.addEventListener("click", () => {
        const code = block.querySelector("code")?.textContent ?? block.textContent ?? "";
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = "Copied";
          btn.style.color = theme.success;
          setTimeout(() => {
            btn.textContent = "Copy";
            btn.style.color = theme.muted;
          }, 1500);
        });
      });
      block.appendChild(btn);
    });
  }, [htmlContent, isStreaming]);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", marginBottom: 16, opacity, animation: isStreaming ? "none" : "fadeInUp 200ms ease-out" }}
    >
      <div
        style={{
          maxWidth: "85%",
          color: theme.text,
          padding: "12px 16px",
          borderRadius: 4,
          lineHeight: 1.65,
          wordBreak: "break-word",
          borderLeft: `2px solid ${theme.accent}`,
          paddingLeft: 18,
        }}
      >
        <style>{markdownStyles}</style>
        <div ref={contentRef} dangerouslySetInnerHTML={{ __html: htmlContent }} />
        {isStreaming && <StreamingCursor />}
      </div>
      {/* Copy button below message */}
      {!isStreaming && (
        <button
          type="button"
          onClick={handleCopy}
          style={{
            marginTop: 4,
            marginLeft: 18,
            height: 22,
            padding: "0 8px",
            border: `1px solid ${copied ? "rgba(107, 159, 120, 0.20)" : "transparent"}`,
            borderRadius: 3,
            background: copied ? "rgba(107, 159, 120, 0.10)" : "transparent",
            color: copied ? theme.success : theme.muted,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
            transition: "color 150ms ease, background 150ms ease, border-color 150ms ease",
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.02em",
          }}
          onMouseEnter={(e) => {
            if (!copied) {
              e.currentTarget.style.color = theme.secondary;
              e.currentTarget.style.background = theme.elevated;
              e.currentTarget.style.borderColor = theme.border;
            }
          }}
          onMouseLeave={(e) => {
            if (!copied) {
              e.currentTarget.style.color = theme.muted;
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.borderColor = "transparent";
            }
          }}
          title={copied ? "Copied!" : "Copy message"}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      )}
    </div>
  );
}

function ThinkIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
      <circle cx="8" cy="8" r="6"/>
      <path d="M6 6.5c0-1.1.9-2 2-2s2 .9 2 2c0 .7-.4 1.3-1 1.7V9"/>
      <circle cx="8" cy="11" r="0.5" fill="currentColor"/>
    </svg>
  );
}

function ToolIcon({ toolName }: { toolName?: string }): React.ReactElement {
  const name = (toolName || "").toLowerCase();

  // Read/file read
  if (name.includes("read") || name === "cat") {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
        <path d="M2 4v10h12V4" /><path d="M2 4l6-2 6 2" /><path d="M8 2v12" />
      </svg>
    );
  }
  // Write/edit/create
  if (name.includes("write") || name.includes("edit") || name.includes("create") || name.includes("patch")) {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
        <path d="M12 2l2 2-8 8H4v-2l8-8z" /><path d="M10 4l2 2" />
      </svg>
    );
  }
  // Bash/exec/run
  if (name.includes("bash") || name.includes("exec") || name.includes("run") || name.includes("shell") || name.includes("command")) {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
        <rect x="1" y="2" width="14" height="12" rx="1.5" /><path d="M4 6l3 2-3 2" /><path d="M9 10h3" />
      </svg>
    );
  }
  // Search/grep/glob
  if (name.includes("search") || name.includes("grep") || name.includes("glob") || name.includes("find")) {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
        <circle cx="7" cy="7" r="4" /><path d="M10 10l4 4" />
      </svg>
    );
  }
  // Default tool icon
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
      <path d="M10.5 2.5l3 3-1.5 1.5-3-3"/>
      <path d="M9.5 3.5L4 9l-1.5 4L7 11.5 12.5 6"/>
      <path d="M2.5 12.5l1-1"/>
    </svg>
  );
}

function ResultIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
      <rect x="2" y="3" width="12" height="10" rx="1.5"/>
      <path d="M5 7h6M5 10h4"/>
    </svg>
  );
}

function ReasoningBlock({
  text,
  opacity,
  isStreaming,
}: {
  text: string;
  opacity: number;
  isStreaming?: boolean;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const showBody = isStreaming || expanded;

  return (
    <div style={{ marginBottom: 10, opacity, maxWidth: "88%" }}>
      <div
        style={{
          cursor: "pointer",
          fontFamily: mono,
          color: theme.muted,
          fontSize: 11,
          padding: "6px 10px",
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          gap: 7,
          letterSpacing: "0.04em",
          borderRadius: showBody ? "4px 4px 0 0" : 4,
          backgroundColor: theme.surface,
          border: `1px solid ${theme.border}`,
          borderBottom: showBody ? "none" : `1px solid ${theme.border}`,
          transition: "background 100ms ease",
        }}
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={(e) => { e.currentTarget.style.background = theme.elevated; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = theme.surface; }}
      >
        <ThinkIcon />
        <span style={{ fontSize: 8 }}>{showBody ? "\u25BC" : "\u25B6"}</span>
        <span>reasoning</span>
        {!showBody && text && (
          <span
            style={{
              color: theme.muted,
              fontSize: 11,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
              opacity: 0.6,
              fontStyle: "italic",
            }}
          >
            {text.slice(0, 100).replace(/\n/g, " ")}
          </span>
        )}
        {isStreaming && <StreamingCursor />}
      </div>
      {showBody && (
        <div
          style={{
            color: theme.secondary,
            fontSize: 13,
            fontStyle: "italic",
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            padding: "10px 14px",
            borderLeft: `1px solid ${theme.border}`,
            borderRight: `1px solid ${theme.border}`,
            borderBottom: `1px solid ${theme.border}`,
            borderRadius: "0 0 4px 4px",
            backgroundColor: theme.crust,
            maxHeight: 300,
            overflowY: "auto",
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({
  entry,
  opacity,
}: {
  entry: ConversationEntry;
  opacity: number;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const toolName = (entry.meta?.toolName as string) || "tool";
  const elapsedMs = entry.elapsedMs;

  const summary = useMemo(() => {
    const shortenPath = (p: string): string => {
      // Shorten absolute paths: show just the last 2 path segments for readability
      const parts = p.split("/");
      if (parts.length > 3) {
        return ".../" + parts.slice(-2).join("/");
      }
      const homeMatch = p.match(/\/Users\/[^/]+\/(.+)/);
      if (homeMatch) return `~/${homeMatch[1]}`;
      return p;
    };

    if (entry.meta?.toolArgs && typeof entry.meta.toolArgs === "object") {
      const args = entry.meta.toolArgs as Record<string, unknown>;
      // For file-oriented tools, show a clean file path
      const filePath = args.file_path || args.path || args.command;
      if (typeof filePath === "string" && filePath.length > 20) {
        return shortenPath(filePath);
      }
      const parts: string[] = [];
      for (const [key, value] of Object.entries(args)) {
        let strVal = typeof value === "string" ? value : JSON.stringify(value);
        if (typeof value === "string" && value.startsWith("/")) {
          strVal = shortenPath(strVal);
        }
        const truncated = strVal.length > 60 ? strVal.slice(0, 57) + "..." : strVal;
        parts.push(truncated);
        if (parts.length >= 2) break;
      }
      return parts.join(" ");
    }
    // Fallback: shorten any absolute paths found in text
    let firstLine = entry.text.split("\n")[0];
    firstLine = firstLine.replace(/\/Users\/[^\s]+/g, (match) => shortenPath(match));
    return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
  }, [entry]);

  const bodyContent = useMemo(() => {
    if (entry.meta?.toolArgs && typeof entry.meta.toolArgs === "object") {
      const args = entry.meta.toolArgs as Record<string, unknown>;
      // Format each argument on its own line, with long strings shown as-is
      const lines: string[] = [];
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string" && value.includes("\n")) {
          lines.push(`${key}:\n${value}`);
        } else if (typeof value === "string") {
          lines.push(`${key}: ${value}`);
        } else {
          lines.push(`${key}: ${JSON.stringify(value)}`);
        }
      }
      return lines.join("\n\n");
    }
    return entry.text;
  }, [entry]);

  return (
    <div style={{ opacity }}>
      <div
        style={{
          border: `1px solid ${theme.border}`,
          borderRadius: "4px 4px 0 0",
          borderBottom: "none",
          overflow: "hidden",
          backgroundColor: theme.surface,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            cursor: "pointer",
            userSelect: "none",
            fontSize: 12,
            borderLeft: `2px solid ${theme.accentBorder}`,
            transition: "background 120ms ease",
          }}
          onClick={() => setExpanded(!expanded)}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = theme.elevated;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <ToolIcon toolName={toolName} />
          <span style={{ fontSize: 8, flexShrink: 0 }}>
            {expanded ? "\u25BC" : "\u25B6"}
          </span>
          <span
            style={{
              fontWeight: 600,
              color: theme.accent,
              fontFamily: mono,
              fontSize: 12,
            }}
          >
            {toolName}
          </span>
          {!expanded && (
            <span
              style={{
                color: theme.secondary,
                fontFamily: mono,
                fontSize: 11,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                minWidth: 0,
                opacity: 0.7,
              }}
            >
              {summary}
            </span>
          )}
          {elapsedMs != null && elapsedMs > 0 && (
            <span
              style={{
                marginLeft: "auto",
                fontFamily: mono,
                color: theme.muted,
                fontSize: 10,
                flexShrink: 0,
              }}
            >
              {elapsedMs >= 1000
                ? `${(elapsedMs / 1000).toFixed(1)}s`
                : `${elapsedMs}ms`}
            </span>
          )}
        </div>
      </div>
      {expanded && (
        <div
          style={{
            padding: "10px 14px",
            border: `1px solid ${theme.border}`,
            borderTop: "none",
            borderRadius: "0 0 4px 4px",
            fontFamily: mono,
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 300,
            overflowY: "auto",
            color: theme.secondary,
            backgroundColor: theme.crust,
          }}
        >
          {bodyContent}
        </div>
      )}
    </div>
  );
}

function DiffAwareContent({ text }: { text: string }): React.ReactElement {
  const isDiff = text.includes("--- ") && text.includes("+++ ");
  if (!isDiff) {
    return (
      <div
        style={{
          fontFamily: mono,
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          padding: "10px 14px",
          backgroundColor: theme.crust,
          borderRadius: "0 0 4px 4px",
          maxHeight: 300,
          overflowY: "auto",
          color: theme.secondary,
          border: `1px solid ${theme.border}`,
          borderTop: "none",
        }}
      >
        {text}
      </div>
    );
  }

  const lines = text.split("\n");
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 12,
        lineHeight: 1.6,
        padding: "6px 0",
        backgroundColor: theme.crust,
        borderRadius: "0 0 4px 4px",
        maxHeight: 300,
        overflowY: "auto",
        border: `1px solid ${theme.border}`,
        borderTop: "none",
      }}
    >
      {lines.map((line, i) => {
        // Strip leading "N | " line-number prefix for diff detection
        const stripped = line.replace(/^\s*\d+\s*\|\s?/, "");
        let bg = "transparent";
        let color = theme.secondary;
        if (stripped.startsWith("+") && !stripped.startsWith("+++")) {
          bg = "rgba(107, 159, 120, 0.08)";
          color = theme.success;
        } else if (stripped.startsWith("-") && !stripped.startsWith("---")) {
          bg = "rgba(191, 96, 96, 0.08)";
          color = theme.error;
        } else if (stripped.startsWith("@@")) {
          color = theme.accent;
        }
        return (
          <div
            key={i}
            style={{
              padding: "0 14px",
              background: bg,
              color,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
}

function ToolResultBlock({
  entry,
  opacity,
}: {
  entry: ConversationEntry;
  opacity: number;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const lines = entry.text.split("\n").length;

  return (
    <div style={{ opacity }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px 6px 14px",
          backgroundColor: theme.surface,
          border: `1px solid ${theme.border}`,
          borderTop: "none",
          borderRadius: expanded ? 0 : "0 0 4px 4px",
          cursor: "pointer",
          fontFamily: mono,
          fontSize: 11,
          color: theme.muted,
          userSelect: "none",
          transition: "background 120ms ease",
          borderLeft: `2px solid ${theme.border}`,
        }}
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = theme.elevated;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = theme.surface;
        }}
      >
        <ResultIcon />
        <span style={{ fontSize: 8 }}>{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>result ({lines} line{lines !== 1 ? "s" : ""})</span>
        {entry.elapsedMs != null && entry.elapsedMs > 0 && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: theme.muted }}>
            {entry.elapsedMs >= 1000
              ? `${(entry.elapsedMs / 1000).toFixed(1)}s`
              : `${entry.elapsedMs}ms`}
          </span>
        )}
      </div>
      {expanded && (
        <DiffAwareContent
          text={entry.text}
        />
      )}
    </div>
  );
}

function DividerLine({ label }: { label: string }): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        margin: "20px 0",
        fontFamily: mono,
        color: theme.muted,
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.08em",
        textTransform: "lowercase",
        userSelect: "none",
      }}
    >
      <div
        style={{
          flex: 1,
          height: 1,
          background: theme.border,
        }}
      />
      <span>{label}</span>
      <div
        style={{
          flex: 1,
          height: 1,
          background: theme.border,
        }}
      />
    </div>
  );
}

function SubAgentRollup({
  name,
  text,
  opacity,
}: {
  name: string;
  text: string;
  opacity: number;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ marginBottom: 8, opacity }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          backgroundColor: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: expanded ? "4px 4px 0 0" : 4,
          cursor: "pointer",
          fontFamily: mono,
          fontSize: 12,
          color: theme.accent,
          userSelect: "none",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontSize: 8 }}>{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>agent: {name}</span>
      </div>
      {expanded && (
        <div
          style={{
            padding: "8px 12px",
            backgroundColor: theme.surface,
            border: `1px solid ${theme.border}`,
            borderTop: "none",
            borderRadius: "0 0 4px 4px",
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 400,
            overflowY: "auto",
            color: theme.text,
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
