import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../context";
import { theme, mono, sans, shadows } from "../theme";
import { CommandMenu } from "./CommandMenu";
import { useToast } from "./Toast";
import { encode } from "gpt-tokenizer";

const MAX_HEIGHT = 200;

export function InputArea(): React.ReactElement {
  const { sendMessage, cancelTurn, state } = useSession();
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isBusy = state === "thinking" || state === "tool_calling";
  const [showCommands, setShowCommands] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCountRef = useRef(0);

  // Detect if input starts with / for command mode
  const commandFilter = useMemo(() => {
    if (!value.startsWith("/")) return null;
    const spaceIdx = value.indexOf(" ");
    if (spaceIdx !== -1) return null;
    return value.slice(1);
  }, [value]);

  useEffect(() => {
    setShowCommands(commandFilter !== null);
  }, [commandFilter]);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // Focus textarea on mount and when state returns to idle
  useEffect(() => {
    if (state === "idle") {
      textareaRef.current?.focus();
    }
  }, [state]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // If it's a slash command, execute it via IPC
    if (trimmed.startsWith("/")) {
      const spaceIdx = trimmed.indexOf(" ");
      const cmdName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const cmdArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
      const api = (window as any).api;
      if (api && cmdName) {
        api.invoke("command:execute", cmdName, cmdArgs).then((result: any) => {
          if (result?.messages && result.messages.length > 0) {
            for (const msg of result.messages) {
              toast(msg, "info");
            }
          }
          if (!result?.success && result?.error) {
            toast(result.error, "error");
          }
        }).catch((err: any) => {
          toast(err?.message || "Command failed", "error");
        });
      }
      setValue("");
      requestAnimationFrame(() => {
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      });
      return;
    }

    // If busy, deliver message to the queue (interrupt-style)
    if (isBusy) {
      const api = (window as any).api;
      if (api) {
        api.invoke("session:deliverMessage", trimmed).catch(() => {});
      }
      setValue("");
      requestAnimationFrame(() => {
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      });
      return;
    }

    sendMessage(trimmed);
    setValue("");
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  }, [value, isBusy, sendMessage, toast]);

  const handleCommandSelect = useCallback((cmdName: string) => {
    setValue(`${cmdName} `);
    setShowCommands(false);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // If command menu is open, let it handle arrow/enter/tab/escape
      if (showCommands && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
        return;
      }

      // Enter without modifiers → send
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleSend();
        return;
      }

      // Ctrl+N → insert newline
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        const el = textareaRef.current;
        if (el) {
          const start = el.selectionStart;
          const end = el.selectionEnd;
          const before = value.slice(0, start);
          const after = value.slice(end);
          setValue(before + "\n" + after);
          requestAnimationFrame(() => {
            el.selectionStart = el.selectionEnd = start + 1;
          });
        }
        return;
      }

      // Shift+Enter, Alt/Option+Enter → default (newline)
    },
    [handleSend, showCommands, value],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
  }, []);

  // Handle @file drag-and-drop
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      dragCountRef.current = 0;
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const el = textareaRef.current;
      if (!el) return;

      const insertions: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filePath = (file as any).path || file.name;
        insertions.push(`@${filePath}`);
      }

      const insertText = insertions.join(" ");
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const before = value.slice(0, start);
      const after = value.slice(end);
      const needsSpace = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n");
      const prefix = needsSpace ? " " : "";
      setValue(before + prefix + insertText + " " + after);
    },
    [value],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current++;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      setIsDragging(false);
      dragCountRef.current = 0;
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const [focused, setFocused] = useState(false);
  const hasText = value.trim().length > 0;

  // Token count via gpt-tokenizer (debounced)
  const [tokenCount, setTokenCount] = useState(0);
  useEffect(() => {
    if (!value.trim()) {
      setTokenCount(0);
      return;
    }
    const timer = setTimeout(() => {
      try {
        setTokenCount(encode(value).length);
      } catch {
        // Fallback: rough estimate
        setTokenCount(Math.round(value.length / 4));
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [value]);

  const handleAttach = useCallback(async () => {
    const api = (window as any).api;
    if (!api) return;
    try {
      const filePaths: string[] | undefined = await api.invoke("dialog:openFile");
      if (filePaths && filePaths.length > 0) {
        const inserts = filePaths.map((fp: string) => `@${fp}`).join(" ");
        const el = textareaRef.current;
        if (el) {
          const start = el.selectionStart;
          const before = value.slice(0, start);
          const after = value.slice(el.selectionEnd);
          const needsSpace = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n");
          setValue(before + (needsSpace ? " " : "") + inserts + " " + after);
          el.focus();
        }
      }
    } catch { /* dialog not available */ }
  }, [value]);

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "12px 20px 8px 20px",
        borderTop: `1px solid ${isDragging ? theme.accentBorder : theme.border}`,
        backgroundColor: isDragging ? theme.accentGlow : theme.bg,
        position: "relative",
        transition: "background-color 200ms ease, border-color 200ms ease",
      }}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: `2px dashed ${theme.accent}`,
            background: "rgba(203, 138, 90, 0.06)",
            zIndex: 20,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: theme.accent,
              fontFamily: mono,
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            Drop files to attach
          </div>
        </div>
      )}

      {/* Command menu */}
      {showCommands && commandFilter !== null && (
        <CommandMenu
          filter={commandFilter}
          onSelect={handleCommandSelect}
          onClose={() => setShowCommands(false)}
        />
      )}

      {/* Textarea — full width, no inline buttons */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={isBusy ? "Type to interrupt..." : "Message..."}
        rows={1}
        style={{
          width: "100%",
          resize: "none",
          border: `1px solid ${focused ? theme.accentBorder : theme.border}`,
          borderRadius: 4,
          padding: "10px 14px",
          fontSize: 14,
          lineHeight: 1.6,
          color: theme.text,
          backgroundColor: theme.input,
          fontFamily: sans,
          outline: "none",
          maxHeight: MAX_HEIGHT,
          overflowY: "auto",
          transition: "border-color 150ms ease",
          boxSizing: "border-box",
        }}
      />

      {/* Toolbar below textarea */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 0 0",
          fontFamily: mono,
          fontSize: 10,
          color: theme.muted,
        }}
      >
        {/* Left: attach + hint */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ToolbarButton
            icon={
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            }
            label="Attach"
            onClick={handleAttach}
          />
          <span style={{ opacity: 0.5, fontSize: 10 }}>
            {hasText
              ? `~${tokenCount} token${tokenCount !== 1 ? "s" : ""}`
              : "Shift+Enter new line"}
          </span>
        </div>

        {/* Right: stop + send */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {isBusy && (
            <ToolbarButton
              icon={
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
              }
              label="Stop"
              onClick={cancelTurn}
              danger
            />
          )}
          <button
            type="button"
            onClick={hasText ? handleSend : undefined}
            disabled={!hasText}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              height: 26,
              padding: "0 10px",
              border: `1px solid ${hasText ? theme.accent : theme.border}`,
              borderRadius: 3,
              backgroundColor: hasText ? theme.accent : "transparent",
              color: hasText ? theme.bg : theme.muted,
              cursor: hasText ? "pointer" : "default",
              fontFamily: mono,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              transition: "all 120ms ease",
              opacity: hasText ? 1 : 0.5,
            }}
            onMouseEnter={(e) => { if (hasText) e.currentTarget.style.opacity = "0.85"; }}
            onMouseLeave={(e) => { if (hasText) e.currentTarget.style.opacity = "1"; }}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2L8 8" />
              <path d="M14 2l-5 12-2-5-5-2 12-5z" />
            </svg>
            {isBusy ? "Queue" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar button (attach, stop)
// ---------------------------------------------------------------------------

function ToolbarButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}): React.ReactElement {
  const baseColor = danger ? theme.error : theme.muted;
  const hoverColor = danger ? theme.error : theme.secondary;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 24,
        padding: "0 8px",
        border: `1px solid ${danger ? "rgba(191, 96, 96, 0.25)" : theme.border}`,
        borderRadius: 3,
        backgroundColor: danger ? "rgba(191, 96, 96, 0.06)" : "transparent",
        color: baseColor,
        cursor: "pointer",
        fontFamily: mono,
        fontSize: 10,
        fontWeight: 500,
        transition: "color 120ms ease, border-color 120ms ease, background 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = hoverColor;
        e.currentTarget.style.borderColor = danger ? "rgba(191, 96, 96, 0.40)" : theme.borderHover;
        if (!danger) e.currentTarget.style.background = theme.elevated;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = baseColor;
        e.currentTarget.style.borderColor = danger ? "rgba(191, 96, 96, 0.25)" : theme.border;
        e.currentTarget.style.background = danger ? "rgba(191, 96, 96, 0.06)" : "transparent";
      }}
    >
      {icon}
      {label}
    </button>
  );
}
