import React, { useCallback, useEffect, useRef, useState } from "react";
import { theme, mono, sans, shadows } from "../theme";

interface SearchBarProps {
  visible: boolean;
  onClose: () => void;
  onSearch: (query: string) => void;
  matchCount: number;
  currentMatch: number;
  onNext: () => void;
  onPrev: () => void;
}

export function SearchBar({
  visible,
  onClose,
  onSearch,
  matchCount,
  currentMatch,
  onNext,
  onPrev,
}: SearchBarProps): React.ReactElement | null {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [visible]);

  useEffect(() => {
    onSearch(query);
  }, [query, onSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter") {
        if (e.shiftKey) onPrev();
        else onNext();
      }
    },
    [onClose, onNext, onPrev],
  );

  if (!visible) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 16,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        background: theme.elevated,
        border: `1px solid ${theme.borderHover}`,
        borderTop: "none",
        borderRadius: "0 0 4px 4px",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={theme.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in conversation..."
        style={{
          width: 180,
          border: "none",
          background: "transparent",
          outline: "none",
          fontFamily: sans,
          fontSize: 13,
          color: theme.text,
          padding: 0,
        }}
      />
      {query && (
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            color: matchCount > 0 ? theme.secondary : theme.error,
            flexShrink: 0,
          }}
        >
          {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : "No matches"}
        </span>
      )}
      {matchCount > 1 && (
        <>
          <button
            type="button"
            onClick={onPrev}
            style={navBtnStyle}
            title="Previous (Shift+Enter)"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 12V4M4 8l4-4 4 4" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onNext}
            style={navBtnStyle}
            title="Next (Enter)"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 4v8M4 8l4 4 4-4" />
            </svg>
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onClose}
        style={{
          ...navBtnStyle,
          marginLeft: 2,
        }}
        title="Close (Esc)"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  border: "none",
  borderRadius: 3,
  background: "transparent",
  color: theme.muted,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};
