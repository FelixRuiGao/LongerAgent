import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
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
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <div className="font-display text-[48px] leading-none text-fg italic">
          Fermi
        </div>
        <p className="mt-4 text-[13.5px] leading-relaxed text-fg-3">
          A long-session coding agent.
          <br />
          Open a workspace to start a new session — each
          <br />
          session runs in its own subprocess.
        </p>
        <button
          onClick={start}
          disabled={creating}
          className={cn(
            'ring-focus group mt-8 inline-flex items-center gap-2.5 rounded-full px-5 py-2.5',
            'text-[12.5px] font-medium tracking-wide transition',
            'border border-border-strong bg-bg-1 text-fg',
            'hover:bg-bg-2 hover:border-accent/40',
            creating && 'opacity-50',
          )}
        >
          <span>Open a workspace</span>
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </div>
  )
}
