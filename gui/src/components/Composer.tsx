import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { useSessionStore } from '@/state/sessionStore.js'
import { api } from '@/lib/api.js'
import type { SessionTab } from '@shared/rpc.js'
import type { TabState } from '@/state/sessionStore.js'

export function Composer({
  tab,
  state,
  onSubmit,
  disabled,
}: {
  tab: SessionTab
  state: TabState | null
  onSubmit: (input: string) => Promise<void>
  disabled: boolean
}): JSX.Element {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow textarea
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [text])

  const send = async (): Promise<void> => {
    const value = text.trim()
    if (!value || disabled) return
    setText('')
    await onSubmit(value)
  }

  const interrupt = async (): Promise<void> => {
    try {
      await api.rpc.request(tab.tabId, 'session.requestTurnInterrupt')
    } catch {
      // ignore
    }
  }

  return (
    <div className="px-6 pb-5 pt-2">
      <div
        className={cn(
          'group relative rounded-2xl border bg-bg-1/70 backdrop-blur-md transition',
          'border-border focus-within:border-accent/40 focus-within:bg-bg-1',
          'shadow-[0_0_0_0_rgba(0,0,0,0)] focus-within:shadow-[0_0_0_4px_rgba(180,140,242,0.06)]',
        )}
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.altKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={disabled ? 'Working…' : 'Ask Fermi to do something…'}
          rows={1}
          className={cn(
            'block w-full resize-none bg-transparent px-4 py-3.5 pr-14',
            'text-[13.5px] leading-[1.55] text-fg placeholder:text-muted',
            'outline-none',
          )}
        />

        <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
          {disabled ? (
            <button
              onClick={interrupt}
              className={cn(
                'ring-focus flex h-8 w-8 items-center justify-center rounded-full',
                'bg-bg-2 text-warning transition hover:bg-warning/10',
              )}
              aria-label="Interrupt"
              title="Interrupt"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!text.trim()}
              className={cn(
                'ring-focus flex h-8 w-8 items-center justify-center rounded-full transition',
                text.trim()
                  ? 'bg-accent text-bg hover:bg-accent-strong'
                  : 'bg-bg-2 text-muted',
              )}
              aria-label="Send"
              title="Send (↵)"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between px-1 text-[10.5px] text-muted">
        <span className="font-mono">↵ send · ⇧↵ newline · ⌘K commands</span>
        <ModelChip tab={tab} state={state} />
      </div>
    </div>
  )
}

function ModelChip({ tab, state }: { tab: SessionTab; state: TabState | null }): JSX.Element {
  const selectModel = useSessionStore((s) => s.selectModel)
  const [open, setOpen] = useState(false)
  const meta = state?.meta
  const models = state?.models ?? []
  const current = meta?.modelConfigName ?? tab.selectedModel ?? 'no model'

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10.5px] transition',
          'text-fg-3 hover:bg-bg-1 hover:text-fg',
        )}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{
            background: providerColor(meta?.modelProvider ?? tab.modelProvider ?? ''),
          }}
        />
        <span className="truncate max-w-[200px]">{current}</span>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full right-0 z-50 mb-1.5 w-80 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-elev shadow-xl">
            {models.length === 0 ? (
              <div className="px-3 py-3 text-[11.5px] text-fg-3">No models available</div>
            ) : (
              models.map((m) => (
                <button
                  key={m.name}
                  onClick={() => {
                    void selectModel(tab.tabId, m.name)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition',
                    m.name === current
                      ? 'bg-accent-soft text-fg'
                      : 'hover:bg-bg-2',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11.5px] text-fg">{m.name}</div>
                    <div className="truncate text-[10.5px] text-fg-3">
                      {m.provider} · {m.model}
                    </div>
                  </div>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: providerColor(m.provider) }}
                  />
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

function providerColor(provider: string): string {
  const map: Record<string, string> = {
    openai: 'var(--color-provider-openai)',
    'openai-codex': 'var(--color-provider-openai)',
    anthropic: 'var(--color-provider-anthropic)',
    kimi: 'var(--color-provider-kimi)',
    glm: 'var(--color-provider-glm)',
    minimax: 'var(--color-provider-minimax)',
    openrouter: 'var(--color-provider-openrouter)',
  }
  return map[provider] ?? 'var(--color-fg-3)'
}
