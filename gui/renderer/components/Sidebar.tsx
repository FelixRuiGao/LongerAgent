import React, { useCallback, useEffect, useState } from "react";
import { useSession, useSessionRegistry } from "../context";
import { useUiPrefs } from "../App";
import { theme, mono, sans, formatTokens } from "../theme";
import { FileTree } from "./FileTree";

interface SessionSummary {
  path: string;
  label?: string;
  created?: string;
  lastActiveAt?: string;
  summary?: string;
  title?: string;
  turns?: number;
}

function sessionDisplayName(s: SessionSummary): string {
  return s.title || s.summary || s.label || "Untitled";
}

interface ProjectInfo {
  slug: string;
  originalPath: string;
  lastActiveAt: string;
}

function relativeDate(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString();
}

type DateGroup = "Today" | "Yesterday" | "This Week" | "This Month" | "Older";

function getDateGroup(iso: string): DateGroup {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(today.getTime() - 30 * 86_400_000);

  if (d >= today) return "Today";
  if (d >= yesterday) return "Yesterday";
  if (d >= weekAgo) return "This Week";
  if (d >= monthAgo) return "This Month";
  return "Older";
}

function groupSessionsByDate(sessions: SessionSummary[]): Array<{ group: DateGroup; sessions: SessionSummary[] }> {
  const groups = new Map<DateGroup, SessionSummary[]>();
  const order: DateGroup[] = ["Today", "Yesterday", "This Week", "This Month", "Older"];

  for (const s of sessions) {
    const key = getDateGroup(s.lastActiveAt || s.created || "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  return order
    .filter((g) => groups.has(g))
    .map((g) => ({ group: g, sessions: groups.get(g)! }));
}

function projectLabel(p: ProjectInfo): string {
  return p.originalPath.split("/").pop() || p.slug;
}

function fullShortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

const MAX_VISIBLE_SESSIONS = 10;
const MAX_VISIBLE_PROJECTS = 5;

export function Sidebar(): React.ReactElement {
  const { resetSession, cwd, state, messages } = useSession();
  const { activeSessions, foregroundSessionId, setForeground, createSession, loadSession } = useSessionRegistry();
  const { toggleSidebar } = useUiPrefs();

  // ---- All projects (unified, ordered) ----
  const [allProjects, setAllProjects] = useState<ProjectInfo[]>([]);
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [showAllProjects, setShowAllProjects] = useState(false);

  // ---- Session state (unified — all projects use the same data structure) ----
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => cwd ? new Set([cwd]) : new Set());
  const [projectSessions, setProjectSessions] = useState<Record<string, SessionSummary[]>>({});
  const [projectShowAll, setProjectShowAll] = useState<Set<string>>(new Set());

  // ---- Hover state ----
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);

  // ---- Load data ----
  // Load sessions for a specific project (unified — no special "current project" path)
  const loadProjectSessions = useCallback(async (projectPath: string) => {
    const api = (window as any).api;
    if (!api) return;
    try {
      const list = await api.invoke("store:listProjectSessions", projectPath);
      if (Array.isArray(list)) {
        setProjectSessions((prev) => ({ ...prev, [projectPath]: list }));
      }
    } catch { /* ignore */ }
  }, []);

  // Load sessions for all currently expanded projects
  const refreshExpandedSessions = useCallback(async () => {
    for (const key of expandedProjects) {
      loadProjectSessions(key);
    }
  }, [expandedProjects, loadProjectSessions]);

  const loadProjects = useCallback(async () => {
    const api = (window as any).api;
    if (!api) return;
    try {
      const [list, order] = await Promise.all([
        api.invoke("store:listProjects"),
        api.invoke("store:getProjectOrder"),
      ]);
      if (Array.isArray(list)) setAllProjects(list);
      if (Array.isArray(order) && order.length > 0) {
        setProjectOrder(order);
      } else {
        // First launch: persist the current order (sorted by lastActiveAt from backend)
        const initialOrder = (list as ProjectInfo[]).map((p) => p.originalPath);
        setProjectOrder(initialOrder);
        api.invoke("store:setProjectOrder", initialOrder).catch(() => {});
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadProjects();
    refreshExpandedSessions();

    // Listen for sidebar:refresh from main process (triggered on every log save)
    const api = (window as any).api;
    if (api) {
      const unsub = api.on("sidebar:refresh", () => {
        refreshExpandedSessions();
      });
      return () => { unsub?.(); };
    }
  }, [loadProjects, refreshExpandedSessions]);

  // When a turn completes (state goes from busy → idle), refresh sessions
  // and auto-select the first one if we don't have an active session yet.
  // When messages are cleared AND no foreground session has this path,
  // it means a new session was created — clear highlight and refresh.
  // We use a ref flag to distinguish "user clicked new session" from "session switch reset".
  const newSessionFlag = React.useRef(false);
  useEffect(() => {
    if (newSessionFlag.current && messages.length === 0) {
      newSessionFlag.current = false;
      setActiveSession(null);
      refreshExpandedSessions();
    }
  }, [messages.length, refreshExpandedSessions]);

  const prevStateRef = React.useRef(state);
  useEffect(() => {
    const wasActive = prevStateRef.current !== "idle";
    prevStateRef.current = state;
    if (wasActive && state === "idle" && messages.length > 0) {
      // Delay slightly so auto-save has time to write
      const timer = setTimeout(() => {
        refreshExpandedSessions().then(() => {
          if (!activeSession && cwd) {
            // Auto-select the first session of the current project
            const cwdSessions = projectSessions[cwd];
            if (cwdSessions && cwdSessions.length > 0) {
              setActiveSession(cwdSessions[0].path);
            }
          }
        });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [state, refreshExpandedSessions, activeSession, messages.length, cwd, projectSessions]);

  // ---- Actions ----
  const handleNewSession = useCallback(async (projectPath?: string) => {
    const targetProject = projectPath || cwd;
    if (!targetProject) return;
    const sessionId = await createSession(targetProject);
    setForeground(sessionId);
    newSessionFlag.current = true;
    setActiveSession(null);
    refreshExpandedSessions();
  }, [cwd, createSession, setForeground, refreshExpandedSessions]);

  const handleLoadSession = useCallback(
    async (path: string) => {
      // Check if there's already a live session for this path
      const live = activeSessions.find((s) => s.sessionPath === path);
      if (live) {
        setForeground(live.sessionId);
        setActiveSession(path);
        return;
      }
      // Determine project path from projectSessions
      let projectPath = cwd;
      for (const [pp, psList] of Object.entries(projectSessions)) {
        if (psList.some((s) => s.path === path)) {
          projectPath = pp;
          break;
        }
      }
      const sessionId = await loadSession(path, projectPath);
      setForeground(sessionId);
      setActiveSession(path);
      refreshExpandedSessions();
    },
    [activeSessions, projectSessions, cwd, setForeground, loadSession, refreshExpandedSessions],
  );

  // ---- Archive handler ----
  const handleArchiveSession = useCallback(async (path: string) => {
    const api = (window as any).api;
    if (!api) return;
    await api.invoke("store:archiveSession", path);
    if (activeSession === path) {
      setActiveSession(null);
    }
    refreshExpandedSessions();
  }, [activeSession, refreshExpandedSessions]);

  // ---- Deletion confirmation state ----
  const [pendingDelete, setPendingDelete] = useState<{ path: string; name: string } | null>(null);

  const handleDeleteSession = useCallback(
    async (path: string) => {
      const allSessions = Object.values(projectSessions).flat();
      const found = allSessions.find((s) => s.path === path);
      const sessionName = found ? sessionDisplayName(found) : "Untitled session";
      setPendingDelete({ path, name: sessionName });
    },
    [projectSessions],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const api = (window as any).api;
    if (!api) return;
    try {
      await api.invoke("store:deleteSession", pendingDelete.path);
      if (activeSession === pendingDelete.path) {
        resetSession();
        setActiveSession(null);
      }
      refreshExpandedSessions();
    } catch { /* ignore */ }
    setPendingDelete(null);
  }, [pendingDelete, activeSession, refreshExpandedSessions, resetSession]);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const toggleProjectExpand = useCallback(async (project: ProjectInfo) => {
    const key = project.originalPath;
    if (expandedProjects.has(key)) {
      setExpandedProjects((prev) => { const next = new Set(prev); next.delete(key); return next; });
      return;
    }
    setExpandedProjects((prev) => new Set(prev).add(key));
    if (!projectSessions[key]) {
      const api = (window as any).api;
      if (!api) return;
      try {
        const list = await api.invoke("store:listProjectSessions", key);
        if (Array.isArray(list)) {
          setProjectSessions((prev) => ({ ...prev, [key]: list }));
        }
      } catch {
        setProjectSessions((prev) => ({ ...prev, [key]: [] }));
      }
    }
  }, [expandedProjects, projectSessions]);

  // ---- Derived ----
  // Sort projects by persisted order; new projects go to the end
  const sortedProjects = React.useMemo(() => {
    const orderMap = new Map(projectOrder.map((p, i) => [p, i]));
    return [...allProjects].sort((a, b) => {
      const ai = orderMap.get(a.originalPath) ?? Infinity;
      const bi = orderMap.get(b.originalPath) ?? Infinity;
      return ai - bi;
    });
  }, [allProjects, projectOrder]);
  const visibleProjects = showAllProjects ? sortedProjects : sortedProjects.slice(0, MAX_VISIBLE_PROJECTS);
  const hasMoreProjects = sortedProjects.length > MAX_VISIBLE_PROJECTS;

  // ---- Drag-to-reorder projects ----
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragSrcIdx = React.useRef<number | null>(null);

  const handleProjectDragStart = useCallback((idx: number, e: React.DragEvent) => {
    dragSrcIdx.current = idx;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  }, []);

  const handleProjectDragOver = useCallback((idx: number, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  }, []);

  const handleProjectDrop = useCallback((dropIdx: number, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIdx(null);
    const srcIdx = dragSrcIdx.current;
    if (srcIdx === null || srcIdx === dropIdx) return;

    const paths = sortedProjects.map((p) => p.originalPath);
    const [moved] = paths.splice(srcIdx, 1);
    paths.splice(dropIdx, 0, moved);
    setProjectOrder(paths);
    const api = (window as any).api;
    api?.invoke("store:setProjectOrder", paths).catch(() => {});
  }, [sortedProjects]);

  const handleProjectDragEnd = useCallback(() => {
    setDragOverIdx(null);
    dragSrcIdx.current = null;
  }, []);

  // (visibleCurrentSessions removed — all projects use projectSessions uniformly)

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: theme.sidebarBg,
        overflow: "hidden",
        fontFamily: sans,
        userSelect: "none",
        position: "relative",
      }}
    >
      {/* Search bar */}
      <SessionSearch
        sessions={Object.values(projectSessions).flat()}
        onLoadSession={handleLoadSession}
      />

      {/* Scrollable project list — all projects treated equally */}
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
        {visibleProjects.map((project, idx) => {
          const key = project.originalPath;
          const isCwd = key === cwd;
          const isExpanded = expandedProjects.has(key);

          // Unified: all projects use projectSessions
          const pSessions = projectSessions[key] || [];
          const showAll = projectShowAll.has(key);
          const visible = showAll ? pSessions : pSessions.slice(0, MAX_VISIBLE_SESSIONS);
          const hasMore = pSessions.length > MAX_VISIBLE_SESSIONS;

          return (
            <ProjectSection
              key={key}
              label={projectLabel(project)}
              path={key}
              isCurrent={isCwd}
              isExpanded={isExpanded}
              sessions={isExpanded ? visible : []}
              activeSession={activeSession}
              hoveredItem={hoveredItem}
              onHover={setHoveredItem}
              onLoadSession={handleLoadSession}
              onDeleteSession={handleDeleteSession}
              onArchiveSession={handleArchiveSession}
              onToggleExpand={() => toggleProjectExpand(project)}
              lastActive={relativeDate(project.lastActiveAt)}
              showAll={showAll}
              hasMore={hasMore}
              totalCount={pSessions.length}
              onShowAll={() => {
                setProjectShowAll((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key); else next.add(key);
                  return next;
                });
              }}
              onNewSession={() => handleNewSession(key)}
              draggable
              onDragStart={(e) => handleProjectDragStart(idx, e)}
              onDragOver={(e) => handleProjectDragOver(idx, e)}
              onDrop={(e) => handleProjectDrop(idx, e)}
              onDragEnd={handleProjectDragEnd}
              isDragOver={dragOverIdx === idx}
            />
          );
        })}

        {hasMoreProjects && (
          <ExpandButton
            label={showAllProjects ? "Show less" : `Show all ${sortedProjects.length} projects`}
            onClick={() => setShowAllProjects((v) => !v)}
          />
        )}
      </div>

      {/* Context usage footer — block-based */}
      <ContextBar />

      {/* Delete confirmation overlay */}
      {pendingDelete && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.5)",
          }}
          onClick={cancelDelete}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 220,
              backgroundColor: theme.surface,
              border: `1px solid ${theme.borderHover}`,
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "14px 16px 10px" }}>
              <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: theme.text, marginBottom: 6 }}>
                Delete session?
              </div>
              <div style={{ fontSize: 11, color: theme.secondary, lineHeight: 1.4, wordBreak: "break-word" }}>
                {pendingDelete.name}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, padding: "6px 12px 12px", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={cancelDelete}
                style={{
                  padding: "5px 12px",
                  fontSize: 11,
                  fontFamily: mono,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 4,
                  background: "transparent",
                  color: theme.secondary,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                style={{
                  padding: "5px 12px",
                  fontSize: 11,
                  fontFamily: mono,
                  border: `1px solid rgba(191, 96, 96, 0.3)`,
                  borderRadius: 4,
                  background: "rgba(191, 96, 96, 0.12)",
                  color: theme.error,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Project section ----

function ProjectSection({
  label,
  path,
  isCurrent,
  isExpanded,
  sessions,
  activeSession,
  hoveredItem,
  onHover,
  onLoadSession,
  onDeleteSession,
  onArchiveSession,
  onToggleExpand,
  lastActive,
  showAll,
  hasMore,
  totalCount,
  onShowAll,
  onNewSession,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragOver,
}: {
  label: string;
  path: string;
  isCurrent: boolean;
  isExpanded: boolean;
  sessions: SessionSummary[];
  activeSession: string | null;
  hoveredItem: string | null;
  onHover: (id: string | null) => void;
  onLoadSession: (path: string) => void;
  onDeleteSession?: (path: string) => void;
  onArchiveSession?: (path: string) => void;
  onToggleExpand?: () => void;
  lastActive?: string;
  showAll: boolean;
  hasMore: boolean;
  totalCount: number;
  onShowAll: () => void;
  onNewSession?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  isDragOver?: boolean;
}): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const { activeSessions } = useSessionRegistry();

  return (
    <div
      style={{ padding: "0 8px" }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {/* Drop indicator */}
      {isDragOver && (
        <div style={{ height: 2, backgroundColor: theme.accent, borderRadius: 1, margin: "0 8px" }} />
      )}
      {/* Project header */}
      <div
        onClick={onToggleExpand}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 8px",
          borderRadius: 4,
          cursor: "pointer",
          background: hovered ? theme.elevated : "transparent",
          transition: "background 100ms ease",
        }}
        title={path}
      >
        <span style={{ fontSize: 8, color: theme.muted, flexShrink: 0, width: 8, textAlign: "center" }}>
          {isExpanded ? "\u25BC" : "\u25B6"}
        </span>
        <span
          style={{
            fontFamily: mono,
            fontSize: 11,
            fontWeight: 400,
            color: theme.secondary,
            letterSpacing: "0.02em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {label}
        </span>
        {/* Per-project new session button */}
        {onNewSession && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onNewSession(); }}
            title="New session in this project"
            style={{
              width: 18, height: 18,
              border: `1px solid ${theme.border}`,
              borderRadius: 4,
              background: "transparent",
              color: theme.muted,
              cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 0, flexShrink: 0,
              transition: "border-color 100ms ease, color 100ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = theme.accent; e.currentTarget.style.borderColor = theme.accentBorder; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = theme.muted; e.currentTarget.style.borderColor = theme.border; }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="5" y1="1" x2="5" y2="9" />
              <line x1="1" y1="5" x2="9" y2="5" />
            </svg>
          </button>
        )}
      </div>

      {/* Sessions list */}
      {isExpanded && (
        <div style={{ paddingLeft: 14, marginBottom: 4 }}>
          {sessions.length === 0 && (
            <div style={{ fontSize: 11, color: theme.muted, padding: "4px 8px" }}>
              No sessions
            </div>
          )}
          {sessions.map((s) => {
            const live = activeSessions.find((a) => a.sessionPath === s.path);
            return (
              <SessionItem
                key={s.path}
                session={s}
                isActive={activeSession === s.path}
                isHovered={hoveredItem === s.path}
                onHover={onHover}
                onLoadSession={onLoadSession}
                onDeleteSession={onDeleteSession}
                onArchiveSession={onArchiveSession}
                liveState={live?.state}
              />
            );
          })}
          {hasMore && (
            <ExpandButton
              label={showAll ? "Show less" : `Show all ${totalCount}`}
              onClick={onShowAll}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---- Small components ----

function SidebarButton({ icon, onClick, title, accent }: {
  icon: "sidebar" | "plus";
  onClick: () => void;
  title: string;
  accent?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        width: 26,
        height: 26,
        border: accent ? `1px solid ${theme.borderHover}` : "none",
        borderRadius: 4,
        background: "transparent",
        color: theme.muted,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "color 150ms ease, background 150ms ease, border-color 150ms ease",
      }}
      onMouseEnter={(e) => {
        if (accent) {
          e.currentTarget.style.color = theme.accent;
          e.currentTarget.style.borderColor = theme.accentBorder;
          e.currentTarget.style.background = theme.accentDim;
        } else {
          e.currentTarget.style.color = theme.secondary;
          e.currentTarget.style.background = theme.elevated;
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = theme.muted;
        e.currentTarget.style.background = "transparent";
        if (accent) e.currentTarget.style.borderColor = theme.borderHover;
      }}
    >
      {icon === "sidebar" ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="1" y="2" width="14" height="12" rx="1.5" />
          <line x1="5.5" y1="2" x2="5.5" y2="14" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <line x1="8" y1="3" x2="8" y2="13" />
          <line x1="3" y1="8" x2="13" y2="8" />
        </svg>
      )}
    </button>
  );
}

function ExpandButton({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        background: "none",
        border: "none",
        color: theme.muted,
        fontFamily: mono,
        fontSize: 10,
        padding: "6px 10px",
        cursor: "pointer",
        textAlign: "left",
        transition: "color 100ms ease",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = theme.accent; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = theme.muted; }}
    >
      {label} {"\u2192"}
    </button>
  );
}

// ---- Session item with context menu ----

function SessionItem({
  session,
  isActive,
  isHovered,
  onHover,
  onLoadSession,
  onDeleteSession,
  onArchiveSession,
  liveState,
}: {
  session: SessionSummary;
  isActive: boolean;
  isHovered: boolean;
  onHover: (id: string | null) => void;
  onLoadSession: (path: string) => void;
  onDeleteSession?: (path: string) => void;
  onArchiveSession?: (path: string) => void;
  liveState?: string;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const ctxMenuRef = React.useRef<HTMLDivElement>(null);
  const itemRef = React.useRef<HTMLDivElement>(null);

  const startRename = useCallback(() => {
    setEditValue(session.title || session.summary || session.label || "");
    setEditing(true);
    setCtxMenu(null);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [session]);

  const commitRename = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim();
    const current = session.title || session.summary || session.label || "";
    if (trimmed && trimmed !== current) {
      const api = (window as any).api;
      if (api) {
        api.invoke("store:renameSession", session.path, trimmed).catch(() => {});
      }
    }
  }, [editValue, session]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [ctxMenu]);

  return (
    <div
      ref={itemRef}
      onClick={() => !editing && onLoadSession(session.path)}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => onHover(session.path)}
      onMouseLeave={() => onHover(null)}
      style={{
        padding: "5px 10px",
        borderRadius: 4,
        cursor: "pointer",
        background: isActive ? theme.accentDim : isHovered ? theme.elevated : "transparent",
        transition: "all 120ms ease",
        position: "relative",
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
          style={{
            width: "100%",
            fontSize: 12,
            color: theme.text,
            fontWeight: 500,
            lineHeight: 1.3,
            background: theme.bg,
            border: `1px solid ${theme.accentBorder}`,
            borderRadius: 3,
            padding: "2px 6px",
            outline: "none",
            fontFamily: sans,
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            lineHeight: 1.3,
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: isActive ? theme.text : theme.secondary,
              fontWeight: isActive ? 500 : 400,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
              minWidth: 0,
            }}
          >
            {sessionDisplayName(session)}
          </span>
          {/* Live state indicator */}
          {liveState && liveState !== "idle" && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                backgroundColor: liveState === "asking" ? theme.success : theme.accent,
                flexShrink: 0,
                animation: (liveState === "thinking" || liveState === "cancelling" || liveState === "tool_calling")
                  ? "session-pulse 1.5s ease-in-out infinite"
                  : undefined,
              }}
              title={liveState}
            />
          )}
          {(session.lastActiveAt || session.created) && (
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                color: theme.muted,
                flexShrink: 0,
              }}
            >
              {relativeDate(session.lastActiveAt || session.created!)}
            </span>
          )}
        </div>
      )}
      {/* Context menu */}
      {ctxMenu && (
        <SessionContextMenu
          ref={ctxMenuRef}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onRename={() => startRename()}
          onExport={() => { setCtxMenu(null); /* placeholder */ }}
          onArchive={onArchiveSession ? () => { setCtxMenu(null); onArchiveSession(session.path); } : undefined}
          onDelete={onDeleteSession ? () => { setCtxMenu(null); onDeleteSession(session.path); } : undefined}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ---- Context menu for session items ----

const SessionContextMenu = React.forwardRef<
  HTMLDivElement,
  {
    x: number;
    y: number;
    onRename: () => void;
    onExport: () => void;
    onArchive?: () => void;
    onDelete?: () => void;
    onClose: () => void;
  }
>(function SessionContextMenu({ x, y, onRename, onExport, onArchive, onDelete, onClose }, ref) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [toastVisible, setToastVisible] = useState(false);

  const items = [
    { label: "Rename", action: onRename },
    { label: "Export", action: () => { setToastVisible(true); setTimeout(() => { setToastVisible(false); onClose(); }, 800); } },
    ...(onArchive ? [{ label: "Archive", action: onArchive }] : []),
    ...(onDelete ? [{ label: "Delete", action: onDelete, danger: true }] : []),
  ];

  // Find the sidebar root to constrain positioning
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Combine refs
  React.useImperativeHandle(ref, () => menuRef.current!, []);

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 200,
        backgroundColor: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 4,
        overflow: "hidden",
        minWidth: 120,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, idx) => (
        <div
          key={item.label}
          onClick={(e) => { e.stopPropagation(); item.action(); }}
          onMouseEnter={() => setHoveredIdx(idx)}
          onMouseLeave={() => setHoveredIdx(null)}
          style={{
            padding: "7px 14px",
            fontFamily: mono,
            fontSize: 11,
            color: (item as any).danger
              ? theme.error
              : hoveredIdx === idx
                ? theme.text
                : theme.secondary,
            cursor: "pointer",
            background: hoveredIdx === idx ? theme.elevated : "transparent",
            transition: "background 80ms ease, color 80ms ease",
          }}
        >
          {item.label}
        </div>
      ))}
      {toastVisible && (
        <div
          style={{
            padding: "7px 14px",
            fontFamily: mono,
            fontSize: 11,
            color: theme.muted,
            borderTop: `1px solid ${theme.border}`,
          }}
        >
          Coming soon
        </div>
      )}
    </div>
  );
});

