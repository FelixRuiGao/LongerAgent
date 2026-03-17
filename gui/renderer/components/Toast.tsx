import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { theme, mono, sans } from "../theme";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToastType = "info" | "success" | "error" | "warning";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  exiting: boolean;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
});

export const useToast = () => useContext(ToastContext);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const TOAST_DURATION_SHORT = 3000;
const TOAST_DURATION_LONG = 8000;

const toastKeyframes = `
@keyframes toast-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes toast-exit {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-6px); }
}
`;

const TYPE_COLORS: Record<ToastType, string> = {
  info: theme.accent,
  success: theme.success,
  error: theme.error,
  warning: theme.warning,
};

const TYPE_ICONS: Record<ToastType, React.ReactNode> = {
  info: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4" />
      <circle cx="8" cy="5" r="0.5" fill="currentColor" />
    </svg>
  ),
  success: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3,8 6.5,11.5 13,4.5" />
    </svg>
  ),
  error: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M10 6L6 10M6 6l4 4" />
    </svg>
  ),
  warning: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2L1.5 13h13L8 2z" />
      <path d="M8 6v3" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" />
    </svg>
  ),
};

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message, type, exiting: false }]);

    // Longer messages get more time
    const duration = message.length > 80 ? TOAST_DURATION_LONG : TOAST_DURATION_SHORT;

    setTimeout(() => {
      // Start exit animation
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
      // Remove after animation
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 200);
    }, duration);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      <style>{toastKeyframes}</style>
      {children}
      {/* Toast container */}
      {toasts.length > 0 && (
        <div
          style={{
            position: "fixed",
            top: 48,
            right: 16,
            zIndex: 10000,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            pointerEvents: "none",
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 16px",
                background: theme.elevated,
                border: `1px solid ${TYPE_COLORS[t.type]}30`,
                borderRadius: 4,
                color: TYPE_COLORS[t.type],
                fontFamily: mono,
                fontSize: 12,
                animation: t.exiting ? "toast-exit 200ms ease-out forwards" : "toast-enter 200ms ease-out",
                pointerEvents: "auto",
              }}
            >
              {TYPE_ICONS[t.type]}
              <span style={{ color: theme.text, whiteSpace: "pre-wrap", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }}>{t.message}</span>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
