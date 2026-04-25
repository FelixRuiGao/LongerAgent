/**
 * Composer: borderless input + fade overlay + simplified status pills.
 * Matches template: no top border, pane-2 bg textarea, fade-out overlay
 * above, minimal status bar (accept edits / attach / model picker / theme).
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, Paperclip, Sun, Moon, Zap, ChevronDown } from 'lucide-react'
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
  const theme = useSessionStore((s) => s.theme)
  const setTheme = useSessionStore((s) => s.setTheme)

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }, [text])

  const send = async (): Promise<void> => {
    const v = text.trim()
    if (!v || disabled) return
    setText('')
    await onSubmit(v)
  }

  const interrupt = async (): Promise<void> => {
    try {
      await api.rpc.request(tab.tabId, 'session.requestTurnInterrupt')
    } catch {
      // ignore
    }
  }

  const meta = state?.meta
  const modelName = meta?.modelConfigName ?? tab.selectedModel ?? ''

  return (
    <div className="relative bg-pane px-6 pb-3.5">
      {/* Fade overlay: content behind composer fades into pane bg */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-9 h-9"
        style={{ background: 'linear-gradient(to bottom, transparent, var(--color-pane))' }}
      />

      <div className="relative mx-auto max-w-[760px]">
        {/* Scroll-to-bottom pill */}
        {disabled && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2">
            <span className="inline-flex items-center gap-1 rounded-full bg-pane-2 border border-line px-2 py-0.5 text-[11px] text-ink-3">
              <span className="pulse-ring" />
              <span>Working…</span>
            </span>
          </div>
        )}

        {/* Input area */}
        <div className="flex items-end gap-2 rounded-2xl bg-pane-2 px-4 py-3">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Type / for commands"
            rows={1}
            className="flex-1 resize-none bg-transparent py-1 text-[14px] leading-[1.5] text-ink outline-none placeholder:text-ink-4"
            style={{ minHeight: 22, maxHeight: 140, overflowY: 'auto' }}
          />
          {disabled ? (
            <button
              onClick={interrupt}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-[10px] text-ink-3 transition hover:bg-line-soft hover:text-ink"
              title="Interrupt"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!text.trim()}
              className={cn(
                'grid h-7 w-7 shrink-0 place-items-center rounded-[10px] transition',
                text.trim() ? 'text-ink hover:bg-line-soft' : 'text-ink-3',
              )}
              title="Send (↵)"
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          )}
        </div>

        {/* Status bar: simplified pills */}
        <div className="flex items-center gap-0.5 px-1 pt-2">
          <StatusPill>
            <Paperclip className="h-3 w-3" strokeWidth={1.6} />
          </StatusPill>
          <div className="flex-1" />
          <StatusPill>
            <Zap className="h-[11px] w-[11px]" strokeWidth={1.8} />
            <span className="whitespace-nowrap">{modelName || 'no model'}</span>
            <ChevronDown className="h-[9px] w-[9px] opacity-50" strokeWidth={2} />
          </StatusPill>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="Toggle theme"
            className="ml-0.5 grid h-[26px] w-[26px] place-items-center rounded-lg text-ink-3 transition hover:bg-line-soft hover:text-ink"
          >
            {theme === 'dark' ? (
              <Sun className="h-3 w-3" strokeWidth={1.6} />
            ) : (
              <Moon className="h-3 w-3" strokeWidth={1.6} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusPill({
  children,
  onClick,
}: {
  children: React.ReactNode
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-[5px] rounded-lg px-2.5 py-1 text-[11.5px] font-medium text-ink-3 transition hover:bg-line-soft hover:text-ink"
    >
      {children}
    </button>
  )
}
