import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../context";
import { MessageList } from "./MessageList";
import { InputArea } from "./InputArea";
import { PlanPanel } from "./PlanPanel";
import { theme, mono, sans } from "../theme";
import { useToast } from "./Toast";
import { SearchBar } from "./SearchBar";

// ---------------------------------------------------------------------------
// Animations
// ---------------------------------------------------------------------------

const statusAnimKeyframes = `
@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
@keyframes thinking-dot-1 {
  0%, 100% { opacity: 0.2; transform: scale(0.8); }
  25% { opacity: 1; transform: scale(1.1); }
}
@keyframes thinking-dot-2 {
  0%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.1); }
}
@keyframes thinking-dot-3 {
  0%, 100% { opacity: 0.2; transform: scale(0.8); }
  55% { opacity: 1; transform: scale(1.1); }
}
`;

function stateLabel(s: string): string | null {
  switch (s) {
    case "thinking": return "Thinking";
    case "tool_calling": return "Running tool";
    case "asking": return "Awaiting input";
    case "cancelling": return "Cancelling";
    default: return null;
  }
}

function stateColor(s: string): string {
  switch (s) {
    case "thinking": return theme.accent;
    case "tool_calling": return theme.warning;
    case "asking": return theme.success;
    case "cancelling": return theme.error;
    default: return theme.muted;
  }
}

// ---------------------------------------------------------------------------
// Thinking dots animation
// ---------------------------------------------------------------------------

function ThinkingDots({ color }: { color: string }): React.ReactElement {
  return (
    <span style={{ display: "inline-flex", gap: 3, marginLeft: 4 }}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            backgroundColor: color,
            animation: `thinking-dot-${n} 1.4s ease-in-out infinite`,
          }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

function StatusIndicator(): React.ReactElement | null {
  const { state } = useSession();
  const label = stateLabel(state);
  const color = stateColor(state);
  const isBusy = state === "thinking" || state === "tool_calling";

  // Elapsed timer
  const startRef = useRef<number>(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isBusy) {
      startRef.current = Date.now();
      setElapsed(0);
      const id = setInterval(() => {
        setElapsed(Date.now() - startRef.current);
      }, 100);
      return () => clearInterval(id);
    } else {
      setElapsed(0);
    }
  }, [isBusy]);

  if (!label) return null;

  const secs = Math.floor(elapsed / 1000);
  const elapsedDisplay = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : secs >= 3 ? `${secs}s` : null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 28px",
        fontFamily: mono,
        fontSize: 12,
        color,
        borderLeft: `2px solid ${color}`,
        marginLeft: 20,
        marginRight: 20,
        marginBottom: 4,
        borderRadius: 2,
        backgroundColor: `${color}08`,
        transition: "all 200ms ease",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          animation: isBusy ? "status-pulse 1.2s ease-in-out infinite" : "none",
          flexShrink: 0,
        }}
      />
      <span style={{ fontWeight: 500 }}>{label}</span>
      {isBusy && <ThinkingDots color={color} />}
      {elapsedDisplay && (
        <span style={{ color: theme.muted }}>{elapsedDisplay}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat header with session actions
// ---------------------------------------------------------------------------

// ChatHeader + HeaderAction removed — actions moved to UnifiedTopBar in App.tsx

// ---------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------

export function ChatView(): React.ReactElement {
  const { messages } = useSession();
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndices, setMatchIndices] = useState<number[]>([]);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);

  // Cmd+F to open search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchVisible(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (!query.trim()) {
        setMatchIndices([]);
        setCurrentMatchIdx(0);
        return;
      }
      const q = query.toLowerCase();
      const indices: number[] = [];
      messages.forEach((m, i) => {
        if (
          (m.kind === "user" || m.kind === "assistant") &&
          m.text.toLowerCase().includes(q)
        ) {
          indices.push(i);
        }
      });
      setMatchIndices(indices);
      setCurrentMatchIdx(0);
      // Scroll to first match
      if (indices.length > 0) {
        scrollToMessage(indices[0]);
      }
    },
    [messages],
  );

  const scrollToMessage = useCallback((idx: number) => {
    const msgEl = document.querySelector(`[data-msg-idx="${idx}"]`);
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  const handleNextMatch = useCallback(() => {
    if (matchIndices.length === 0) return;
    const next = (currentMatchIdx + 1) % matchIndices.length;
    setCurrentMatchIdx(next);
    scrollToMessage(matchIndices[next]);
  }, [matchIndices, currentMatchIdx, scrollToMessage]);

  const handlePrevMatch = useCallback(() => {
    if (matchIndices.length === 0) return;
    const prev = (currentMatchIdx - 1 + matchIndices.length) % matchIndices.length;
    setCurrentMatchIdx(prev);
    scrollToMessage(matchIndices[prev]);
  }, [matchIndices, currentMatchIdx, scrollToMessage]);

  const handleCloseSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchQuery("");
    setMatchIndices([]);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <style>{statusAnimKeyframes}</style>
      {/* ChatHeader removed — actions are in UnifiedTopBar */}
      <SearchBar
        visible={searchVisible}
        onClose={handleCloseSearch}
        onSearch={handleSearch}
        matchCount={matchIndices.length}
        currentMatch={currentMatchIdx}
        onNext={handleNextMatch}
        onPrev={handlePrevMatch}
      />
      <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
        <MessageList
          messages={messages}
          searchQuery={searchQuery}
          searchMatches={new Set(matchIndices)}
          currentSearchMatch={matchIndices[currentMatchIdx]}
        />
      </div>
      <div style={{ flexShrink: 0 }}>
        <PlanPanel />
        <InputArea />
      </div>
    </div>
  );
}
