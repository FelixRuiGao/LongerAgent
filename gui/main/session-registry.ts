/**
 * SessionRegistry — manages multiple concurrent Session instances.
 *
 * Each ManagedSession holds an independent Session + SessionStore + state.
 * Shared resources (Config, agents, skills, MCP, prompts) are loaded once
 * at startup and reused across sessions.
 */

import { type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";

import { Config } from "../../src/config.js";
import { Agent } from "../../src/agents/agent.js";
import { Session } from "../../src/session.js";
import { SessionStore, loadLog, validateAndRepairLog, saveLog } from "../../src/persistence.js";
import { ProgressReporter } from "../../src/progress.js";
import { projectToTuiEntries } from "../../src/log-projection.js";
import { resolveModelSelection } from "../../src/commands.js";
import type { PersistedModelSelection } from "../../src/model-selection.js";
import type { SessionState, TokenInfo, ConversationEntry } from "../shared/ipc-protocol.js";
import type { PendingAskUi } from "../../src/ask.js";
import type { SkillMeta } from "../../src/skills/loader.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface ManagedSession {
  id: string;
  projectPath: string;
  session: Session;
  store: SessionStore;
  state: SessionState;
  abortController: AbortController | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  logUnsubscribe: (() => void) | null;
  /** Throttle state for log updates (mirrors TUI's 200ms throttle) */
  logThrottleLastCall: number;
  logThrottleTimer: ReturnType<typeof setTimeout> | null;
}

export interface ActiveSessionInfo {
  sessionId: string;
  projectPath: string;
  sessionPath: string | undefined;
  state: SessionState;
  title: string;
  currentModel: string;
}

export interface SharedResources {
  config: Config;
  agents: Record<string, Agent>;
  skills: Map<string, SkillMeta>;
  skillRoots: string[];
  mcpManager: unknown;
  promptsDirs: string[];
  globalPreferences: any;
}

// ------------------------------------------------------------------
// Registry
// ------------------------------------------------------------------

export class SessionRegistry {
  private _sessions = new Map<string, ManagedSession>();
  private _foregroundId: string | null = null;
  private _win: BrowserWindow;
  private _shared: SharedResources;
  private _primaryAgentName: string;

  constructor(win: BrowserWindow, shared: SharedResources, primaryAgentName: string) {
    this._win = win;
    this._shared = shared;
    this._primaryAgentName = primaryAgentName;
  }

  // ---- Accessors ----

  get foregroundId(): string | null { return this._foregroundId; }
  get shared(): SharedResources { return this._shared; }

  get(id: string): ManagedSession | undefined {
    return this._sessions.get(id);
  }

  getForeground(): ManagedSession | undefined {
    return this._foregroundId ? this._sessions.get(this._foregroundId) : undefined;
  }

  findBySessionDir(dir: string): ManagedSession | undefined {
    for (const m of this._sessions.values()) {
      if (m.store.sessionDir === dir) return m;
    }
    return undefined;
  }

  listActive(): ActiveSessionInfo[] {
    return Array.from(this._sessions.values()).map((m) => ({
      sessionId: m.id,
      projectPath: m.projectPath,
      sessionPath: m.store.sessionDir ?? undefined,
      state: m.state,
      title: m.session.getDisplayName?.() ?? "",
      currentModel: m.session.currentModelConfigName ?? "",
    }));
  }

  // ---- Lifecycle ----

  create(projectPath: string): ManagedSession {
    const id = randomUUID();

    // Clone the primary agent so each session has independent modelConfig
    const templateAgent = this._shared.agents[this._primaryAgentName]
      ?? Object.values(this._shared.agents)[0];
    if (!templateAgent) throw new Error("No agent templates found");
    const clonedAgent = templateAgent.clone();

    // Per-session store
    const sessionStore = new SessionStore({ projectPath });

    // Per-session progress reporter
    const progress = new ProgressReporter({
      callback: (event) => {
        if (!this._win.isDestroyed()) {
          this._win.webContents.send("progress:event", { sessionId: id, ...event });
        }
      },
      level: "normal",
    });

    // Create session
    const contextRatio = this._shared.globalPreferences.contextRatio ?? 1.0;
    const session = new Session({
      primaryAgent: clonedAgent as never,
      config: this._shared.config,
      agentTemplates: this._shared.agents as never,
      skills: this._shared.skills as never,
      skillRoots: this._shared.skillRoots,
      progress,
      mcpManager: this._shared.mcpManager as never,
      promptsDirs: this._shared.promptsDirs,
      store: sessionStore as never,
      contextRatio,
      projectRoot: projectPath,
    });

    // Apply global preferences (thinking level, accent, etc.)
    (session as any).applyGlobalPreferences?.(this._shared.globalPreferences);

    // Restore model selection from global preferences
    this._restoreModelSelection(session);

    const managed: ManagedSession = {
      id,
      projectPath,
      session,
      store: sessionStore,
      state: "idle",
      abortController: null,
      saveTimer: null,
      logUnsubscribe: null,
      logThrottleLastCall: 0,
      logThrottleTimer: null,
    };

    // Subscribe to log changes
    managed.logUnsubscribe = session.subscribeLog!(() => {
      this._onLogChanged(managed);
    });

    // Auto-save callback
    session.onSaveRequest = () => {
      this._autoSave(managed);
    };

    this._sessions.set(id, managed);

    // Notify renderer
    if (!this._win.isDestroyed()) {
      this._win.webContents.send("session:created", {
        sessionId: id,
        projectPath,
      });
    }

    return managed;
  }

