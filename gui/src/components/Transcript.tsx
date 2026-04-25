/**
 * Conversation transcript renderer.
 *
 * Pairs each tool_call with its corresponding tool_result so they render
 * as one expandable card. Other entry types render standalone.
 */

import { useMemo, useState } from 'react'
import {
  User,
  Wrench,
  Terminal,
  Sparkles,
  AlertTriangle,
  FileEdit,
  Search,
  Brain,
  ChevronRight,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { Markdown } from '@/components/Markdown.js'
import { shortenSummary } from '@/lib/path.js'
import { DiffView } from '@/components/DiffView.js'

interface LogEntry {
  id: string
  type: string
  display?: string
  tuiVisible?: boolean
  discarded?: boolean
  meta?: Record<string, unknown>
  content?: unknown
}

interface ToolCallEntry extends LogEntry {
  type: 'tool_call'
}

interface ToolResultEntry extends LogEntry {
  type: 'tool_result'
}

export function Transcript({
  entries,
  activeId,
  workDir,
}: {
  entries: unknown[]
  activeId: string | null
  workDir?: string
}): JSX.Element {
  // Pre-pair tool_call → tool_result so we can render each pair as a unit.
  const items = useMemo(() => {
    const arr = entries as LogEntry[]
    const visible = arr.filter((e) => !e.discarded && e.tuiVisible !== false)
    const resultByCallId = new Map<string, ToolResultEntry>()
    for (const e of visible) {
      if (e.type === 'tool_result') {
        const callId = (e.meta as Record<string, unknown> | undefined)?.['toolCallId']
        if (typeof callId === 'string') resultByCallId.set(callId, e as ToolResultEntry)
      }
    }
    type Item =
      | { kind: 'entry'; entry: LogEntry }
      | { kind: 'tool'; call: ToolCallEntry; result: ToolResultEntry | null }

    const out: Item[] = []
    for (const e of visible) {
      if (e.type === 'tool_call') {
        const callId = (e.meta as Record<string, unknown> | undefined)?.['toolCallId']
        const result = typeof callId === 'string' ? resultByCallId.get(callId) ?? null : null
        out.push({ kind: 'tool', call: e as ToolCallEntry, result })
      } else if (e.type === 'tool_result') {
        // skip — rendered with its call
      } else {
        out.push({ kind: 'entry', entry: e })
      }
    }
    return out
  }, [entries])

  if (items.length === 0) {
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
        {items.map((item) => {
          if (item.kind === 'tool') {
            const active = item.call.id === activeId
            return (
              <ToolPair
                key={item.call.id}
                call={item.call}
                result={item.result}
                active={active}
                workDir={workDir}
              />
            )
          }
          return <EntryRow key={item.entry.id} entry={item.entry} active={item.entry.id === activeId} />
        })}
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

// ── User message ──

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

// ── Assistant text + reasoning ──

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

// ── Tool call / result pair ──

interface ToolPairProps {
  call: ToolCallEntry
  result: ToolResultEntry | null
  active: boolean
  workDir?: string
}

function ToolPair({ call, result, active, workDir }: ToolPairProps): JSX.Element {
  const meta = call.meta as Record<string, unknown> | undefined
  const toolName = (meta?.['toolName'] as string) ?? 'tool'
  const Icon = pickToolIcon(toolName)

  // Split "<toolName> <args>" so we can shimmer the label while running
  const display = call.display ?? toolName
  const space = display.indexOf(' ')
  const label = space > 0 ? display.slice(0, space) : display
  const rest = space > 0 ? display.slice(space + 1) : ''

  const resultMeta = result?.meta as Record<string, unknown> | undefined
  const resultContent = result?.content as { content?: string } | undefined
  const resultText = (resultContent?.content as string | undefined) ?? ''
  // For file_modify tools, the diff lives in result.display, not content.
  const resultDisplay = result?.display ?? ''
  const isError = resultMeta?.['isError'] === true
  const running = active || !result
  const isFileModify = toolName === 'write_file' || toolName === 'edit_file'

  // For file-modify tools, expand by default (the diff IS the content).
  // For everything else, collapse by default.
  const [expanded, setExpanded] = useState(isFileModify)
  const canExpand =
    !!result && (resultText.trim().length > 0 || resultDisplay.trim().length > 0)
  const togglable = canExpand && !running

  return (
    <div className="flex items-start gap-3 pl-10">
      <div className="-ml-10 mt-1 flex h-7 w-7 shrink-0 items-center justify-center text-fg-3">
        <Icon className={cn('h-3.5 w-3.5', isError && 'text-error', !isError && result && 'text-success/80')} />
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <button
          onClick={() => togglable && setExpanded((v) => !v)}
          disabled={!togglable}
          className={cn(
            'group inline-flex max-w-full items-baseline gap-1.5 rounded-md text-left font-mono text-[11.5px]',
            togglable && 'cursor-pointer hover:text-fg',
          )}
        >
          {togglable && (
            <ChevronRight
              className={cn(
                'mb-px h-3 w-3 shrink-0 self-center text-fg-3 transition-transform',
                expanded && 'rotate-90',
              )}
            />
          )}
          {!togglable && running && (
            <span className="mb-px inline-block h-1.5 w-1.5 shrink-0 self-center rounded-full bg-accent pulse-soft" />
          )}
          {!togglable && !running && (
            <CheckCircle2 className="mb-px h-3 w-3 shrink-0 self-center text-fg-3" />
          )}
          <span className={cn('font-medium', running ? 'shimmer-text' : 'text-fg-2')}>
            {label}
          </span>
          {rest && (
            <span className="truncate text-fg-3">{shortenSummary(rest, workDir)}</span>
          )}
          {isError && !running && (
            <XCircle className="ml-1 h-3 w-3 shrink-0 self-center text-error" />
          )}
        </button>

        {expanded && result && isFileModify && (
          <DiffView
            text={resultDisplay}
            workDir={workDir}
            isError={isError}
            resultSummary={shortenSummary(
              resultText.replace(/\s*\[mtime_ms=\d+\]/g, ''),
              workDir,
            )}
          />
        )}
        {expanded && result && !isFileModify && (
          <ToolResultBody toolName={toolName} text={resultText} isError={isError} />
        )}
      </div>
    </div>
  )
}

function ToolResultBody({
  toolName,
  text,
  isError,
}: {
  toolName: string
  text: string
  isError: boolean
}): JSX.Element {
  const lang = pickResultLang(toolName, text)
  // For very long results, cap render to first ~200 lines + last ~50 lines
  // with a "(N lines hidden)" separator. Avoids freezing the renderer.
  const lines = text.split('\n')
  let body = text
  if (lines.length > 280) {
    const head = lines.slice(0, 200).join('\n')
    const tail = lines.slice(-50).join('\n')
    body = `${head}\n\n  … ${lines.length - 250} lines hidden …\n\n${tail}`
  }
  return (
    <div
      className={cn(
        'mt-1.5 overflow-hidden rounded-md border bg-bg-1/60',
        isError ? 'border-error/30' : 'border-border',
      )}
    >
      <pre className="m-0 max-h-[420px] overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-fg-2 whitespace-pre">
        <code className={`language-${lang}`}>{body}</code>
      </pre>
    </div>
  )
}

// ── Misc rows ──

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
  return <div className="text-center text-[11.5px] italic text-muted">{text}</div>
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

// ── Utils ──

function pickToolIcon(name: string): React.FC<{ className?: string }> {
  if (name === 'bash' || name === 'bash_background' || name === 'bash_output' || name === 'kill_shell')
    return Terminal
  if (name === 'edit_file' || name === 'write_file') return FileEdit
  if (name === 'glob' || name === 'grep' || name === 'list_dir' || name === 'read_file') return Search
  return Wrench
}

function pickResultLang(toolName: string, text: string): string {
  if (toolName === 'bash' || toolName === 'bash_background' || toolName === 'bash_output') return 'bash'
  if (toolName === 'read_file') {
    // Heuristic: try to infer lang from file extension in the result header
    const m = text.match(/Lines? \d+-\d+ of/)
    if (m) return 'text'
    return 'text'
  }
  return 'text'
}

