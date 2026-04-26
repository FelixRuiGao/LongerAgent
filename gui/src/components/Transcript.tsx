/**
 * Transcript: document-style rendering matching the design template.
 *
 * - User messages → right-aligned neutral bubble
 * - Reasoning → "✦ Thought for Xs" header + dim body
 * - Assistant text → document prose with markdown
 * - Tool calls → prefix-labeled rows (Q_ grep, $_ bash, ✎_ edit, etc.)
 *   with expandable result body
 * - File edits → inline pill chips with +/- counts
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  AlertTriangle,
  File,
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

interface ToolCallEntry extends LogEntry { type: 'tool_call' }
interface ToolResultEntry extends LogEntry { type: 'tool_result' }

export function Transcript({
  entries,
  activeId,
  workDir,
}: {
  entries: unknown[]
  activeId: string | null
  workDir?: string
}): JSX.Element {
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
    type ToolPair = { call: ToolCallEntry; result: ToolResultEntry | null }
    type Item =
      | { kind: 'entry'; entry: LogEntry }
      | { kind: 'tool'; call: ToolCallEntry; result: ToolResultEntry | null }
      | { kind: 'reasoning'; entries: LogEntry[] }
      | { kind: 'explore'; pairs: ToolPair[] }

    const out: Item[] = []
    for (const e of visible) {
      if (e.type === 'tool_call') {
        const callId = (e.meta as Record<string, unknown> | undefined)?.['toolCallId']
        const result = typeof callId === 'string' ? resultByCallId.get(callId) ?? null : null
        const toolName = (e.meta as Record<string, unknown> | undefined)?.['toolName'] as string ?? ''
        const pair: ToolPair = { call: e as ToolCallEntry, result }

        if (isExploreTool(toolName)) {
          const last = out[out.length - 1]
          if (last && last.kind === 'explore') {
            last.pairs.push(pair)
          } else {
            out.push({ kind: 'explore', pairs: [pair] })
          }
        } else {
          out.push({ kind: 'tool', ...pair })
        }
      } else if (e.type === 'tool_result') {
        // rendered with its call
      } else if (e.type === 'reasoning') {
        const last = out[out.length - 1]
        if (last && last.kind === 'reasoning') {
          last.entries.push(e)
        } else {
          out.push({ kind: 'reasoning', entries: [e] })
        }
      } else {
        out.push({ kind: 'entry', entry: e })
      }
    }
    return out
  }, [entries])

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-[15px] text-ink-3">Send a message to begin.</p>
          <p className="mt-1 text-[16px] text-ink-4">The agent will work in this directory and may modify files.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[760px] px-8 py-6">
      {items.map((item) => {
        if (item.kind === 'reasoning') {
          const lastEntry = item.entries[item.entries.length - 1]!
          const active = lastEntry.id === activeId
          const combined = item.entries.map((e) => e.display ?? '').filter(Boolean).join('\n')
          return <ThoughtBlock key={item.entries[0]!.id} text={combined} active={active} />
        }
        if (item.kind === 'explore') {
          // Single explore tool → render as plain dim text line (same as grouped items)
          if (item.pairs.length === 1) {
            const p = item.pairs[0]!
            return (
              <ExploreItem
                key={p.call.id}
                call={p.call}
                result={p.result}
                workDir={workDir}
              />
            )
          }
          return (
            <ExploreGroup
              key={item.pairs[0]!.call.id}
              pairs={item.pairs}
              workDir={workDir}
            />
          )
        }
        if (item.kind === 'tool') {
          const active = item.call.id === activeId
          const meta = item.call.meta as Record<string, unknown> | undefined
          const toolName = (meta?.['toolName'] as string) ?? 'tool'
          const isFileModify = toolName === 'write_file' || toolName === 'edit_file'
          if (isFileModify) {
            return (
              <FileEditPill
                key={item.call.id}
                call={item.call}
                result={item.result}
                active={active}
                workDir={workDir}
              />
            )
          }
          return (
            <ToolRow
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
  )
}

function EntryRow({ entry, active }: { entry: LogEntry; active: boolean }): JSX.Element {
  const display = entry.display ?? ''
  switch (entry.type) {
    case 'user_message':
      return <UserBubble text={display} />
    case 'assistant_text':
      return <AssistantText text={display} active={active} />
    case 'reasoning':
      // Handled by the reasoning-merge logic above; should not reach here.
      return <></>

    case 'agent_result':
      return <AssistantText text={display} active={false} />
    case 'sub_agent_start':
    case 'sub_agent_end':
    case 'sub_agent_tool_call':
      return <SubAgentRow text={display} />
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
      return <div className="mono text-[15px] text-ink-4">[{entry.type}] {display}</div>
  }
}

/* ── User message bubble (neutral, right-aligned) ── */