  async destroy(id: string): Promise<void> {
    const managed = this._sessions.get(id);
    if (!managed) return;

    // Auto-save if needed
    this._autoSave(managed);

    // Clear timers
    if (managed.saveTimer) clearTimeout(managed.saveTimer);
    if (managed.logThrottleTimer) clearTimeout(managed.logThrottleTimer);

    // Unsubscribe log listener
    managed.logUnsubscribe?.();

    // Close session (kills sub-agents, shells)
    await managed.session.close();

    // Remove from map
    this._sessions.delete(id);

    if (this._foregroundId === id) {
      this._foregroundId = null;
    }

    // Notify renderer
    if (!this._win.isDestroyed()) {
      this._win.webContents.send("session:destroyed", { sessionId: id });
    }
  }

  setForeground(id: string): void {
    const managed = this._sessions.get(id);
    if (!managed) throw new Error(`Session ${id} not found`);

    this._foregroundId = id;

    // Push full state to renderer
    if (!this._win.isDestroyed()) {
      this._win.webContents.send("session:foregroundChanged", { sessionId: id, projectPath: managed.projectPath });

      // Push state
      this._win.webContents.send("session:stateChanged", {
        sessionId: id,
        state: managed.state,
      });

      // Push log
      this._sendLogUpdate(managed);

      // Push tokens
      this._sendTokenUpdate(managed);

      // Push model
      this._win.webContents.send("session:modelChanged", {
        sessionId: id,
        model: managed.session.currentModelConfigName ?? "",
      });

      // Push ask
      const ask = managed.session.getPendingAsk?.() ?? null;
      this._win.webContents.send("ask:pending", {
        sessionId: id,
        ask,
      });
    }
  }

  /**
   * Load a persisted session from disk into a new ManagedSession.
   * If a live session already exists for that path, returns it instead.
   */
  loadFromDisk(sessionPath: string, projectPath: string): ManagedSession {
    // Check if already alive
    const existing = this.findBySessionDir(sessionPath);
    if (existing) return existing;

    // Create new managed session
    const managed = this.create(projectPath);

    // Load log data
    const logData = loadLog(sessionPath);
    const { entries, repaired, warnings } = validateAndRepairLog(logData.entries);
    if (repaired) {
      for (const w of warnings) console.warn("[repair]", w);
    }

    // Restore
    (managed.session as any).restoreFromLog(
      logData.meta,
      entries,
      logData.idAllocator,
    );

    // Point store at the session dir
    managed.store.sessionDir = sessionPath;
    managed.session.setStore?.(managed.store as any);

    // Cancel the auto-save timer that restoreFromLog triggers
    if (managed.saveTimer) {
      clearTimeout(managed.saveTimer);
      managed.saveTimer = null;
    }

    return managed;
  }

  /** Close all sessions on app quit. */
  async closeAll(): Promise<void> {
    const ids = Array.from(this._sessions.keys());
    for (const id of ids) {
      await this.destroy(id);
    }
  }

  // ---- State management ----

  setState(managed: ManagedSession, state: SessionState): void {
    managed.state = state;
    if (!this._win.isDestroyed()) {
      this._win.webContents.send("session:stateChanged", {
        sessionId: managed.id,
        state,
      });
    }
  }

  // ---- Internal helpers ----

  private _onLogChanged(managed: ManagedSession): void {
    // Only push heavy data (log entries, tokens) for the foreground session.
    // Throttled to 200ms min interval (same as TUI) to avoid flooding IPC.
    if (managed.id === this._foregroundId) {
      const now = Date.now();
      const elapsed = now - managed.logThrottleLastCall;
      if (elapsed >= 200) {
        managed.logThrottleLastCall = now;
        this._sendLogUpdate(managed);
        this._sendTokenUpdate(managed);
      } else if (!managed.logThrottleTimer) {
        managed.logThrottleTimer = setTimeout(() => {
          managed.logThrottleTimer = null;
          managed.logThrottleLastCall = Date.now();
          this._sendLogUpdate(managed);
          this._sendTokenUpdate(managed);
        }, 200 - elapsed);
      }
    }

    // Check for ask state changes (deferred to avoid race with _activeAsk)
    queueMicrotask(() => {
      const ask = managed.session.getPendingAsk?.();
      if (ask && managed.state !== "asking") {
        if (managed.id === this._foregroundId && !this._win.isDestroyed()) {
          this._win.webContents.send("ask:pending", { sessionId: managed.id, ask });
        }
        this.setState(managed, "asking");
      } else if (!ask && managed.state === "asking") {
        if (managed.id === this._foregroundId && !this._win.isDestroyed()) {
          this._win.webContents.send("ask:pending", { sessionId: managed.id, ask: null });
        }
      }
    });

    // Debounced auto-save
    this._debouncedAutoSave(managed);
  }

