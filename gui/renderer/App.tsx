import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { SessionRegistryProvider, SessionProvider, useSession, useSessionRegistry } from "./context";
import { ChatView } from "./components/ChatView";
import { StatusBar } from "./components/StatusBar";
import { Sidebar } from "./components/Sidebar";
import { AskOverlay } from "./components/AskOverlay";
import { SettingsPanel } from "./components/SettingsPanel";
import { theme, sans, mono } from "./theme";
import { ToastProvider, useToast } from "./components/Toast";

// ---------------------------------------------------------------------------
// UI preferences context (markdown mode, etc.)
// ---------------------------------------------------------------------------

interface UiPrefs {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  settingsOpen: boolean;
  settingsInitialTab?: string;
  settingsInitialProvider?: string;
  openSettings: (tab?: string, providerId?: string) => void;
  closeSettings: () => void;
}

const UiPrefsContext = createContext<UiPrefs>({
  sidebarCollapsed: false,
  toggleSidebar: () => {},
  settingsOpen: false,
  openSettings: () => {},
  closeSettings: () => {},
});

export const useUiPrefs = (): UiPrefs => useContext(UiPrefsContext);

/** Global styles for custom scrollbars, selection, and pseudo-classes */
const globalStyles = `
  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 3px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.15);
  }
  ::selection {
    background: rgba(203, 138, 90, 0.25);
    color: inherit;
  }
  ::placeholder {
    color: rgba(155, 152, 144, 0.6);
  }
  @keyframes fadeInUp {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @keyframes overlayFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes overlayScaleIn {
    from { opacity: 0; transform: scale(0.97) translateY(4px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
  @keyframes session-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  :focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(203, 138, 90, 0.20);
  }
  textarea:focus-visible, input:focus-visible {
    box-shadow: none;
  }
`;

// ---------------------------------------------------------------------------
// Inner app (inside provider)
// ---------------------------------------------------------------------------

function AppInner(): React.ReactElement {
  const { pendingAsk, cancelTurn, cwd } = useSession();
  const { createSession, setForeground, foregroundSessionId, activeSessions } = useSessionRegistry();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("sidebar-collapsed") === "true"; } catch { return false; }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>();
  const [settingsInitialProvider, setSettingsInitialProvider] = useState<string | undefined>();

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("sidebar-collapsed", String(next)); } catch {}
      return next;
    });
  }, []);
  const openSettings = useCallback((tab?: string, providerId?: string) => {
    setSettingsInitialTab(tab);
    setSettingsInitialProvider(providerId);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsInitialTab(undefined);
    setSettingsInitialProvider(undefined);
  }, []);

  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "TEXTAREA" || target.tagName === "INPUT";

      // Escape: close overlays, then cancel turn
      if (e.key === "Escape") {
        if (shortcutHelpOpen) {
          setShortcutHelpOpen(false);
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        cancelTurn();
        return;
      }

      // Ctrl+/ — show shortcut help
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setShortcutHelpOpen((v) => !v);
        return;
      }

      // Cmd+B / Ctrl+B: toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === "b" && !isInput) {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
        return;
      }

      // Cmd+L / Ctrl+L: focus input
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        const textarea = document.querySelector("textarea");
        if (textarea) textarea.focus();
        return;
      }

      // Cmd+N / Ctrl+N: new session in current project
      if ((e.metaKey || e.ctrlKey) && e.key === "n" && !isInput) {
        e.preventDefault();
        // Determine current project from the foreground session
        const fg = activeSessions.find((s) => s.sessionId === foregroundSessionId);
        const projectPath = fg?.projectPath || cwd;
        if (projectPath) {
          createSession(projectPath).then((sid) => setForeground(sid));
        }
        return;
      }

      // Cmd+, / Ctrl+, — open settings
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelTurn, settingsOpen, shortcutHelpOpen, activeSessions, foregroundSessionId, cwd, createSession, setForeground]);

  return (
    <UiPrefsContext.Provider value={{ sidebarCollapsed, toggleSidebar, settingsOpen, settingsInitialTab, settingsInitialProvider, openSettings, closeSettings }}>
      <style>{globalStyles}</style>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          width: "100vw",
          overflow: "hidden",
          backgroundColor: theme.bg,
          color: theme.text,
          fontFamily: sans,
          fontSize: 14,
        }}
      >
        {/* Unified top bar — full width, fixed position above sidebar + main */}
        <UnifiedTopBar
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onNewSession={() => {
            const fg = activeSessions.find((s) => s.sessionId === foregroundSessionId);
            const projectPath = fg?.projectPath || cwd;
            if (projectPath) {
              createSession(projectPath).then((sid) => setForeground(sid));
            }
          }}
          projectPath={(() => {
            const fg = activeSessions.find((s) => s.sessionId === foregroundSessionId);
            return fg?.projectPath || cwd;
          })()}
        />

        {/* Two-column grid below the top bar */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: sidebarCollapsed ? "0px 1fr" : "260px 1fr",
            flex: 1,
            overflow: "hidden",
            transition: "grid-template-columns 200ms ease",
          }}
        >
          {/* Sidebar (no header — buttons are in UnifiedTopBar) */}
          <div style={{ overflow: "hidden", borderRight: `1px solid ${theme.border}`, backgroundColor: theme.sidebarBg }}>
            {!sidebarCollapsed && <Sidebar />}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              position: "relative",
            }}
          >
            <div
              style={{
                flex: 1,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
              <ChatView />
            </div>
            <StatusBar />
          </div>
        </div>

        {pendingAsk && <AskOverlay />}
        <SettingsPanel open={settingsOpen} onClose={closeSettings} initialTab={settingsInitialTab} initialProvider={settingsInitialProvider} />
        {shortcutHelpOpen && <ShortcutHelpOverlay onClose={() => setShortcutHelpOpen(false)} />}
      </div>
    </UiPrefsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Keyboard shortcut help overlay
// ---------------------------------------------------------------------------

const SHORTCUTS = [
  { keys: ["Enter"], desc: "Send message" },
  { keys: ["Shift", "Enter"], desc: "New line" },
  { keys: ["Esc"], desc: "Cancel / close" },
  { keys: ["⌘", "B"], desc: "Toggle sidebar" },
  { keys: ["⌘", "L"], desc: "Focus input" },
  { keys: ["⌘", "N"], desc: "New session" },
  { keys: ["⌘", ","], desc: "Settings" },
  { keys: ["/"], desc: "Slash commands" },
  { keys: ["⌘", "/"], desc: "This help" },
];

// ---------------------------------------------------------------------------
// Unified top bar — spans full width, holds sidebar toggle + new session + export
// ---------------------------------------------------------------------------

function UnifiedTopBar({
  sidebarCollapsed,
  onToggleSidebar,
  onNewSession,
  projectPath,
}: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewSession: () => void;
  projectPath: string;
}): React.ReactElement {
  const { messages } = useSession();
  const { toast } = useToast();

  const handleExport = useCallback(() => {
    if (messages.length === 0) return;
    const lines: string[] = [];
    for (const msg of messages) {
      if (msg.kind === "user") lines.push(`**You:**\n${msg.text}\n`);
      else if (msg.kind === "assistant") lines.push(`**Assistant:**\n${msg.text}\n`);
      else if (msg.kind === "tool_use") lines.push(`> \`${(msg as any).toolName ?? "tool"}\`\n`);
    }
    const md = lines.join("\n---\n\n");
    navigator.clipboard.writeText(md).then(() => toast("Copied to clipboard", "success")).catch(() => {});
  }, [messages, toast]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 38,
        minHeight: 38,
        padding: "0 12px 0 78px", /* 78px left to clear macOS traffic lights */
        borderBottom: `1px solid ${theme.border}`,
        WebkitAppRegion: "drag",
        backgroundColor: theme.bg,
      } as React.CSSProperties}
    >
      {/* Left: sidebar toggle + new session */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <TopBarButton
          title={sidebarCollapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
          onClick={onToggleSidebar}
          icon={
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="1" y="2" width="14" height="12" rx="1.5" />
              <line x1="5.5" y1="2" x2="5.5" y2="14" />
            </svg>
          }
        />
        <TopBarButton
          title="New session (⌘N)"
          onClick={onNewSession}
          icon={
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
          }
        />
      </div>

      {/* Center: project path */}
      {projectPath && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            fontFamily: mono,
            fontSize: 11,
            color: theme.muted,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "40%",
            pointerEvents: "none",
          }}
          title={projectPath}
        >
          {projectPath.replace(/^\/Users\/[^/]+/, "~")}
        </div>
      )}

      {/* Right: export (only when conversation exists) */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {messages.length > 0 && (
          <TopBarButton
            title="Export"
            onClick={handleExport}
            label="Export"
            icon={
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v8M4 6l4 4 4-4" />
                <path d="M2 12v2h12v-2" />
              </svg>
            }
          />
        )}
      </div>
    </div>
  );
}

