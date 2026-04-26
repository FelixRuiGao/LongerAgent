/**
 * Right rail: tabbed Plan / Agents / Git.
 * Matches template: tab bar at top, rich content per tab.
 */

import { useEffect, useState } from 'react'
import {
  Check,
  Layers,
  GitBranch,
  ChevronsRight,
  ChevronsLeft,
  Plus,
} from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { api } from '@/lib/api.js'
import { useSessionStore } from '@/state/sessionStore.js'
import { shortenSummary } from '@/lib/path.js'
import type { SessionTab } from '@shared/rpc.js'

interface PlanCheckpoint {
  text: string
  status?: string
  state?: string
  done?: boolean
}

interface ChildSnapshot {
  id: string
  numericId: number
  template: string
  lifecycle: string
  phase: string
  outcome: string
  lastTotalTokens: number
  lifetimeToolCallCount: number
  lastToolCallSummary: string
}

export function RightPane({ tab }: { tab: SessionTab }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [activeTab, setActiveTab] = useState<'plan' | 'agents' | 'git'>('plan')
  const [plan, setPlan] = useState<PlanCheckpoint[]>([])
  const [children, setChildren] = useState<ChildSnapshot[]>([])
  const state = useSessionStore((s) => s.perTab[tab.tabId])

  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const [p, c] = await Promise.all([
          api.rpc.request<PlanCheckpoint[] | null>(tab.tabId, 'session.getPlanState'),
          api.rpc.request<ChildSnapshot[]>(tab.tabId, 'session.getChildSnapshots'),
        ])
        if (cancelled) return
        setPlan(Array.isArray(p) ? p : [])
        setChildren(Array.isArray(c) ? c : [])
      } catch { /* */ }
    }
    void refresh()
    const off = api.rpc.onEvent((e) => {
      if (e.tabId !== tab.tabId) return
      if (e.method === 'plan.changed' || e.method === 'log.changed') void refresh()
    })
    return () => { cancelled = true; off() }
  }, [tab.tabId])

  if (collapsed) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center border-l border-line-soft bg-rail py-3">
        <button
          onClick={() => setCollapsed(false)}
          className="grid h-6 w-6 place-items-center rounded text-ink-3 transition hover:bg-line-soft hover:text-ink"
          title="Expand"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
      </aside>
    )
  }

  const planRemaining = plan.filter((c) => normalizeStatus(c) !== 'done').length
  const agentsActive = children.filter((c) => c.lifecycle === 'running').length
  const recentTools = getRecentTools(state)

  const tabs = [
    { id: 'plan' as const, label: 'Plan', icon: <Check className="h-[11px] w-[11px]" strokeWidth={2} />, badge: planRemaining },
    { id: 'agents' as const, label: 'Agents', icon: <Layers className="h-[11px] w-[11px]" strokeWidth={1.8} />, badge: agentsActive },
    { id: 'git' as const, label: 'Git', icon: <GitBranch className="h-[11px] w-[11px]" strokeWidth={1.8} />, badge: recentTools.length },
  ]

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-l border-line-soft bg-rail">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-line-soft px-2.5 py-2">
        {tabs.map((t) => {
          const on = t.id === activeTab
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                'inline-flex items-center gap-[5px] rounded-[9px] px-3 py-1.5 text-[14px] font-medium transition',
                on ? 'bg-pane-2 text-ink' : 'text-ink-3 hover:text-ink',
              )}
            >
              {t.icon}
              {t.label}
              {t.badge > 0 && (
                <span className={cn('mono rounded-full px-[5px] py-px text-[11.5px] text-ink-3', on && 'bg-line')}>
                  {t.badge}
                </span>
              )}
            </button>
          )
        })}
        <div className="flex-1" />
        <button
          onClick={() => setCollapsed(true)}
          className="grid h-6 w-6 place-items-center self-center rounded text-ink-3 transition hover:bg-line-soft hover:text-ink"
          title="Collapse"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'plan' && <PlanPanel plan={plan} />}
        {activeTab === 'agents' && <AgentsPanel agents={children} workDir={tab.workDir} />}
        {activeTab === 'git' && <GitPanel recentTools={recentTools} />}
      </div>
    </aside>
  )
}

/* ── Plan ── */

