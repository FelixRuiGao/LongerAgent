import type { SessionTab } from '@shared/rpc.js'
import type { TabState } from '@/state/sessionStore.js'

export function StatusBar({ tab, state }: { tab: SessionTab; state: TabState | null }): JSX.Element {
  const status = state?.status
  const meta = state?.meta
  const ctxBudget = status?.contextBudget ?? 0
  const used = status?.lastInputTokens ?? 0
  const pct = ctxBudget > 0 ? Math.min(100, Math.round((used / ctxBudget) * 100)) : 0

  const phase = status?.currentTurnRunning ? capitalize(status.sessionPhase) : 'Idle'

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-bg/40 px-6 text-[10.5px] text-fg-3 backdrop-blur-sm">
      <span className="inline-flex items-center gap-1.5">
        <PhaseDot running={status?.currentTurnRunning ?? false} />
        <span>{phase}</span>
      </span>

      {status?.lastToolCallSummary && status.currentTurnRunning && (
        <>
          <span className="text-muted">·</span>
          <span className="truncate text-fg-3 max-w-[300px]">{status.lastToolCallSummary}</span>
        </>
      )}

      <span className="ml-auto inline-flex items-center gap-3 text-muted">
        {status && status.lifetimeToolCallCount > 0 && (
          <span>
            <span className="text-fg-3">{status.lifetimeToolCallCount}</span> tools
          </span>
        )}
        {ctxBudget > 0 && (
          <span>
            <span className="text-fg-3">{formatTokens(used)}</span>
            <span className="text-muted"> / </span>
            <span>{formatTokens(ctxBudget)}</span>
            <span className="text-muted"> ({pct}%)</span>
          </span>
        )}
        {meta?.thinkingLevel && meta.thinkingLevel !== 'none' && (
          <span className="font-mono text-fg-3">{meta.thinkingLevel}</span>
        )}
      </span>
    </div>
  )
}

function PhaseDot({ running }: { running: boolean }): JSX.Element {
  if (running) {
    return <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-soft" />
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-success/60" />
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