// ---- Block-based context bar ----

const TOTAL_BLOCKS = 20;

function ContextBar(): React.ReactElement {
  const { tokenInfo } = useSession();
  const budget = tokenInfo.contextBudget || 200_000;
  const used = tokenInfo.totalTokens;
  const pct = Math.min(100, (used / budget) * 100);
  const filled = Math.round((pct / 100) * TOTAL_BLOCKS);
  const barColor = pct > 90 ? theme.error : pct > 70 ? theme.warning : theme.accent;
  const isEmpty = used === 0;

  return (
    <div style={{ padding: "12px 16px 16px", borderTop: `1px solid ${theme.border}` }}>
      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: isEmpty ? theme.muted : pct > 90 ? theme.error : theme.secondary,
          marginBottom: 8,
          display: "flex",
          justifyContent: "space-between",
          letterSpacing: "0.02em",
          transition: "color 300ms ease",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
            <rect x="2" y="3" width="12" height="10" rx="1" />
            <path d="M5 1v4M11 1v4" />
          </svg>
          {isEmpty ? "Context" : `Context ${Math.round(pct)}%`}
        </span>
        <span>{formatTokens(used)} / {formatTokens(budget)}</span>
      </div>
      <div style={{ display: "flex", gap: 2 }}>
        {Array.from({ length: TOTAL_BLOCKS }, (_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 5,
              borderRadius: 1,
              backgroundColor: i < filled ? barColor : isEmpty ? "rgba(255, 255, 255, 0.05)" : theme.border,
              transition: "background-color 300ms ease",
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ---- Session search ----

function SessionSearch({
  sessions,
  onLoadSession,
}: {
  sessions: SessionSummary[];
  onLoadSession: (path: string) => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const results = React.useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return sessions.filter(
      (s) =>
        (s.title || "").toLowerCase().includes(q) ||
        (s.summary || "").toLowerCase().includes(q) ||
        (s.label || "").toLowerCase().includes(q),
    ).slice(0, 6);
  }, [sessions, query]);

  const showResults = focused && query.trim().length > 0 && results.length > 0;

  return (
    <div style={{ padding: "6px 12px 2px", position: "relative" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 8px",
          borderRadius: 4,
          border: `1px solid ${focused ? theme.accentBorder : theme.border}`,
          backgroundColor: theme.bg,
          transition: "border-color 150ms ease",
        }}
      >
        <svg
          width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke={focused ? theme.accent : theme.muted} strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transition: "stroke 150ms ease" }}
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search sessions..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          style={{
            flex: 1,
            border: "none",
            background: "transparent",
            outline: "none",
            fontFamily: mono,
            fontSize: 11,
            color: theme.text,
            padding: 0,
          }}
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(""); inputRef.current?.focus(); }}
            style={{
              width: 14,
              height: 14,
              border: "none",
              background: "transparent",
              color: theme.muted,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
            }}
          >
            <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
      </div>

      {/* Search results dropdown */}
      {showResults && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 12,
            right: 12,
            background: theme.elevated,
            border: `1px solid ${theme.borderHover}`,
            borderRadius: 4,
            zIndex: 50,
            overflow: "hidden",
            marginTop: 2,
          }}
        >
          {results.map((s) => (
            <div
              key={s.path}
              onClick={() => { onLoadSession(s.path); setQuery(""); }}
              style={{
                padding: "8px 10px",
                cursor: "pointer",
                fontSize: 12,
                color: theme.text,
                borderBottom: `1px solid ${theme.border}`,
                transition: "background 80ms ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = theme.surface; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {sessionDisplayName(s)}
              </div>
              <div style={{ fontFamily: mono, fontSize: 10, color: theme.muted, marginTop: 2 }}>
                {s.created ? relativeDate(s.created) : ""}
                {s.turns != null && s.turns > 0 && ` · ${s.turns} turn${s.turns !== 1 ? "s" : ""}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}