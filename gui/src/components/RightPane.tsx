/**
 * Right pane: session details + plan checkpoints + child sessions +
 * recent activity. Collapsible (on narrow windows it can hide).
 */

import { useEffect, useState } from 'react'
import {
  Map as MapIcon,
  Workflow,
  Activity,
  CheckCircle2,
  Circle,
  CircleDot,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { api } from '@/lib/api.js'
import { useSessionStore } from '@/state/sessionStore.js'
import type { SessionTab } from '@shared/rpc.js'

interface PlanCheckpoint {
  id?: string
  text: string
  status?: 'todo' | 'in_progress' | 'done'
  // Some logs may use these alternate keys
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
  recentEvents: string[]
}

export function RightPane({ tab }: { tab: SessionTab }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
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
      } catch {
        // ignore
      }
    }
    void refresh()
    const off = api.rpc.onEvent((e) => {
      if (e.tabId !== tab.tabId) return
      if (e.method === 'plan.changed' || e.method === 'log.changed') {
        void refresh()
      }
    })
    return () => {
      cancelled = true
      off()
    }
  }, [tab.tabId])

  if (collapsed) {
    return (
      <aside className="hairline-l flex w-9 shrink-0 flex-col items-center bg-bg/30 py-3 backdrop-blur-sm">
        <button
          onClick={() => setCollapsed(false)}
          className="ring-focus flex h-6 w-6 items-center justify-center rounded text-fg-3 transition hover:bg-bg-1 hover:text-fg"
          aria-label="Expand details"
          title="Expand details"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
      </aside>
    )
  }

  // Build "recent activity" from log entries
  const recent = (() => {
    const log = state?.logEntries as Array<{ type: string; display?: string; meta?: Record<string, unknown> }> | undefined
    if (!log) return []
    const items = log
      .filter((e) => e.type === 'tool_call' || e.type === 'sub_agent_start' || e.type === 'sub_agent_end')
      .slice(-6)
      .reverse()
    return items.map((e, i) => ({
      key: `${i}-${e.display ?? ''}`,
      type: e.type,
      text: e.display ?? '',
      toolName: typeof e.meta?.['toolName'] === 'string' ? (e.meta?.['toolName'] as string) : null,
    }))
  })()

  return (
    <aside className="hairline-l flex w-[280px] shrink-0 flex-col bg-bg/30 backdrop-blur-sm">
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-fg-3">
          Details
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="ring-focus flex h-6 w-6 items-center justify-center rounded text-fg-3 transition hover:bg-bg-1 hover:text-fg"
          aria-label="Collapse details"
          title="Collapse"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <Section
          icon={MapIcon}
          title="Plan"
          count={plan.length || undefined}
          empty="No plan yet — write to plan.md to track progress."
          isEmpty={plan.length === 0}
        >
          <ul className="space-y-1">
            {plan.map((cp, i) => {
              const status = normalizeStatus(cp)
              const Icon = status === 'done' ? CheckCircle2 : status === 'in_progress' ? CircleDot : Circle
              return (
                <li key={cp.id ?? i} className="flex items-start gap-2 rounded px-2 py-1">
                  <Icon
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0',
                      status === 'done' && 'text-success',
                      status === 'in_progress' && 'text-accent pulse-soft',
                      status === 'todo' && 'text-fg-3',
                    )}
                  />
                  <span className={cn('text-[12.5px] leading-snug', status === 'done' && 'text-fg-3 line-through')}>
                    {cp.text}
                  </span>
                </li>
              )
            })}
          </ul>
        </Section>

        <Section
          icon={Workflow}
          title="Sub-agents"
          count={children.length || undefined}
          empty="No sub-agents in this session."
          isEmpty={children.length === 0}
        >
          <ul className="space-y-1.5">
            {children.map((c) => (
              <li key={c.id} className="rounded-md px-2 py-1.5 hover:bg-bg-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11.5px] text-fg">
                    #{c.numericId} <span className="text-fg-3">{c.template}</span>
                  </span>
                  <LifecyclePill lifecycle={c.lifecycle} outcome={c.outcome} />
                </div>
                {c.lastToolCallSummary && (
                  <div className="mt-0.5 truncate text-[10.5px] text-fg-3">
                    {c.lastToolCallSummary}
                  </div>
                )}
                <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
                  <span>{c.lifetimeToolCallCount} tools</span>
                  {c.lastTotalTokens > 0 && <span>· {formatTokens(c.lastTotalTokens)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          icon={Activity}
          title="Recent activity"
          count={recent.length || undefined}
          empty="No tool activity yet."
          isEmpty={recent.length === 0}
        >
          <ul className="space-y-0.5">
            {recent.map((r) => (
              <li key={r.key} className="rounded px-2 py-1 font-mono text-[11px] text-fg-3">
                <span className="text-fg-2">{r.toolName ?? r.type}</span>
                {r.text && (
                  <span className="ml-1.5 truncate text-muted">
                    {abbreviateLine(r.text, r.toolName)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </aside>
  )
}

function Section({
  icon: Icon,
  title,
  count,
  isEmpty,
  empty,
  children,
}: {
  icon: React.FC<{ className?: string }>
  title: string
  count?: number
  isEmpty: boolean
  empty: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1.5 flex items-center gap-1.5 px-3 py-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">
        <Icon className="h-3 w-3" />
        <span>{title}</span>
        {count != null && (
          <span className="ml-auto font-mono text-[10px] normal-case tracking-normal text-fg-3">
            {count}
          </span>
        )}
      </div>
      {isEmpty ? (
        <div className="px-3 py-1 text-[11px] text-muted">{empty}</div>
      ) : (
        children
      )}
    </div>
  )
}

function LifecyclePill({ lifecycle, outcome }: { lifecycle: string; outcome: string }): JSX.Element {
  const tone =
    lifecycle === 'running'
      ? 'border-accent/40 bg-accent-soft text-accent'
      : outcome === 'completed'
        ? 'border-success/40 bg-success/10 text-success'
        : outcome === 'error' || lifecycle === 'error'
          ? 'border-error/40 bg-error/10 text-error'
          : 'border-border text-fg-3'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wider',
        tone,
      )}
    >
      {lifecycle === 'running' ? 'live' : outcome !== 'none' ? outcome : lifecycle}
    </span>
  )
}

function normalizeStatus(cp: PlanCheckpoint): 'todo' | 'in_progress' | 'done' {
  if (cp.status === 'done' || cp.status === 'in_progress' || cp.status === 'todo') return cp.status
  if (cp.state === 'done' || cp.state === 'in_progress' || cp.state === 'todo') return cp.state
  if (cp.done === true) return 'done'
  return 'todo'
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function abbreviateLine(s: string, toolName: string | null): string {
  let t = s
  if (toolName) {
    // The display already starts with "<toolName> "; strip it for brevity.
    if (t.startsWith(`${toolName} `)) t = t.slice(toolName.length + 1)
  }
  // Shorten absolute paths to basenames
  t = t.replace(/(\/[A-Za-z0-9_\-./]+)/g, (full) => {
    const base = full.split('/').pop() ?? full
    return base
  })
  return t.length > 50 ? `${t.slice(0, 47)}…` : t
}