function UserBubble({ text }: { text: string }): JSX.Element {
  return (
    <div className="my-3.5 flex justify-end">
      <div
        className="max-w-[72%] whitespace-pre-wrap rounded-2xl px-4 py-[11px] text-[15.5px] leading-[1.55]"
        style={{ background: 'var(--color-bubble)', color: 'var(--color-bubble-ink)' }}
      >
        {text}
      </div>
    </div>
  )
}

/* ── Thought block: one "✦ Thinking" header per consecutive reasoning run ── */

function ThoughtBlock({ text, active }: { text: string; active: boolean }): JSX.Element {
  const [open, setOpen] = useState(active)
  // Auto-collapse when thinking finishes (active goes false)
  const prevActive = useRef(active)
  if (prevActive.current && !active) {
    // Was active, now done — will collapse on next render
  }
  useEffect(() => {
    if (prevActive.current && !active) setOpen(false)
    prevActive.current = active
  }, [active])
  // Auto-open when active
  useEffect(() => {
    if (active) setOpen(true)
  }, [active])

  if (!text.trim()) return <></>
  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[15px]"
      >
        <span className="font-medium text-ink-3">Thinking</span>
        <ChevronRight
          className={cn('h-3 w-3 text-ink-4 transition-transform', open && 'rotate-90')}
          strokeWidth={2}
        />
      </button>
      {open && (
        <div className={cn('mt-1 text-[15px] leading-[1.6] text-ink-4 whitespace-pre-wrap', active && 'shimmer-text')}>
          {renderThoughtText(text)}
        </div>
      )}
    </div>
  )
}

function renderThoughtText(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  const re = /\*\*(.+?)\*\*/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(<strong key={key++} className="font-semibold">{match[1]}</strong>)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/* ── Assistant text (document prose with markdown) ── */

function AssistantText({ text, active }: { text: string; active: boolean }): JSX.Element {
  if (!text.trim()) return <></>
  return (
    <div className="my-2">
      <Markdown text={text} className={cn(active && 'shimmer-text')} />
    </div>
  )
}

/* ── Tool row (prefix-labeled: Q_, $_, %_, ✎_) ── */

function ToolRow({
  call,
  result,
  active,
  workDir,
}: {
  call: ToolCallEntry
  result: ToolResultEntry | null
  active: boolean
  workDir?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const meta = call.meta as Record<string, unknown> | undefined
  const toolName = (meta?.['toolName'] as string) ?? 'tool'
  const display = call.display ?? toolName
  const space = display.indexOf(' ')
  const cmd = space > 0 ? display.slice(space + 1) : display
  const prefix = pickPrefix(toolName)

  const resultContent = result?.content as { content?: string } | undefined
  const resultText = resultContent?.content ?? result?.display ?? ''
  const isError = (result?.meta as Record<string, unknown> | undefined)?.['isError'] === true
  const running = active || !result
  const canExpand = !!result && resultText.trim().length > 0

  return (
    <div className="my-1.5">
      <button
        onClick={() => canExpand && setOpen(!open)}
        disabled={!canExpand && !running}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left transition',
          'border-line-soft bg-code-bg',
          canExpand && 'cursor-pointer hover:border-line',
        )}
      >
        <span className="mono w-3.5 shrink-0 text-center text-[15px] text-ink-3">
          {running ? <span className="pulse-ring" /> : prefix}
        </span>
        <span
          className={cn(
            'mono flex-1 truncate text-[16px] leading-[1.4]',
            running ? 'shimmer-text' : 'text-code-ink',
          )}
        >
          {shortenSummary(cmd, workDir)}
        </span>
        {canExpand && (
          <ChevronRight
            className={cn(
              'h-[11px] w-[11px] shrink-0 text-ink-4 transition-transform',
              open && 'rotate-90',
            )}
            strokeWidth={2}
          />
        )}
      </button>
      {open && result && (
        <div
          className={cn(
            'mono my-1 rounded-[10px] border border-line-soft bg-code-bg px-3.5 py-3 text-[15.5px] leading-[1.6] text-ink-2',
            'max-h-[400px] overflow-auto whitespace-pre',
            isError && 'border-error/30 text-error',
          )}
        >
          {truncateResult(resultText)}
        </div>
      )}
    </div>
  )
}

