/**
 * Lightweight markdown renderer using `marked` with default rendering.
 *
 * Styling is applied via descendant CSS selectors in globals.css under
 * `.markdown-body`. Code blocks get post-render Shiki highlighting which
 * is folded back into the rendered HTML so that subsequent re-renders
 * (very frequent during streaming) don't wipe the highlights.
 */

import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import { cn } from '@/lib/cn.js'
import { highlightCode } from '@/lib/shiki.js'

marked.setOptions({
  gfm: true,
  breaks: false,
  pedantic: false,
})

const CODE_BLOCK_RE = /<pre><code class="language-([a-zA-Z0-9_+-]+)">([\s\S]*?)<\/code><\/pre>/g

export function Markdown({
  text,
  className,
}: {
  text: string
  className?: string
}): JSX.Element {
  const baseHtml = useMemo(() => {
    try {
      return marked.parse(text, { async: false }) as string
    } catch {
      return escape(text)
    }
  }, [text])

  // Cache: codeText|lang -> highlighted innerHTML.
  const [highlightCache, setHighlightCache] = useState<Map<string, string>>(
    () => new Map(),
  )

  // Build the final HTML by replacing each <pre><code> with its highlighted
  // version (if cached). Unhighlighted blocks render plain until Shiki
  // resolves and triggers a re-render.
  const html = useMemo(() => {
    return baseHtml.replace(
      CODE_BLOCK_RE,
      (match, lang: string, body: string) => {
        const decoded = decodeHtml(body).replace(/\n$/, '')
        const cached = highlightCache.get(`${lang}|${decoded}`)
        if (cached) {
          return `<pre><code class="language-${lang}" data-highlighted="1">${cached}</code></pre>`
        }
        return match
      },
    )
  }, [baseHtml, highlightCache])

  // After render, find any unhighlighted code blocks and request highlighting.
  // Results go into `highlightCache` which triggers a re-render.
  useEffect(() => {
    const matches = [...baseHtml.matchAll(CODE_BLOCK_RE)]
    if (matches.length === 0) return
    const pending = matches.filter((m) => {
      const lang = m[1] ?? 'text'
      const decoded = decodeHtml(m[2] ?? '').replace(/\n$/, '')
      return !highlightCache.has(`${lang}|${decoded}`)
    })
    if (pending.length === 0) return
    let stillMounted = true
    void Promise.all(
      pending.map(async (m) => {
        const lang = m[1] ?? 'text'
        const decoded = decodeHtml(m[2] ?? '').replace(/\n$/, '')
        const key = `${lang}|${decoded}`
        try {
          const highlighted = await highlightCode(decoded, lang)
          if (!stillMounted || !highlighted) return null
          return [key, highlighted] as const
        } catch {
          return null
        }
      }),
    ).then((results) => {
      if (!stillMounted) return
      const updates = results.filter((r): r is readonly [string, string] => r !== null)
      if (updates.length === 0) return
      setHighlightCache((prev) => {
        const next = new Map(prev)
        for (const [k, v] of updates) next.set(k, v)
        return next
      })
    })
    return () => {
      stillMounted = false
    }
  }, [baseHtml, highlightCache])

  return (
    <div
      className={cn('markdown-body', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function decodeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
