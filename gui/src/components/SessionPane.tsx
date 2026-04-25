import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/state/sessionStore.js'
import { Composer } from '@/components/Composer.js'
import { Transcript } from '@/components/Transcript.js'
import { StatusBar } from '@/components/StatusBar.js'
import { AskBar } from '@/components/ApprovalCard.js'
import type { SessionTab } from '@shared/rpc.js'

export function SessionPane({ tab }: { tab: SessionTab }): JSX.Element {
  const state = useSessionStore((s) => s.perTab[tab.tabId])
  const submitTurn = useSessionStore((s) => s.submitTurn)
  const transcriptRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on log change. Could be smarter (only if user is near bottom).
  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [state?.logRevision])

  const onSubmit = async (input: string): Promise<void> => {
    await submitTurn(tab.tabId, input)
  }

  if (tab.status === 'starting') {
    return (
      <div className="flex h-full items-center justify-center text-fg-3">
        <span className="shimmer-text text-[13px]">Starting session…</span>
      </div>
    )
  }
  if (tab.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md rounded-lg border border-error/30 bg-error/5 p-5">
          <div className="text-[13px] font-medium text-error">Session failed to start</div>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-[11.5px] text-fg-3">
            {tab.errorMessage ?? 'Unknown error'}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto">
        <Transcript
          entries={state?.logEntries ?? []}
          activeId={state?.activeLogEntryId ?? null}
          workDir={tab.workDir}
        />
      </div>
      <AskBar tab={tab} />
      <StatusBar tab={tab} state={state ?? null} />
      <Composer
        tab={tab}
        state={state ?? null}
        onSubmit={onSubmit}
        disabled={state?.status?.currentTurnRunning ?? false}
      />
    </div>
  )
}