/* ── File edit pill (inline chip with +/- counts) ── */

function FileEditPill({
  call,
  result,
  active,
  workDir,
}: {
  call: ToolCallEntry
  result: ToolResultEntry | null
  active: boolean
  workDir?: string
}): JSX.Element {
  const [showDiff, setShowDiff] = useState(false)
  const display = call.display ?? ''
  const space = display.indexOf(' ')
  const path = space > 0 ? display.slice(space + 1) : display
  const shortPath = shortenSummary(path, workDir)

  const resultDisplay = result?.display ?? ''
  const resultContent = result?.content as { content?: string } | undefined
  const resultText = (resultContent?.content ?? '').replace(/\s*\[mtime_ms=\d+\]/g, '')

  // Count actual diff lines (lines like " 3 +code" or " 3 -code")
  const diffLines = resultDisplay.split('\n')
  const actualAdds = diffLines.filter((l) => /^\s*\d+\s+\+/.test(l)).length
  const actualDels = diffLines.filter((l) => /^\s*\d+\s+-/.test(l)).length

  return (
    <div className="my-1 inline-block">
      <button
        onClick={() => setShowDiff(!showDiff)}
        className={cn(
          'inline-flex items-center gap-2 rounded-[10px] border border-line-soft bg-code-bg px-3 py-1.5',
          'transition hover:border-line',
          active && 'animate-pulse',
        )}
      >
        <File className="h-3 w-3 text-ink-3" strokeWidth={1.6} />
        <span className="text-[14px] text-ink">{shortPath}</span>
        {actualAdds > 0 && (
          <span className="text-[13px] text-diff-add-ink">+{actualAdds}</span>
        )}
        {actualDels > 0 && (
          <span className="text-[13px] text-diff-rm-ink">−{actualDels}</span>
        )}
      </button>
      {showDiff && result && (
        <DiffView
          text={resultDisplay}
          workDir={workDir}
          isError={false}
          resultSummary={resultText}
        />
      )}
    </div>
  )
}

/* ── Misc rows ── */

function SubAgentRow({ text }: { text: string }): JSX.Element {
  return <div className="mono my-0.5 text-[15.5px] text-ink-3">{text}</div>
}

function CompactMarker({ text }: { text: string }): JSX.Element {
  return (
    <div className="my-3 flex items-center gap-3">
      <div className="h-px flex-1 bg-line-soft" />
      <span className="text-[14.5px] font-medium uppercase tracking-[0.16em] text-ink-4">
        {text || 'compact'}
      </span>
      <div className="h-px flex-1 bg-line-soft" />
    </div>
  )
}

function StatusRow({ text }: { text: string }): JSX.Element {
  return <div className="text-center text-[15.5px] italic text-ink-4">{text}</div>
}

function ErrorRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="my-1.5 flex items-start gap-2 rounded-[10px] border border-error/30 bg-error/5 px-3 py-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
      <div className="flex-1 text-[16px] text-error whitespace-pre-wrap">{text}</div>
    </div>
  )
}

function InterruptedRow({ text }: { text: string }): JSX.Element {
  return (
    <div className="my-3 flex items-center gap-3">
      <div className="h-px flex-1 border-t border-dashed border-line-soft" />
      <span className="text-[14.5px] uppercase tracking-[0.14em] text-ink-3">
        {text || 'Interrupted'}
      </span>
      <div className="h-px flex-1 border-t border-dashed border-line-soft" />
    </div>
  )
}

/* ── Helpers ── */

/* ── Explore group: consecutive read-only tools bundled ── */

const EXPLORE_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch'])

function isExploreTool(name: string): boolean {
  return EXPLORE_TOOLS.has(name)
}

const EXPLORE_DISPLAY: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'List',
  glob: 'Glob',
  grep: 'Search',
  web_search: 'Search',
  web_fetch: 'Fetch',
}

const EXPLORE_UNIT: Record<string, string> = {
  Read: 'file',
  List: 'dir',
  Glob: 'pattern',
  Search: 'query',
  Fetch: 'page',
}

