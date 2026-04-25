import { useEffect, useRef } from 'react'
import { Layers, Terminal, MoreHorizontal } from 'lucide-react'
import { useSessionStore } from '@/state/sessionStore.js'
import { Composer } from '@/components/Composer.js'
import { Transcript } from '@/components/Transcript.js'
import { StatusBar } from '@/components/StatusBar.js'
import { AskBar } from '@/components/ApprovalCard.js'
import { projectName } from '@/lib/path.js'
import type { SessionTab } from '@shared/rpc.js'

export function SessionPane({ tab }: { tab: SessionTab }): JSX.Element {
  const state = useSessionStore((s) => s.perTab[tab.tabId])
  const submitTurn = useSessionStore((s) => s.submitTurn)
  const transcriptRef = useRef<HTMLDivElement>(null)

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
      <div className="flex h-full items-center justify-center text-ink-3">
        <span className="shimmer-text text-[13px]">Starting session…</span>
      </div>
    )
  }
  if (tab.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md rounded-xl border border-error/30 bg-error/5 p-5">
          <div className="text-[13px] font-medium text-error">Session failed to start</div>
          <pre className="mt-2 whitespace-pre-wrap text-[11.5px] text-ink-3">
            {tab.errorMessage ?? 'Unknown error'}
          </pre>
        </div>
      </div>
    )
  }

  const name = projectName(tab.workDir)

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-pane">
      {/* Thread header — project name + tool buttons */}
      <div className="flex shrink-0 items-center gap-3 border-b border-line-soft px-6 py-2.5">
        <Layers className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.6} />
        <span className="text-[13.5px] font-semibold text-ink">{name}</span>
        <div className="flex-1" />
        <HeaderBtn><Terminal className="h-3 w-3" strokeWidth={1.6} /></HeaderBtn>
        <HeaderBtn><MoreHorizontal className="h-3 w-3" strokeWidth={1.6} /></HeaderBtn>
      </div>

      <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto bg-pane">
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

function HeaderBtn({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <button className="grid h-7 w-7 place-items-center rounded-[9px] text-ink-3 transition hover:bg-line-soft hover:text-ink">
      {children}
    </button>
  )
}
