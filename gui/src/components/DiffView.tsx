/**
 * Render a unified-diff-style display field as a styled diff card.
 *
 * Vigil's write_file/edit_file tool emits a `display` of the form:
 *
 *      --- /abs/path/file.ts
 *      +++ /abs/path/file.ts
 *      @@ -A,B +C,D @@
 *    N +added line
 *    N  context line
 *    N -removed line
 *
 * We parse this into hunks and render +/- with green/red gutter colors,
 * line numbers, and a path header.
 */

import { useMemo } from 'react'
import { FileEdit, FilePlus2 } from 'lucide-react'
import { cn } from '@/lib/cn.js'
import { relToWorkspace } from '@/lib/path.js'

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  lineNo: string // numeric or empty
  text: string
}

interface ParsedDiff {
  fromPath: string
  toPath: string
  lines: DiffLine[]
  isNewFile: boolean
}

const HUNK_RE = /^\s*@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/
const LINE_RE = /^\s*(\d+)?\s*([+\- ])(.*)$/

function parseDiff(text: string): ParsedDiff | null {
  const lines = text.split('\n')
  let fromPath = ''
  let toPath = ''
  const out: DiffLine[] = []
  let inHeader = true
  let isNewFile = false
  for (const raw of lines) {
    if (inHeader) {
      const fromMatch = raw.match(/^\s*---\s+(.+)$/)
      const toMatch = raw.match(/^\s*\+\+\+\s+(.+)$/)
      if (fromMatch) {
        fromPath = (fromMatch[1] ?? '').trim()
        continue
      }
      if (toMatch) {
        toPath = (toMatch[1] ?? '').trim()
        continue
      }
      if (HUNK_RE.test(raw)) {
        inHeader = false
        // Detect new file via "@@ -1,0" / "@@ -0,0" signatures
        if (/-(?:0|1),0\s/.test(raw)) isNewFile = true
        out.push({ kind: 'hunk', lineNo: '', text: raw.trim() })
        continue
      }
      // not a known header line — treat the whole text as plain
      return null
    } else {
      if (HUNK_RE.test(raw)) {
        out.push({ kind: 'hunk', lineNo: '', text: raw.trim() })
        continue
      }
      const m = raw.match(LINE_RE)
      if (!m) {
        if (raw.length === 0) continue
        out.push({ kind: 'ctx', lineNo: '', text: raw })
        continue
      }
      const ln = m[1] ?? ''
      const sign = m[2] ?? ' '
      const body = m[3] ?? ''
      out.push({
        kind: sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx',
        lineNo: ln,
        text: body,
      })
    }
  }
  if (out.length === 0) return null
  return { fromPath, toPath, lines: out, isNewFile }
}

export function DiffView({
  text,
  workDir,
  isError,
  resultSummary,
}: {
  text: string
  workDir?: string
  isError: boolean
  resultSummary?: string
}): JSX.Element | null {
  const parsed = useMemo(() => parseDiff(text), [text])
  if (!parsed) return null

  const path = parsed.toPath || parsed.fromPath
  const display = workDir ? relToWorkspace(path, workDir) : path
  const Icon = parsed.isNewFile ? FilePlus2 : FileEdit
  const stats = useMemo(() => {
    let adds = 0
    let dels = 0
    for (const l of parsed.lines) {
      if (l.kind === 'add') adds++
      else if (l.kind === 'del') dels++
    }
    return { adds, dels }
  }, [parsed])

  return (
    <div
      className={cn(
        'mt-1.5 overflow-hidden rounded-md border bg-code-bg',
        isError ? 'border-error/30' : 'border-line-soft',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line-soft/60 bg-pane-2/40">
        <Icon className={cn('h-3.5 w-3.5', parsed.isNewFile ? 'text-success' : 'text-ink-3')} />
        <span className="font-mono text-[11.5px] text-ink-2 truncate">{display}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10.5px]">
          {stats.adds > 0 && <span className="text-success">+{stats.adds}</span>}
          {stats.dels > 0 && <span className="text-error">−{stats.dels}</span>}
          {parsed.isNewFile && (
            <span className="rounded-full border border-success/40 bg-success/10 px-1.5 py-px text-[9.5px] uppercase tracking-wider text-success">
              new
            </span>
          )}
        </span>
      </div>

      {/* Body */}
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full border-collapse font-mono text-[11.5px]">
          <tbody>
            {parsed.lines.map((line, i) => {
              if (line.kind === 'hunk') {
                return (
                  <tr key={i}>
                    <td colSpan={3} className="px-3 py-1 bg-pane-2/30 text-[10.5px] text-ink-3">
                      {line.text}
                    </td>
                  </tr>
                )
              }
              const tone =
                line.kind === 'add'
                  ? 'bg-success/10 text-ink'
                  : line.kind === 'del'
                    ? 'bg-error/10 text-ink-2'
                    : ''
              const sign =
                line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
              const signColor =
                line.kind === 'add'
                  ? 'text-success'
                  : line.kind === 'del'
                    ? 'text-error'
                    : 'text-ink-3'
              return (
                <tr key={i} className={cn('group', tone)}>
                  <td className="select-none pl-3 pr-2 text-right text-[10.5px] text-ink-3 align-top">
                    {line.lineNo}
                  </td>
                  <td className={cn('select-none pr-1.5 text-center align-top', signColor)}>
                    {sign}
                  </td>
                  <td className="pr-3 align-top whitespace-pre">{line.text}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Footer with summary if provided */}
      {resultSummary && (
        <div className="border-t border-line-soft/60 bg-pane-2/30 px-3 py-1 text-[10.5px] text-ink-3 truncate">
          {resultSummary}
        </div>
      )}
    </div>
  )
}
