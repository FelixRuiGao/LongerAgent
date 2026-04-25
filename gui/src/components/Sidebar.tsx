/**
 * Left rail: search bar + project tree + user footer.
 * Follows template: flat surface, project groups with collapse arrows,
 * session dots (spinner for working, accent for notify, gray for idle).
 */

import { useState } from 'react'
import { Plus, Search, ChevronDown, MoreHorizontal, X } from 'lucide-react'
import { useSessionStore } from '@/state/sessionStore.js'
import type { SessionTab } from '@shared/rpc.js'
import { cn } from '@/lib/cn.js'
import { api } from '@/lib/api.js'
import { projectName } from '@/lib/path.js'

export function Sidebar(): JSX.Element {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setActive = useSessionStore((s) => s.setActiveTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const createTab = useSessionStore((s) => s.createTab)
  const perTab = useSessionStore((s) => s.perTab)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')

  const activeTab = tabs.find((t) => t.tabId === activeTabId)
  const activeState = activeTab ? perTab[activeTab.tabId] : undefined
  const activeModelName = activeState?.meta?.modelConfigName || activeTab?.selectedModel || ''

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
    <aside
      className="flex w-[244px] shrink-0 flex-col bg-rail"
      style={{ boxShadow: 'inset -1px 0 0 var(--color-line-soft)' }}
    >
      {/* Search + new button */}
      <div className="flex gap-1.5 px-2.5 pb-2.5 pt-2">
        <div className="flex flex-1 items-center gap-1.5 rounded-[10px] border border-line-soft bg-pane-2 px-3 py-[7px]">
          <Search className="h-3 w-3 text-ink-4" strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions"
            className="flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4"
          />
          <span className="mono text-[10px] text-ink-4">⌘K</span>
        </div>
        <button
          onClick={onNewSession}
          disabled={creating}
          title="New session"
          className={cn(
            'grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[10px]',
            'border border-line-soft bg-pane-2 text-ink-2 transition',
            'hover:bg-line-soft hover:text-ink',
            creating && 'opacity-50',
          )}
        >
          <Plus className="h-[13px] w-[13px]" strokeWidth={2} />
        </button>
      </div>

      {/* Project tree */}
      <div className="flex-1 overflow-y-auto pt-1">
        {groups.length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-ink-3">
            No sessions yet. Click + to begin.
          </div>
        ) : (
          groups.map(([workDir, items]) => (
            <ProjectGroup
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
      </div>

      {/* User footer */}
      <div className="border-t border-line-soft px-3 py-3">
        <div className="flex items-center gap-2.5">
          <div
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px] text-[11px] font-semibold text-[#ececec]"
            style={{ background: 'linear-gradient(135deg, #2a2d34, #4a4e57)' }}
          >
            fg
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium leading-tight text-ink">
              Felix Gao
            </div>
            <div className="truncate text-[11px] leading-tight text-ink-3">
              {activeModelName || 'Pro'}
            </div>
          </div>
          <button className="text-ink-3 hover:text-ink">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  )
}

function ProjectGroup({
  workDir,
  items,
  activeTabId,
  perTab,
  onSelect,
  onClose,
}: {
  workDir: string
  items: SessionTab[]
  activeTabId: string | null
  perTab: ReturnType<typeof useSessionStore.getState>['perTab']
  onSelect: (id: string) => void
  onClose: (id: string) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const name = projectName(workDir)

  return (
    <div className="mb-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-3.5 py-[5px] text-ink-3"
      >
        <ChevronDown
          className={cn('h-3 w-3 opacity-80 transition-transform', !expanded && '-rotate-90')}
          strokeWidth={2}
        />
        <span className="flex-1 text-left text-[12px] font-semibold text-ink-2">
          {name}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col">
          {items.map((t) => {
            const active = t.tabId === activeTabId
            const state = perTab[t.tabId]
            const status = state?.status
            const isWorking = status?.currentTurnRunning ?? false
            const hasAsk = !!state?.pendingAsk

            return (
              <div
                key={t.tabId}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(t.tabId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onSelect(t.tabId)
                }}
                className={cn(
                  'group relative mx-2 my-px flex cursor-pointer items-center gap-2 rounded-[10px] py-2 pl-7 pr-2.5',
                  active ? 'bg-pane-2 text-ink' : 'text-ink-2 hover:bg-line-soft',
                )}
              >
                {/* Status dot */}
                <span className="absolute left-3 top-1/2 -translate-y-1/2">
                  {isWorking ? (
                    <span className="working-spinner" />
                  ) : hasAsk ? (
                    <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
                  ) : (
                    <span
                      className={cn(
                        'block h-1.5 w-1.5 rounded-full',
                        active ? 'bg-ink-3' : 'bg-ink-4',
                      )}
                    />
                  )}
                </span>

                <span
                  className={cn(
                    'flex-1 truncate text-[12.5px] leading-tight',
                    active ? 'font-medium' : 'font-normal',
                  )}
                >
                  {t.title || t.displayName || 'New session'}
                </span>

                <span className="shrink-0 text-[11px] tabular-nums text-ink-4 group-hover:hidden">
                  {timeAgo(t.createdAt)}
                </span>

                {/* Close button (replaces time on hover) */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void onClose(t.tabId)
                  }}
                  className={cn(
                    'invisible flex h-4 w-4 items-center justify-center rounded text-ink-3 transition',
                    'hover:bg-line hover:text-ink group-hover:visible',
                    active && 'visible',
                  )}
                  aria-label="Close"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function groupByWorkDir(tabs: readonly SessionTab[]): Array<[string, SessionTab[]]> {
  const map = new Map<string, SessionTab[]>()
  for (const t of tabs) {
    const arr = map.get(t.workDir) ?? []
    arr.push(t)
    map.set(t.workDir, arr)
  }
  return [...map.entries()].map(
    ([k, v]) => [k, [...v].sort((a, b) => b.createdAt - a.createdAt)] as [string, SessionTab[]],
  )
}
