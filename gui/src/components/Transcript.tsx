/**
 * Conversation transcript renderer.
 *
 * Takes raw `LogEntry[]` from the server and projects them into visual cards.
 * For now this is a deliberately spartan view — we'll layer richer renderers
 * (file diffs, code blocks, tool result tabs) on top once the basic flow is
 * proven. Aesthetics first; rich semantics next.
 */

import { useMemo } from 'react'
import { User, Wrench, Terminal, Sparkles, AlertTriangle, FileEdit, Search, Brain } from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { Markdown } from '@/components/Markdown.js'

interface LogEntry {
  id: string
  type: string
  display?: string
  tuiVisible?: boolean
  discarded?: boolean
  meta?: Record<string, unknown>
  content?: unknown
}

export function Transcript({
  entries,
  activeId,
}: {
  entries: unknown[]
  activeId: string | null
}): JSX.Element {
  const visible = useMemo(() => {
    return (entries as LogEntry[]).filter((e) => !e.discarded && e.tuiVisible !== false)
  }, [entries])

  if (visible.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-2xl items-center justify-center px-6 text-center">
        <div className="text-fg-3">
          <p className="text-[13px] leading-relaxed">
            Send a message to begin.
            <br />
            <span className="text-muted">
              The agent will work in this directory and may modify files.
            </span>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="space-y-5">
        {visible.map((entry) => (
          <EntryRow key={entry.id} entry={entry} active={entry.id === activeId} />
        ))}
      </div>
    </div>
  )
}

function EntryRow({ entry, active }: { entry: LogEntry; active: boolean }): JSX.Element {
  const display = entry.display ?? ''

  switch (entry.type) {
    case 'user_message':
      return <UserMessage text={display} />
    case 'assistant_text':
      return <AssistantText text={display} active={active} />
    case 'reasoning':
      return <Reasoning text={display} active={active} />
    case 'tool_call':
      return <ToolCall entry={entry} active={active} />
    case 'tool_result':
      // Hide tool_result rows by default — they show under the call.
      return <></>
    case 'agent_result':
      return <AgentResult text={display} />
    case 'sub_agent_start':
    case 'sub_agent_end':
    case 'sub_agent_tool_call':
      return <SubAgentRow text={display} type={entry.type} />
    case 'compact_marker':
      return <CompactMarker text={display} />
    case 'status':
      return <StatusRow text={display} />
    case 'error':
      return <ErrorRow text={display} />
    case 'interruption_marker':
      return <InterruptedRow text={display} />
    case 'turn_start':
    case 'turn_end':
    case 'no_reply':
    case 'token_update':
    case 'system_prompt':
    case 'ask_request':
    case 'ask_resolution':
      return <></>
    default:
      return (
        <div className="text-[11px] text-muted font-mono">
          [{entry.type}] {display}
        </div>
      )
  }
}

// ── Row variants ──

function UserMessage({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="group flex max-w-[80%] items-start gap-2.5">
        <div className="rounded-2xl rounded-tr-sm bg-accent-soft border border-accent/20 px-4 py-2.5 text-[13.5px] leading-relaxed text-fg whitespace-pre-wrap break-words">
          {text}
        </div>
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-2 text-fg-3">
          <User className="h-3.5 w-3.5" />
        </div>
      </div>
    </div>
  )
}

function AssistantText({ text, active }: { text: string; active: boolean }): JSX.Element {
  if (!text.trim()) return <></>
  return (
    <div className="flex items-start gap-3">
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <Markdown
          text={text}
          className={cn(
            active && 'after:ml-1 after:inline-block after:h-3.5 after:w-1.5 after:translate-y-0.5 after:bg-accent/70',
          )}
        />
      </div>
    </div>
  )
}

function Reasoning({ text, active }: { text: string; active: boolean }): JSX.Element {
  if (!text.trim()) return <></>
  return (
    <div className="flex items-start gap-3 pl-10 -mt-2">
      <div className="-ml-10 mt-1 flex h-7 w-7 shrink-0 items-center justify-center text-fg-3">
        <Brain className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1 text-[12.5px] italic leading-[1.6] text-fg-3">
        <div className={cn('whitespace-pre-wrap break-words', active && 'shimmer-text not-italic')}>
          {text}
        </div>
      </div>
    </div>
  )
}

function ToolCall({ entry, active }: { entry: LogEntry; active: boolean }): JSX.Element {
  const meta = entry.meta as Record<string, unknown> | undefined
  const toolName = (meta?.['toolName'] as string) ?? 'tool'
  const Icon = pickToolIcon(toolName)
  // entry.display already encodes "<toolName> <args>". Don't duplicate the
  // tool name — split it into a label + remainder so the label can shimmer
  // independently while running.
  const display = entry.display ?? toolName
  const space = display.indexOf(' ')
  const label = space > 0 ? display.slice(0, space) : display
  const rest = space > 0 ? display.slice(space + 1) : ''

  return (
    <div className="flex items-start gap-3 pl-10">
      <div className="-ml-10 mt-1 flex h-7 w-7 shrink-0 items-center justify-center text-fg-3">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0 py-0.5">
        <div
          className={cn(
            'inline-flex max-w-full items-baseline gap-2 rounded-md font-mono text-[11.5px]',
            active && 'text-fg',
          )}
        >
          <span className={cn('font-medium', active ? 'shimmer-text' : 'text-fg-2')}>
            {label}
          </span>
          {rest && <span className="truncate text-fg-3">{rest}</span>}
        </div>
      </div>
    </div>
  )
}

function AgentResult({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 pl-10 -mt-1">
      <div className="-ml-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-info">
        <Wrench className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 rounded-md border border-border bg-bg-1/50 px-3 py-2 text-[12px] text-fg-2 whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  )
}

function SubAgentRow({ text, type }: { text: string; type: string }): JSX.Element {
  const isStart = type === 'sub_agent_start'
  return (
    <div className="flex items-start gap-3 pl-10 -mt-1">
      <div className="-ml-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-fg-3">
        <Wrench className="h-3.5 w-3.5" />
      </div>
      <div
        className={cn(
          'rounded-md px-2.5 py-1 font-mono text-[11.5px]',
          isStart ? 'text-fg-2' : 'text-fg-3',
        )}
      >
        {text}
      </div>
    </div>
  )
}

function CompactMarker({ text }: { text: string }): JSX.Element {
  return (
    <div className="my-2 flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted">
        {text || 'compact'}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

function StatusRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="text-center text-[11.5px] italic text-muted">{text}</div>
  )
}

function ErrorRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 pl-10 -mt-1">
      <div className="-ml-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-error">
        <AlertTriangle className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 rounded-md border border-error/30 bg-error/5 px-3 py-2 text-[12px] text-error whitespace-pre-wrap">
        {text}
      </div>
    </div>
  )
}

function InterruptedRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex justify-center">
      <span className="rounded-full border border-warning/30 bg-warning/5 px-3 py-1 text-[10.5px] uppercase tracking-[0.14em] text-warning">
        {text || 'Interrupted'}
      </span>
    </div>
  )
}

function pickToolIcon(name: string): React.FC<{ className?: string }> {
  if (name === 'bash' || name === 'bash_background' || name === 'bash_output' || name === 'kill_shell')
    return Terminal
  if (name === 'edit_file' || name === 'write_file') return FileEdit
  if (name === 'glob' || name === 'grep' || name === 'list_dir' || name === 'read_file') return Search
  if (name === 'spawn' || name === 'spawn_file' || name === 'kill_agent' || name === 'send' || name === 'check_status' || name === 'wait')
    return Wrench
  return Wrench
}
