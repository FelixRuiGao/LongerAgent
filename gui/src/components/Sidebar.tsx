import { useEffect, useState } from 'react'
import { Plus, FolderOpen, X } from 'lucide-react'
import { useSessionStore } from '@/state/sessionStore.js'
import type { SessionTab } from '@shared/rpc.js'
import { cn } from '@/lib/cn.js'
import { api } from '@/lib/api.js'

export function Sidebar(): JSX.Element {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setActive = useSessionStore((s) => s.setActiveTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const createTab = useSessionStore((s) => s.createTab)
  const perTab = useSessionStore((s) => s.perTab)
  const [creating, setCreating] = useState(false)

  // Group tabs by workDir for a project-list feel.
  const groups = groupByWorkDir(tabs)

  const onNewSession = async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    try {
      const dir = await api.workspace.pickDirectory()
      if (!dir) return
      await createTab(dir)
    } finally {
      setCreating(false)
    }
  }

  return (
    <aside className="hairline-r flex w-[260px] shrink-0 flex-col bg-bg/30 backdrop-blur-sm">
      <div className="flex h-12 items-center justify-between px-4">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-fg-3">
          Sessions
        </span>
        <button
          onClick={onNewSession}
          disabled={creating}
          className={cn(
            'ring-focus flex h-6 w-6 items-center justify-center rounded',
            'text-fg-3 transition hover:bg-bg-1 hover:text-fg',
            creating && 'opacity-50',
          )}
          aria-label="New session"
          title="New session"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {groups.length === 0 ? (
          <div className="px-3 pt-2 text-[12px] leading-relaxed text-muted">
            No sessions yet.
            <br />
            Click <span className="text-fg-3">+</span> to begin.
          </div>
        ) : (
          groups.map(([workDir, items]) => (
            <SessionGroup
              key={workDir}
              workDir={workDir}
              items={items}
              activeTabId={activeTabId}
              perTab={perTab}
              onSelect={setActive}
              onClose={closeTab}
            />
          ))
        )}
      </nav>
    </aside>
  )
}

function SessionGroup(props: {
  workDir: string
  items: SessionTab[]
  activeTabId: string | null
  perTab: ReturnType<typeof useSessionStore.getState>['perTab']
  onSelect: (id: string) => void
  onClose: (id: string) => void
}): JSX.Element {
  const { workDir, items, activeTabId, perTab, onSelect, onClose } = props
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">
        <FolderOpen className="h-3 w-3" />
        <span className="truncate">{deriveProjectName(workDir)}</span>
      </div>
      <ul className="space-y-0.5">
        {items.map((t) => {
          const active = t.tabId === activeTabId
          const state = perTab[t.tabId]
          const status = state?.status
          const ask = state?.pendingAsk
          return (
            <li key={t.tabId}>
              <button
                onClick={() => onSelect(t.tabId)}
                className={cn(
                  'group relative flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition',
                  active
                    ? 'bg-accent-soft text-fg'
                    : 'text-fg-2 hover:bg-bg-1 hover:text-fg',
                )}
              >
                <StatusDot
                  running={status?.currentTurnRunning ?? false}
                  hasAsk={!!ask}
                  active={active}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] leading-tight">
                    {t.title || t.displayName || 'Untitled session'}
                  </div>
                  <div className="mt-0.5 truncate text-[10.5px] text-fg-3">
                    {summarizeStatus(status, ask ?? null)}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void onClose(t.tabId)
                  }}
                  className={cn(
                    'invisible mt-0.5 flex h-4 w-4 items-center justify-center rounded text-fg-3 transition',
                    'hover:bg-bg-2 hover:text-fg group-hover:visible',
                    active && 'visible',
                  )}
                  aria-label="Close"
                >
                  <X className="h-3 w-3" />
                </button>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function StatusDot({
  running,
  hasAsk,
  active,
}: {
  running: boolean
  hasAsk: boolean
  active: boolean
}): JSX.Element {
  let cls = 'h-1.5 w-1.5 mt-1.5 rounded-full shrink-0'
  if (hasAsk) {
    cls += ' bg-warning'
  } else if (running) {
    cls += ' bg-accent pulse-soft'
  } else if (active) {
    cls += ' bg-fg-3'
  } else {
    cls += ' bg-border-strong'
  }
  return <span className={cls} aria-hidden />
}

function summarizeStatus(
  status: { currentTurnRunning: boolean; lastToolCallSummary: string; sessionPhase: string } | null | undefined,
  ask: { kind: string } | null,
): string {
  if (ask) return ask.kind === 'approval' ? 'Awaiting approval' : 'Awaiting answer'
  if (!status) return 'Idle'
  if (status.currentTurnRunning) {
    if (status.lastToolCallSummary) return status.lastToolCallSummary
    return capitalize(status.sessionPhase) || 'Working'
  }
  return 'Idle'
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function groupByWorkDir(tabs: readonly SessionTab[]): Array<[string, SessionTab[]]> {
  const map = new Map<string, SessionTab[]>()
  for (const t of tabs) {
    const arr = map.get(t.workDir) ?? []
    arr.push(t)
    map.set(t.workDir, arr)
  }
  // Sort each group by createdAt desc
  return [...map.entries()].map(
    ([k, v]) =>
      [k, [...v].sort((a, b) => b.createdAt - a.createdAt)] as [string, SessionTab[]],
  )
}

function deriveProjectName(workDir: string): string {
  const segs = workDir.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? workDir
}