function exploreDisplayName(toolName: string): string {
  return EXPLORE_DISPLAY[toolName] ?? 'Op'
}

function exploreUnit(name: string, count: number): string {
  const singular = EXPLORE_UNIT[name] ?? 'op'
  if (count === 1) return singular
  if (singular.endsWith('y')) return singular.slice(0, -1) + 'ies'
  return singular + 's'
}

function ExploreGroup({
  pairs,
  workDir,
}: {
  pairs: Array<{ call: ToolCallEntry; result: ToolResultEntry | null }>
  workDir?: string
}): JSX.Element {
  const [open, setOpen] = useState(true)

  // Count by display name (matching TUI: Read/List/Glob/Search)
  const counts = new Map<string, number>()
  for (const p of pairs) {
    const tn = ((p.call.meta as Record<string, unknown> | undefined)?.['toolName'] as string) ?? ''
    const name = exploreDisplayName(tn)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const summary = [...counts.entries()]
    .map(([name, count]) => `${name} ${count} ${exploreUnit(name, count)}`)
    .join(', ')

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[15px]"
      >
        <span className="font-medium text-ink-3">Explore</span>
        <span className="text-ink-4">({summary})</span>
        <ChevronRight
          className={cn('h-3 w-3 text-ink-4 transition-transform', open && 'rotate-90')}
          strokeWidth={2}
        />
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-0.5 pl-0.5">
          {pairs.map((p) => (
            <ExploreItem key={p.call.id} call={p.call} result={p.result} workDir={workDir} />
          ))}
        </div>
      )}
    </div>
  )
}

function ExploreItem({
  call,
  result,
  workDir,
}: {
  call: ToolCallEntry
  result: ToolResultEntry | null
  workDir?: string
}): JSX.Element {
  const meta = call.meta as Record<string, unknown> | undefined
  const toolName = (meta?.['toolName'] as string) ?? 'tool'
  const display = call.display ?? toolName
  const isError = (result?.meta as Record<string, unknown> | undefined)?.['isError'] === true

  // Build the description line: "Read file.ts L1-50" / "Grepped pattern in dir"
  const desc = formatExploreDesc(toolName, display, workDir)

  return (
    <div className="text-[15px] leading-[1.6] text-ink-4">
      {desc}
      {isError && ' failed'}
    </div>
  )
}

function formatExploreDesc(toolName: string, display: string, workDir?: string): string {
  const cleaned = shortenSummary(display, workDir)
  // Strip the tool name prefix from display since we add our own verb
  const space = cleaned.indexOf(' ')
  const args = space > 0 ? cleaned.slice(space + 1) : cleaned

  switch (toolName) {
    case 'read_file': {
      // "read_file path" → "Read path"
      // Parse line range if present: "Read file L1-50"
      return `Read ${args}`
    }
    case 'list_dir':
      return `Listed ${args || '.'}`
    case 'glob':
      return `Glob ${args}`
    case 'grep':
      return `Grepped ${args}`
    case 'web_search':
      return `Searched ${args}`
    case 'web_fetch':
      return `Fetched ${args}`
    default:
      return cleaned
  }
}

function pickPrefix(name: string): string {
  if (name === 'grep') return 'Q'
  if (name === 'bash' || name === 'bash_background') return '$'
  if (name === 'edit_file') return '✎'
  if (name === 'write_file') return '+'
  if (name === 'read_file') return '◇'
  if (name === 'list_dir' || name === 'glob') return '⌕'
  if (name === 'web_search' || name === 'web_fetch') return '⊕'
  return '›'
}

function truncateResult(text: string): string {
  // Strip read_file metadata headers like "[Lines 1-25 of 25 | mtime_ms=... | size_bytes=...]"
  let cleaned = text.replace(/^\[Lines? \d+-\d+ of \d+[^\]]*\]\n?/gm, '')
  // Strip write_file result summaries
  cleaned = cleaned.replace(/^OK: Wrote \d+ .+\n?/m, '')
  const lines = cleaned.split('\n')
  if (lines.length <= 60) return cleaned
  const head = lines.slice(0, 40).join('\n')
  const tail = lines.slice(-15).join('\n')
  return `${head}\n\n  … ${lines.length - 55} lines hidden …\n\n${tail}`
}
