import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationEntry } from "../context";
import { useSession } from "../context";
import { MessageBubble } from "./MessageBubble";
import { theme, mono, sans, shadows } from "../theme";

interface MessageListProps {
  messages: ConversationEntry[];
  searchQuery?: string;
  searchMatches?: Set<number>;
  currentSearchMatch?: number;
}

const cursorKeyframes = `
@keyframes forge-cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

function shortenPath(p: string): string {
  const homeMatch = p.match(/\/Users\/[^/]+\/(.+)/);
  return homeMatch ? `~/${homeMatch[1]}` : p;
}

export function MessageList({
  messages,
  searchQuery,
  searchMatches,
  currentSearchMatch,
}: MessageListProps): React.ReactElement {
  const { cwd } = useSession();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const userScrolledRef = useRef(false);
  const prevMessageCountRef = useRef(0);
  const [unreadCount, setUnreadCount] = useState(0);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const threshold = 60;
    // Only consider "not at bottom" if content actually overflows
    const hasOverflow = el.scrollHeight > el.clientHeight + threshold;
    const atBottom = !hasOverflow || el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setIsAtBottom(atBottom);

    if (atBottom) {
      userScrolledRef.current = false;
      setUnreadCount(0);
    } else {
      userScrolledRef.current = true;
    }
  }, []);

  // Content is rendered directly from log entries (same as TUI).
  // No streaming dedup needed — log:updated provides the authoritative view.

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const newMessages = messages.length - prevCount;

    if (!userScrolledRef.current && bottomRef.current) {
      // Use instant scroll for large jumps (session load), smooth for streaming
      const isSessionLoad = prevCount === 0 && messages.length > 1;
      const isLargeJump = Math.abs(newMessages) > 3;
      const behavior = isSessionLoad || isLargeJump ? "instant" : "smooth";
      bottomRef.current.scrollIntoView({ behavior: behavior as ScrollBehavior });
      // Force isAtBottom after instant scroll
      if (behavior === "instant") {
        setIsAtBottom(true);
      }
    } else if (userScrolledRef.current && newMessages > 0) {
      // User is scrolled up — count unread messages
      setUnreadCount((prev) => prev + newMessages);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);

  const scrollToBottom = useCallback(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
      userScrolledRef.current = false;
      setIsAtBottom(true);
      setUnreadCount(0);
    }
  }, []);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <style>{cursorKeyframes}</style>
      {/* Top fade gradient for depth */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 24,
          background: `linear-gradient(to bottom, ${theme.bg}, transparent)`,
          zIndex: 2,
          pointerEvents: "none",
        }}
      />
      <div
        ref={scrollRef}
        style={{
          height: "100%",
          overflowY: "auto",
          overflowX: "hidden",
          padding: "32px 28px 24px",
          scrollBehavior: "smooth",
        }}
        onScroll={handleScroll}
      >
        {messages.length === 0 && (
          <WelcomeScreen cwd={cwd} />
        )}

        {messages.map((entry, idx) => {
          const isSearchMatch = searchMatches?.has(idx);
          const isCurrentMatch = currentSearchMatch === idx;
          return (
            <div
              key={entry.id ?? `msg-${idx}`}
              data-msg-idx={idx}
              style={{
                borderRadius: 4,
                outline: isCurrentMatch
                  ? `2px solid ${theme.accent}`
                  : isSearchMatch
                    ? `1px solid ${theme.accentBorder}`
                    : "none",
                outlineOffset: 4,
                transition: "outline 200ms ease",
              }}
            >
              <MessageBubble entry={entry} />
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {!isAtBottom && messages.length > 0 && (
        <button
          type="button"
          style={{
            position: "absolute",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            width: 32,
            height: 32,
            backgroundColor: theme.surface,
            color: theme.secondary,
            border: `1px solid ${theme.borderHover}`,
            borderRadius: 4,
            padding: 0,
            cursor: "pointer",
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "color 150ms ease, border-color 150ms ease",
          }}
          onClick={scrollToBottom}
          onMouseEnter={(e) => { e.currentTarget.style.color = theme.accent; e.currentTarget.style.borderColor = theme.accentBorder; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = theme.secondary; e.currentTarget.style.borderColor = theme.borderHover; }}
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3v10M4 9l4 4 4-4" />
          </svg>
          {/* Number badge removed — arrow-only is cleaner */}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-action card data
// ---------------------------------------------------------------------------

const quickActions = [
  {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    ),
    title: "Init project",
    prompt: "",
    color: "#6B9F78",
  },
  {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
    title: "Review code",
    prompt: "Review the code in this project for quality and potential issues",
    color: "#9370DB",
  },
];

// ---------------------------------------------------------------------------
// Welcome Screen
// ---------------------------------------------------------------------------

// No animated keyframes for the welcome logo — static, industrial.

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "Working late?";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Working late?";
}

function WelcomeScreen({ cwd }: { cwd: string }): React.ReactElement {
  const { sendMessage } = useSession();
  const [hoveredCard, setHoveredCard] = useState<number | null>(null);
  const greeting = getGreeting();

  const handleQuickAction = useCallback(
    (prompt: string) => {
      // If prompt ends with ": " it's a partial prompt — focus input and fill it
      if (prompt.endsWith(": ") || prompt.endsWith(" ")) {
        const textarea = document.querySelector("textarea");
        if (textarea) {
          // Trigger a synthetic change
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          nativeInputValueSetter?.call(textarea, prompt);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.focus();
        }
      } else {
        sendMessage(prompt);
      }
    },
    [sendMessage],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        userSelect: "none",
        gap: 16,
        paddingBottom: "4%",
      }}
    >
      {/* Greeting */}
      <span
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: theme.muted,
          letterSpacing: "0.08em",
          textTransform: "uppercase" as const,
        }}
      >
        {greeting}
      </span>

      {/* Name */}
      <span
        style={{
          fontFamily: mono,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "0.10em",
          color: theme.text,
          marginTop: -4,
        }}
      >
        LongerAgent
      </span>

      {/* Project path */}
      {cwd && (
        <span
          style={{
            fontFamily: mono,
            fontSize: 11,
            color: theme.secondary,
            letterSpacing: "0.02em",
            marginTop: 2,
          }}
          title={cwd}
        >
          {shortenPath(cwd)}
        </span>
      )}

      {/* No project state */}
      {!cwd && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginTop: -6 }}>
          <span style={{ fontSize: 12, color: theme.muted, letterSpacing: "0.02em" }}>
            Open a folder to start a conversation
          </span>
          <button
            type="button"
            onClick={() => {
              const api = (window as any).api;
              if (api) api.invoke("dialog:openFolder").catch(() => {});
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 20px",
              borderRadius: 4,
              border: `1px solid ${theme.borderHover}`,
              backgroundColor: theme.surface,
              cursor: "pointer",
              fontFamily: mono,
              fontSize: 12,
              fontWeight: 500,
              color: theme.text,
              letterSpacing: "0.02em",
              transition: "border-color 120ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = theme.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.borderHover; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Open Folder
          </button>
        </div>
      )}

      {/* Quick action cards — only shown when a project is active */}
      {cwd && (
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 20,
            maxWidth: 320,
            width: "100%",
            padding: "0 20px",
          }}
        >
          {quickActions.map((action, i) => (
            <button
              type="button"
              key={action.title}
              onClick={() => action.prompt && handleQuickAction(action.prompt)}
              onMouseEnter={() => setHoveredCard(i)}
              onMouseLeave={() => setHoveredCard(null)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "10px 14px",
                borderRadius: 4,
                border: `1px solid ${hoveredCard === i ? `${action.color}40` : `${action.color}25`}`,
                backgroundColor: theme.surface,
                cursor: action.prompt ? "pointer" : "default",
                textAlign: "center",
                transition: "border-color 120ms ease",
                color: theme.text,
                fontFamily: sans,
                opacity: action.prompt ? 1 : 0.5,
              }}
            >
              <div
                style={{
                  color: hoveredCard === i ? action.color : `${action.color}99`,
                  transition: "color 120ms ease",
                  flexShrink: 0,
                }}
              >
                {action.icon}
              </div>
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 12,
                  fontWeight: 500,
                  letterSpacing: "0.02em",
                  color: hoveredCard === i ? theme.text : theme.secondary,
                  transition: "color 120ms ease",
                }}
              >
                {action.title}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
