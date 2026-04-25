/**
 * Renderer state store.
 *
 * Holds:
 *   - tabs: list of all sessions
 *   - activeTabId: currently focused tab
 *   - perTab: map of tabId → { log, status, meta, models, ... }
 *
 * Subscribes to `rpc:event` once on init and routes events into the right tab.
 */

import { create } from 'zustand'
import { api } from '@/lib/api.js'
import type {
  ModelDescriptor,
  RpcEvent,
  SessionMeta,
  SessionStatus,
  SessionTab,
} from '@shared/rpc.js'

export interface TabState {
  readonly meta: SessionMeta | null
  readonly status: SessionStatus | null
  readonly logEntries: unknown[]
  readonly logRevision: number
  readonly activeLogEntryId: string | null
  readonly pendingAsk: { id: string; kind: string; summary: string } | null
  readonly models: readonly ModelDescriptor[]
  readonly stderrLog: string[]
}

interface SessionStoreState {
  readonly tabs: readonly SessionTab[]
  readonly activeTabId: string | null
  readonly perTab: Record<string, TabState>
  readonly theme: 'dark' | 'light'
  readonly initialized: boolean

  init(): Promise<void>
  setTheme(theme: 'dark' | 'light'): void
  createTab(workDir: string): Promise<SessionTab | null>
  closeTab(tabId: string): Promise<void>
  setActiveTab(tabId: string | null): void
  refreshMeta(tabId: string): Promise<void>
  refreshLog(tabId: string): Promise<void>
  refreshStatus(tabId: string): Promise<void>
  refreshModels(tabId: string): Promise<void>
  submitTurn(tabId: string, input: string): Promise<void>
  selectModel(tabId: string, modelName: string): Promise<void>
}

const emptyTabState: TabState = {
  meta: null,
  status: null,
  logEntries: [],
  logRevision: -1,
  activeLogEntryId: null,
  pendingAsk: null,
  models: [],
  stderrLog: [],
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  perTab: {},
  theme: 'dark',
  initialized: false,

  async init() {
    if (get().initialized) return
    set({ initialized: true })

    // System theme
    try {
      const stored = localStorage.getItem('fermi:theme') as 'dark' | 'light' | null
      const theme = stored ?? (await api.theme.getSystem())
      set({ theme })
      document.documentElement.classList.toggle('dark', theme === 'dark')
      document.documentElement.dataset.theme = theme
    } catch {
      // ignore
    }

    api.theme.onSystemChanged((theme) => {
      // Only follow system if user hasn't pinned a theme.
      if (!localStorage.getItem('fermi:theme')) {
        get().setTheme(theme)
      }
    })

    api.rpc.onEvent((e) => {
      handleEvent(e)
    })

    // Restore existing tabs (after a renderer reload, the main process still
    // has live subprocesses we should re-attach to).
    const tabs = await api.tabs.list()
    const perTab = { ...get().perTab }
    for (const t of tabs) {
      perTab[t.tabId] = { ...emptyTabState }
    }
    set({
      tabs,
      perTab,
      activeTabId: get().activeTabId ?? tabs[0]?.tabId ?? null,
    })
    for (const t of tabs) {
      void get().refreshMeta(t.tabId)
      void get().refreshLog(t.tabId)
      void get().refreshStatus(t.tabId)
      void get().refreshModels(t.tabId)
    }
  },

  setTheme(theme) {
    set({ theme })
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('fermi:theme', theme)
    } catch {
      // ignore
    }
  },

  async createTab(workDir) {
    try {
      const tab = await api.tabs.create({ workDir })
      const tabs = [...get().tabs.filter((t) => t.tabId !== tab.tabId), tab]
      set({
        tabs,
        activeTabId: tab.tabId,
        perTab: {
          ...get().perTab,
          [tab.tabId]: { ...emptyTabState },
        },
      })
      // Eager-load meta / log / models
      void get().refreshMeta(tab.tabId)
      void get().refreshLog(tab.tabId)
      void get().refreshModels(tab.tabId)
      return tab
    } catch (err) {
      console.error('createTab failed', err)
      return null
    }
  },

  async closeTab(tabId) {
    try {
      await api.tabs.close(tabId)
    } catch (err) {
      console.error('closeTab failed', err)
    }
    const tabs = get().tabs.filter((t) => t.tabId !== tabId)
    const perTab = { ...get().perTab }
    delete perTab[tabId]
    let activeTabId = get().activeTabId
    if (activeTabId === tabId) {
      activeTabId = tabs[0]?.tabId ?? null
    }
    set({ tabs, perTab, activeTabId })
  },

  setActiveTab(tabId) {
    set({ activeTabId: tabId })
  },

  async refreshMeta(tabId) {
    try {
      const meta = await api.rpc.request<SessionMeta>(tabId, 'session.getMeta')
      patchTabState(set, get, tabId, () => ({ meta }))
    } catch {
      // ignore
    }
  },

  async refreshLog(tabId) {
    try {
      const result = await api.rpc.request<{
        revision: number
        entries: unknown[]
        activeLogEntryId: string | null
      }>(tabId, 'session.getLogSnapshot', {})
      patchTabState(set, get, tabId, () => ({
        logEntries: result.entries,
        logRevision: result.revision,
        activeLogEntryId: result.activeLogEntryId,
      }))
    } catch {
      // ignore
    }
  },

  async refreshStatus(tabId) {
    try {
      const status = await api.rpc.request<SessionStatus>(tabId, 'session.getStatus')
      patchTabState(set, get, tabId, () => ({ status }))
    } catch {
      // ignore
    }
  },

  async refreshModels(tabId) {
    try {
      const models = await api.rpc.request<readonly ModelDescriptor[]>(
        tabId,
        'session.listAvailableModels',
      )
      patchTabState(set, get, tabId, () => ({ models }))
    } catch {
      // ignore
    }
  },

  async submitTurn(tabId, input) {
    if (!input.trim()) return
    try {
      await api.rpc.request(tabId, 'session.submitTurn', { input })
    } catch (err) {
      console.error('submitTurn failed', err)
    }
  },

  async selectModel(tabId, modelName) {
    try {
      await api.rpc.request(tabId, 'session.selectModel', { name: modelName })
      void get().refreshMeta(tabId)
    } catch (err) {
      console.error('selectModel failed', err)
    }
  },
}))

