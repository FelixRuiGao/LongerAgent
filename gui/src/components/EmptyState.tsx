import { useState } from 'react'
import { useSessionStore } from '@/state/sessionStore.js'
import { api } from '@/lib/api.js'
import { cn } from '@/lib/cn.js'

export function EmptyState(): JSX.Element {
  const createTab = useSessionStore((s) => s.createTab)
  const [creating, setCreating] = useState(false)

  const start = async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    try {
      const dir = await api.workspace.pickDirectory()
      if (dir) await createTab(dir)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      {/* Faint starfield decoration — single layer, low contrast */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'radial-gradient(1px 1px at 14% 22%, rgba(255,255,255,0.55), transparent 50%),' +
            'radial-gradient(1px 1px at 71% 18%, rgba(255,255,255,0.45), transparent 50%),' +
            'radial-gradient(1px 1px at 33% 76%, rgba(255,255,255,0.40), transparent 50%),' +
            'radial-gradient(1px 1px at 88% 64%, rgba(255,255,255,0.50), transparent 50%),' +
            'radial-gradient(1px 1px at 8% 60%, rgba(255,255,255,0.30), transparent 50%),' +
            'radial-gradient(1px 1px at 56% 40%, rgba(255,255,255,0.35), transparent 50%),' +
            'radial-gradient(1.5px 1.5px at 47% 88%, rgba(196,180,255,0.55), transparent 50%),' +
            'radial-gradient(1.5px 1.5px at 22% 12%, rgba(196,180,255,0.45), transparent 50%),' +
            'radial-gradient(1px 1px at 92% 88%, rgba(255,255,255,0.30), transparent 50%)',
        }}
      />

      <div className="relative flex flex-col items-center text-center">
        {/* Eyebrow */}
        <div className="mb-5 inline-flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-fg-3">
          <span className="h-px w-6 bg-border-strong" />
          <span>Long-session coding agent</span>
          <span className="h-px w-6 bg-border-strong" />
        </div>

        {/* Wordmark */}
        <div className="font-display text-[88px] leading-[0.95] italic text-fg">
          Fermi
        </div>

        {/* Subtitle */}
        <p className="mt-5 max-w-[380px] text-[13px] leading-[1.7] text-fg-2">
          Open a workspace to begin a session. Each runs in
          its own subprocess — many can run in parallel.
        </p>

        {/* CTA */}
        <button
          onClick={start}
          disabled={creating}
          className={cn(
            'group ring-focus mt-8 inline-flex items-center gap-2 overflow-hidden rounded-full',
            'border border-border-strong px-5 py-2 text-[12px] font-medium text-fg transition',
            'hover:border-accent/50 hover:bg-accent-soft',
            creating && 'opacity-50',
          )}
        >
          <span className="relative">
            <span className={cn(creating ? 'shimmer-text' : '')}>
              {creating ? 'Opening…' : 'Open a workspace'}
            </span>
          </span>
          <span className="text-fg-3 transition group-hover:translate-x-0.5 group-hover:text-fg">
            →
          </span>
        </button>

        {/* Footnote */}
        <div className="mt-7 font-mono text-[10.5px] text-muted">
          ⌘N new session · ⌘K commands
        </div>
      </div>
    </div>
  )
}
