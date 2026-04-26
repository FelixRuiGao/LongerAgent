/**
 * Command palette (⌘K). Radix Dialog + custom list.
 *
 * Commands:
 *  - New session …               → pickDirectory + createTab
 *  - Switch session: <title>     → setActiveTab
 *  - Switch model: <name>        → selectModel
 *  - Toggle theme                → setTheme
 *  - Summarize / Compact         → session.summarize / .compact
 *  - Close current session       → closeTab
 *
 * Fuzzy filter: match by all words in the label.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowRight,
  Plus,
  Sparkles,
  Sun,
  Moon,
  Workflow,
  Zap,
  X as XIcon,
  ChevronRight,
  Hash,
} from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { api } from '@/lib/api.js'
import { useSessionStore } from '@/state/sessionStore.js'
import type { ModelDescriptor, SessionTab } from '@shared/rpc.js'

interface Command {
  id: string
  label: string
  hint?: string
  icon: React.FC<{ className?: string }>
  category: string
  shortcut?: string
  run: () => void | Promise<void>
}

export function CommandPalette(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)

  // Open with ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        setQuery('')
        setHighlightIdx(0)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault()
        void newSessionAction()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Reset highlight when query changes
  useEffect(() => setHighlightIdx(0), [query])

  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const setActive = useSessionStore((s) => s.setActiveTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const theme = useSessionStore((s) => s.theme)
  const setTheme = useSessionStore((s) => s.setTheme)
  const perTab = useSessionStore((s) => s.perTab)

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null
  const activeState = activeTab ? perTab[activeTab.tabId] : null

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = []

    out.push({
      id: 'new-session',
      label: 'New session…',
      hint: 'Open a workspace folder',
      icon: Plus,
      category: 'Session',
      shortcut: '⌘N',
      run: () => newSessionAction(),
    })

    out.push({
      id: 'toggle-theme',
      label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      icon: theme === 'dark' ? Sun : Moon,
      category: 'Appearance',
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    })

    // Switch session
    for (const t of tabs) {
      if (t.tabId === activeTabId) continue
      out.push({
        id: `switch-${t.tabId}`,
        label: `Switch to: ${t.title || t.displayName || 'Untitled'}`,
        hint: deriveProjectName(t.workDir),
        icon: ArrowRight,
        category: 'Session',
        run: () => setActive(t.tabId),
      })
    }

    if (activeTab) {
      out.push({
        id: 'close-session',
        label: 'Close current session',
        icon: XIcon,
        category: 'Session',
        run: () => closeTab(activeTab.tabId),
      })

      // Models
      for (const m of activeState?.models ?? []) {
        if (m.name === activeTab.selectedModel) continue
        out.push({
          id: `model-${m.name}`,
          label: `Model: ${m.name}`,
          hint: `${m.provider} · ${m.model}`,
          icon: Hash,
          category: 'Model',
          run: () =>
            api.rpc.request(activeTab.tabId, 'session.selectModel', { name: m.name }),
        })
      }

      out.push({
        id: 'summarize',
        label: 'Summarize: distill older context',
        icon: Sparkles,
        category: 'Context',
        run: () => api.rpc.request(activeTab.tabId, 'session.summarize'),
      })

      out.push({
        id: 'compact',
        label: 'Compact: rewrite continuation prompt',
        icon: Zap,
        category: 'Context',
        run: () => api.rpc.request(activeTab.tabId, 'session.compact'),
      })

      out.push({
        id: 'interrupt',
        label: 'Interrupt current turn',
        icon: Workflow,
        category: 'Session',
        run: () =>
          api.rpc.request(activeTab.tabId, 'session.requestTurnInterrupt'),
      })
    }

    return out
  }, [tabs, activeTabId, activeState?.models, activeTab, theme, setTheme, setActive, closeTab])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    const tokens = q.split(/\s+/)
    return commands.filter((c) => {
      const hay = `${c.label} ${c.hint ?? ''} ${c.category}`.toLowerCase()
      return tokens.every((t) => hay.includes(t))
    })
  }, [commands, query])

  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-[18%] z-50 w-[640px] max-w-[92vw] -translate-x-1/2',
            'overflow-hidden rounded-xl border border-line bg-pane-2 shadow-2xl',
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            inputRef.current?.focus()
          }}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHighlightIdx((i) => Math.min(filtered.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHighlightIdx((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const cmd = filtered[highlightIdx]
                if (cmd) {
                  setOpen(false)
                  void cmd.run()
                }
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            placeholder="Type to search commands…"
            className={cn(
              'block w-full bg-transparent px-5 py-4 text-[16px] text-ink outline-none',
              'placeholder:text-ink-4 hairline-b border-line-soft',
            )}
          />
          <ul className="max-h-[420px] overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-[14.5px] text-ink-4">
                No matching commands
              </li>
            ) : (
              filtered.map((cmd, i) => {
                const active = i === highlightIdx
                return (
                  <li key={cmd.id}>
                    <button
                      onClick={() => {
                        setOpen(false)
                        void cmd.run()
                      }}
                      onMouseEnter={() => setHighlightIdx(i)}
                      className={cn(
                        'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition',
                        active ? 'bg-line-soft text-ink' : 'text-ink-2 hover:bg-line-soft/60',
                      )}
                    >
                      <cmd.icon className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[15px]">{cmd.label}</div>
                        {cmd.hint && (
                          <div className="truncate font-mono text-[12.5px] text-ink-3">
                            {cmd.hint}
                          </div>
                        )}
                      </div>
                      <span className="font-mono text-[12px] uppercase tracking-wider text-ink-4">
                        {cmd.category}
                      </span>
                      {cmd.shortcut && (
                        <span className="font-mono text-[12px] text-ink-3">
                          {cmd.shortcut}
                        </span>
                      )}
                      {active && !cmd.shortcut && (
                        <ChevronRight className="h-3 w-3 text-ink-3" />
                      )}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
          <div className="hairline-b border-t border-line-soft px-3 py-2 text-[14.5px] font-mono text-ink-4">
            ↑↓ navigate · ↵ run · esc close
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

async function newSessionAction(): Promise<void> {
  const dir = await api.workspace.pickDirectory()
  if (!dir) return
  await useSessionStore.getState().createTab(dir)
}

function deriveProjectName(workDir: string): string {
  const segs = workDir.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? workDir
}