function patchTabState(
  set: (s: Partial<SessionStoreState>) => void,
  get: () => SessionStoreState,
  tabId: string,
  patch: (prev: TabState) => Partial<TabState>,
): void {
  const prev = get().perTab[tabId] ?? emptyTabState
  const next: TabState = { ...prev, ...patch(prev) }
  set({ perTab: { ...get().perTab, [tabId]: next } })
}

function handleEvent(e: RpcEvent): void {
  const { tabId, method, params } = e
  const store = useSessionStore.getState()

  switch (method) {
    case 'ready': {
      // Tab subprocess fully booted — populate meta and log.
      void store.refreshMeta(tabId)
      void store.refreshLog(tabId)
      void store.refreshStatus(tabId)
      void store.refreshModels(tabId)
      break
    }
    case 'log.changed': {
      // A turn made progress. Pull the latest log + status.
      const status = (params as { status?: SessionStatus })?.status
      void store.refreshLog(tabId)
      if (status) {
        patchTabState(
          (s) => useSessionStore.setState(s),
          () => useSessionStore.getState(),
          tabId,
          () => ({ status }),
        )
      } else {
        void store.refreshStatus(tabId)
      }
      break
    }
    case 'turn.started': {
      void store.refreshStatus(tabId)
      break
    }
    case 'turn.ended': {
      void store.refreshStatus(tabId)
      void store.refreshLog(tabId)
      break
    }
    case 'ask.pending': {
      const ask = params as { id: string; kind: string; summary: string }
      patchTabState(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
        () => ({ pendingAsk: ask }),
      )
      break
    }
    case 'ask.resolved': {
      patchTabState(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
        () => ({ pendingAsk: null }),
      )
      break
    }
    case 'plan.changed': {
      // Plan state updates — the renderer can pull on demand
      break
    }
    case 'model.changed': {
      void store.refreshMeta(tabId)
      break
    }
    case 'server.stderr': {
      const text = (params as { text: string })?.text ?? ''
      patchTabState(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
        (prev) => ({ stderrLog: [...prev.stderrLog, text].slice(-100) }),
      )
      break
    }
    case 'tab.closed': {
      const tabs = useSessionStore.getState().tabs.filter((t) => t.tabId !== tabId)
      const perTab = { ...useSessionStore.getState().perTab }
      delete perTab[tabId]
      let activeTabId = useSessionStore.getState().activeTabId
      if (activeTabId === tabId) activeTabId = tabs[0]?.tabId ?? null
      useSessionStore.setState({ tabs, perTab, activeTabId })
      break
    }
    case 'tab.error': {
      // surface errors via stderrLog
      const text = `[error] ${(params as { message: string })?.message ?? 'unknown'}\n`
      patchTabState(
        (s) => useSessionStore.setState(s),
        () => useSessionStore.getState(),
        tabId,
        (prev) => ({ stderrLog: [...prev.stderrLog, text].slice(-100) }),
      )
      break
    }
  }
}