function TopBarButton({
  title,
  onClick,
  icon,
  label,
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
  label?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 26,
        padding: label ? "0 8px" : "0 5px",
        border: "none",
        borderRadius: 4,
        background: "transparent",
        color: theme.muted,
        cursor: "pointer",
        fontFamily: mono,
        fontSize: 10,
        transition: "color 120ms ease, background 120ms ease",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = theme.secondary; e.currentTarget.style.background = theme.elevated; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = theme.muted; e.currentTarget.style.background = "transparent"; }}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}

function ShortcutHelpOverlay({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        animation: "overlayFadeIn 150ms ease-out",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 360,
          backgroundColor: theme.surface,
          border: `1px solid ${theme.borderHover}`,
          borderRadius: 4,
          overflow: "hidden",
          animation: "overlayScaleIn 150ms ease-out",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: theme.text }}>
            Keyboard Shortcuts
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: 22, height: 22, border: "none", borderRadius: 4,
              background: "transparent", color: theme.muted, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: "12px 18px 16px" }}>
          {SHORTCUTS.map(({ keys, desc }) => (
            <div
              key={desc}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "6px 0",
                fontFamily: mono,
                fontSize: 12,
              }}
            >
              <span style={{ color: theme.secondary }}>{desc}</span>
              <span style={{ display: "flex", gap: 4 }}>
                {keys.map((k) => (
                  <kbd
                    key={k}
                    style={{
                      padding: "3px 7px",
                      borderRadius: 4,
                      border: `1px solid ${theme.borderHover}`,
                      backgroundColor: theme.elevated,
                      fontSize: 11,
                      fontFamily: mono,
                      color: theme.text,
                      lineHeight: 1,
                      minWidth: 20,
                      textAlign: "center" as const,
                    }}
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function App(): React.ReactElement {
  return (
    <SessionRegistryProvider>
      <SessionProvider>
        <ToastProvider>
          <AppInner />
        </ToastProvider>
      </SessionProvider>
    </SessionRegistryProvider>
  );
}
