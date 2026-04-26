/**
 * StatusBar — thin working-state indicator between transcript and composer.
 * Template-style: only shows when actively working (dashed border + label).
 */
import type { SessionTab } from '@shared/rpc.js'
import type { TabState } from '@/state/sessionStore.js'

export function StatusBar({ tab, state }: { tab: SessionTab; state: TabState | null }): JSX.Element {
  const status = state?.status
  if (!status?.currentTurnRunning) return <></>

  const label = status.lastToolCallSummary || capitalize(status.sessionPhase) || 'Working'

  return (
    <div className="flex items-center gap-2.5 border-y border-dashed border-line-soft px-8 py-2">
      <span className="pulse-ring" />
      <span className="truncate text-[14.5px] text-ink-2">{label}…</span>
    </div>
  )
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