function PlanPanel({ plan }: { plan: PlanCheckpoint[] }): JSX.Element {
  if (plan.length === 0) {
    return (
      <div className="px-3.5 py-4">
        <div className="text-[15px] font-semibold uppercase tracking-wider text-ink-3">Goal</div>
        <div className="mt-1.5 text-[14.5px] leading-[1.55] text-ink-3">
          No plan yet — write to plan.md to track progress.
        </div>
      </div>
    )
  }

  return (
    <div className="px-3.5 py-4">
      <div className="text-[15px] font-semibold uppercase tracking-wider text-ink-3">Checkpoints</div>
      <div className="mt-2 flex flex-col gap-0.5">
        {plan.map((c, i) => {
          const status = normalizeStatus(c)
          return (
            <div key={i} className="flex items-start gap-2.5 py-1.5">
              <div className="pt-0.5 shrink-0">
                {status === 'done' ? (
                  <div className="grid h-3.5 w-3.5 place-items-center rounded-full bg-ink">
                    <Check className="h-[9px] w-[9px] text-pane" strokeWidth={3} />
                  </div>
                ) : status === 'in_progress' ? (
                  <div className="relative h-3.5 w-3.5 rounded-full border-[1.5px] border-ink-2">
                    <div className="absolute inset-[3px] rounded-full bg-ink-2" />
                  </div>
                ) : (
                  <div className="h-3.5 w-3.5 rounded-full border-[1.5px] border-ink-4" />
                )}
              </div>
              <div
                className={cn(
                  'flex-1 text-[14.5px] leading-[1.5]',
                  status === 'done' && 'text-ink-3 line-through decoration-ink-4',
                  status === 'todo' && 'text-ink-3',
                  status === 'in_progress' && 'text-ink',
                )}
              >
                {c.text}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Agents ── */

function AgentsPanel({ agents, workDir }: { agents: ChildSnapshot[]; workDir: string }): JSX.Element {
  if (agents.length === 0) {
    return <div className="px-3.5 py-4 text-[14px] text-ink-3">No sub-agents in this session.</div>
  }
  return (
    <div className="space-y-2 px-3 py-3">
      {agents.map((a) => {
        const statusColor =
          a.lifecycle === 'running' ? 'var(--color-ink-2)' :
          a.outcome === 'completed' ? 'var(--color-success)' :
          'var(--color-ink-4)'
        return (
          <div key={a.id} className="rounded-xl border border-line-soft bg-pane-2 px-3.5 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="mono rounded-md bg-line-soft px-[7px] py-0.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-2">
                {a.template}
              </span>
              <span className="mono flex-1 text-[16px] text-ink">#{a.numericId}</span>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor }} />
            </div>
            {a.lastToolCallSummary && (
              <div className="truncate text-[16px] text-ink-2 leading-[1.45]">
                {shortenSummary(a.lastToolCallSummary, workDir)}
              </div>
            )}
            <div className="mt-1.5 flex justify-between text-[15px]">
              <span className="text-ink-3">{a.lifecycle}</span>
              <span className="mono text-ink-3">
                {a.lifetimeToolCallCount} tools · {formatTokens(a.lastTotalTokens)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── Git (recent file changes) ── */

function GitPanel({ recentTools }: { recentTools: Array<{ toolName: string; text: string }> }): JSX.Element {
  if (recentTools.length === 0) {
    return <div className="px-3.5 py-4 text-[16px] text-ink-3">No file changes yet.</div>
  }
  return (
    <div className="px-3 py-3">
      <div className="text-[15px] font-semibold uppercase tracking-wider text-ink-3 mb-2 px-0.5">Recent activity</div>
      <div className="flex flex-col gap-px">
        {recentTools.map((r, i) => (
          <div key={i} className="flex items-center gap-2 rounded-[10px] px-2.5 py-2 hover:bg-pane-2">
            <span className="mono grid h-4 w-4 shrink-0 place-items-center rounded-[5px] bg-line-soft text-[15.5px] font-semibold text-ink-2">
              {r.toolName === 'write_file' || r.toolName === 'edit_file' ? 'M' : '›'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="mono truncate text-[16px] text-ink">{r.text}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Helpers ── */

function normalizeStatus(cp: PlanCheckpoint): 'todo' | 'in_progress' | 'done' {
  if (cp.status === 'done' || cp.state === 'done' || cp.done === true) return 'done'
  if (cp.status === 'in_progress' || cp.state === 'in_progress') return 'in_progress'
  return 'todo'
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function getRecentTools(state: ReturnType<typeof useSessionStore.getState>['perTab'][string] | undefined) {
  if (!state?.logEntries) return []
  const log = state.logEntries as Array<{ type: string; display?: string; meta?: Record<string, unknown> }>
  return log
    .filter((e) => e.type === 'tool_call')
    .slice(-8)
    .reverse()
    .map((e) => ({
      toolName: typeof e.meta?.['toolName'] === 'string' ? (e.meta?.['toolName'] as string) : 'tool',
      text: e.display ?? '',
    }))
}
