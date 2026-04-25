/**
 * Inline approval card. Renders when the active session has a pending
 * `approval` ask. Lets the user choose an offer (allow once / allow with
 * scope / deny) which gets resolved via `session.resolveApprovalAsk`.
 *
 * Sits just above the Composer so the conversation flow stays visible.
 */

import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, Check, X, ChevronUp, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { api } from '@/lib/api.js'
import type { SessionTab } from '@shared/rpc.js'

interface ApprovalAsk {
  id: string
  kind: 'approval'
  summary: string
  payload: {
    toolCallId: string
    toolName: string
    toolSummary: string
    permissionClass: string
    offers: Array<{
      type: string
      label: string
      scope?: string
      rule?: Record<string, unknown>
    }>
  }
  options: string[]
}

interface AgentQuestionAsk {
  id: string
  kind: 'agent_question'
  summary: string
  payload: {
    toolCallId: string
    questions: Array<{
      question: string
      options: Array<{ label: string; description?: string; kind: string }>
    }>
  }
}

type AnyAsk = ApprovalAsk | AgentQuestionAsk

export function AskBar({ tab }: { tab: SessionTab }): JSX.Element | null {
  const [ask, setAsk] = useState<AnyAsk | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const a = await api.rpc.request<AnyAsk | null>(tab.tabId, 'session.getPendingAsk')
        if (!cancelled) setAsk(a)
      } catch {
        if (!cancelled) setAsk(null)
      }
    }
    void refresh()
    const off = api.rpc.onEvent((e) => {
      if (e.tabId !== tab.tabId) return
      if (e.method === 'ask.pending' || e.method === 'ask.resolved' || e.method === 'log.changed') {
        void refresh()
      }
    })
    return () => {
      cancelled = true
      off()
    }
  }, [tab.tabId])

  if (!ask) return null

  if (ask.kind === 'approval') {
    return <ApprovalCard tab={tab} ask={ask} />
  }
  if (ask.kind === 'agent_question') {
    return <QuestionCard tab={tab} ask={ask} />
  }
  return null
}

function ApprovalCard({ tab, ask }: { tab: SessionTab; ask: ApprovalAsk }): JSX.Element {
  const [selected, setSelected] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  // `options` is the authoritative list of choice labels (length N).
  // `payload.offers` may be shorter — Deny doesn't have an offer rule.
  // Iterate over options; look up offer details for non-deny rows.
  const options = ask.options
  const offers = ask.payload.offers
  const denyIndex = options.findIndex((o) => /^deny/i.test(o))
  const isDangerous = ask.payload.permissionClass.includes('danger')

  const resolve = async (idx: number): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      await api.rpc.request(tab.tabId, 'session.resolveApprovalAsk', {
        askId: ask.id,
        choiceIndex: idx,
      })
      // Resolving the ask transitions the session into a "pending turn" state;
      // we have to actively resume so the agent picks up after approval.
      try {
        await api.rpc.request(tab.tabId, 'session.resumePendingTurn')
      } catch {
        // No pending turn — the user denied or session was already resolved
      }
    } catch (err) {
      console.error('resolveApprovalAsk failed', err)
    } finally {
      setSubmitting(false)
    }
  }

  // Keyboard nav
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (submitting) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => {
          const next = e.key === 'ArrowDown' ? s + 1 : s - 1
          return Math.max(0, Math.min(options.length - 1, next))
        })
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        void resolve(selected)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (denyIndex >= 0) void resolve(denyIndex)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, submitting, options.length, denyIndex])

  return (
    <div className="px-6 pb-2 pt-1">
      <div
        className={cn(
          'rounded-2xl border bg-bg-1/80 backdrop-blur-md shadow-xl',
          isDangerous ? 'border-error/40' : 'border-warning/35',
        )}
      >
        <div className="flex items-start gap-3 px-4 pt-3.5 pb-2">
          <div
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
              isDangerous ? 'bg-error/15 text-error' : 'bg-warning/15 text-warning',
            )}
          >
            {isDangerous ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[12.5px] font-medium text-fg">Approval needed</span>
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-3">
                {ask.payload.permissionClass.replaceAll('_', ' ')}
              </span>
            </div>
            <div className="mt-0.5 text-[12px] text-fg-2">{ask.payload.toolSummary}</div>
          </div>
        </div>

        <ul className="px-2 pb-2">
          {options.map((label, i) => {
            const offer = offers[i]
            const isDeny = i === denyIndex
            const active = i === selected
            return (
              <li key={i}>
                <button
                  onClick={() => void resolve(i)}
                  onMouseEnter={() => setSelected(i)}
                  disabled={submitting}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition',
                    active ? 'bg-bg-2 text-fg' : 'text-fg-2 hover:bg-bg-2/60',
                    isDeny && active && 'text-error',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                      isDeny
                        ? active
                          ? 'border-error/40 bg-error/15 text-error'
                          : 'border-border text-fg-3'
                        : active
                          ? 'border-success/40 bg-success/15 text-success'
                          : 'border-border text-fg-3',
                    )}
                  >
                    {isDeny ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                  </span>
                  <span className="flex-1 truncate text-[12.5px]">{label}</span>
                  {offer?.scope && (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-fg-3">
                      {offer.scope}
                    </span>
                  )}
                  {active && (
                    <span className="font-mono text-[10px] text-fg-3 opacity-70">↵</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="flex items-center justify-between px-4 py-2 text-[10.5px] text-muted hairline-b first:border-t border-border/60">
          <span className="inline-flex items-center gap-2 font-mono">
            <ChevronUp className="h-3 w-3" />
            <ChevronDown className="h-3 w-3" />
            move · ↵ confirm · esc deny
          </span>
          <span className="font-mono text-fg-3">{ask.payload.toolName}</span>
        </div>
      </div>
    </div>
  )
}

function QuestionCard({ tab, ask }: { tab: SessionTab; ask: AgentQuestionAsk }): JSX.Element {
  const [answers, setAnswers] = useState<number[]>(() => ask.payload.questions.map(() => 0))
  const [submitting, setSubmitting] = useState(false)

  const submit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      const decision = {
        answers: ask.payload.questions.map((q, i) => ({
          questionIndex: i,
          selectedOptionIndex: answers[i] ?? 0,
          answerText: q.options[answers[i] ?? 0]?.label ?? '',
        })),
      }
      await api.rpc.request(tab.tabId, 'session.resolveAgentQuestionAsk', {
        askId: ask.id,
        decision,
      })
      try {
        await api.rpc.request(tab.tabId, 'session.resumePendingTurn')
      } catch {
        // ignore
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="px-6 pb-2 pt-1">
      <div className="rounded-2xl border border-info/35 bg-bg-1/80 p-4 backdrop-blur-md shadow-xl">
        <div className="text-[12.5px] font-medium text-fg">{ask.summary}</div>
        <div className="mt-3 space-y-3">
          {ask.payload.questions.map((q, qi) => (
            <div key={qi}>
              <div className="text-[12.5px] text-fg-2">{q.question}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {q.options.map((opt, oi) => (
                  <button
                    key={oi}
                    onClick={() => setAnswers((a) => a.map((v, idx) => (idx === qi ? oi : v)))}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-[11.5px] transition',
                      answers[qi] === oi
                        ? 'bg-accent text-bg'
                        : 'bg-bg-2 text-fg-2 hover:bg-bg-elev',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => void submit()}
            disabled={submitting}
            className="rounded-md bg-accent px-3 py-1.5 text-[11.5px] font-medium text-bg hover:bg-accent-strong disabled:opacity-50"
          >
            Submit answer
          </button>
        </div>
      </div>
    </div>
  )
}