  private _sendLogUpdate(managed: ManagedSession): void {
    if (this._win.isDestroyed()) return;
    const log = (managed.session as any).log ?? (managed.session as any)._log;
    if (!log) return;
    const entries: ConversationEntry[] = projectToTuiEntries(log as any);
    this._win.webContents.send("log:updated", { sessionId: managed.id, entries });
  }

  private _sendTokenUpdate(managed: ManagedSession): void {
    if (this._win.isDestroyed()) return;
    const mc = (managed.session as any).primaryAgent?.modelConfig;
    const contextRatio: number = (managed.session as any)._contextRatio ?? 1.0;
    const contextBudget = mc?.contextLength
      ? Math.round(mc.contextLength * contextRatio)
      : undefined;
    const info: TokenInfo = {
      inputTokens: managed.session.lastInputTokens,
      totalTokens: managed.session.lastTotalTokens,
      cacheReadTokens: (managed.session as any).lastCacheReadTokens ?? 0,
      contextBudget,
    };
    this._win.webContents.send("token:update", { sessionId: managed.id, ...info });
  }

  sendLogUpdate(managed: ManagedSession): void { this._sendLogUpdate(managed); }
  sendTokenUpdate(managed: ManagedSession): void { this._sendTokenUpdate(managed); }

  private _autoSave(managed: ManagedSession): void {
    try {
      const logData = (managed.session as any).getLogForPersistence?.();
      if (!logData) return;
      if ((logData.meta.turnCount ?? 0) === 0) return;

      if (!managed.store.sessionDir) {
        managed.store.createSession();
      }
      const dir = managed.store.sessionDir;
      if (!dir) return;

      saveLog(dir, logData.meta, [...logData.entries]);
    } catch (err) {
      console.error(`[SessionRegistry] Auto-save failed for ${managed.id}:`, err);
    }
  }

  private _debouncedAutoSave(managed: ManagedSession): void {
    if (managed.saveTimer) clearTimeout(managed.saveTimer);
    managed.saveTimer = setTimeout(() => {
      this._autoSave(managed);
      if (!this._win.isDestroyed()) {
        this._win.webContents.send("sidebar:refresh");
      }
    }, 400);
  }

  private _restoreModelSelection(session: Session): void {
    const gp = this._shared.globalPreferences;
    try {
      if (gp.modelConfigName) {
        try {
          session.switchModel!(gp.modelConfigName);
          (session as any).setPersistedModelSelection?.({
            modelConfigName: gp.modelConfigName,
            modelProvider: gp.modelProvider,
            modelSelectionKey: gp.modelSelectionKey,
            modelId: gp.modelId,
          } satisfies PersistedModelSelection);
        } catch {
          if (gp.modelProvider && (gp.modelSelectionKey || gp.modelId)) {
            const restored = resolveModelSelection(
              session,
              `${gp.modelProvider}:${gp.modelSelectionKey ?? gp.modelId}`,
            );
            session.switchModel!(restored.selectedConfigName);
            (session as any).setPersistedModelSelection?.({
              modelConfigName: restored.selectedConfigName,
              modelProvider: restored.modelProvider,
              modelSelectionKey: restored.modelSelectionKey,
              modelId: restored.modelId,
            } satisfies PersistedModelSelection);
          }
        }
      } else if (gp.modelProvider && (gp.modelSelectionKey || gp.modelId)) {
        const restored = resolveModelSelection(
          session,
          `${gp.modelProvider}:${gp.modelSelectionKey ?? gp.modelId}`,
        );
        session.switchModel!(restored.selectedConfigName);
        (session as any).setPersistedModelSelection?.({
          modelConfigName: restored.selectedConfigName,
          modelProvider: restored.modelProvider,
          modelSelectionKey: restored.modelSelectionKey,
          modelId: restored.modelId,
        } satisfies PersistedModelSelection);
      }
    } catch (err) {
      console.warn("Failed to restore model:", err instanceof Error ? err.message : String(err));
    }
  }

  /** Cancel pending auto-save for a specific session (used after restoreFromLog). */
  cancelPendingAutoSave(managed: ManagedSession): void {
    if (managed.saveTimer) {
      clearTimeout(managed.saveTimer);
      managed.saveTimer = null;
    }
  }
}
