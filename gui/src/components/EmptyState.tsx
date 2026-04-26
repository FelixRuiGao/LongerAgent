/**
 * Empty state: clean, minimal, no decorative elements.
 */
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
    <div className="flex h-full items-center justify-center bg-pane">
      <div className="flex flex-col items-center text-center">
        <div className="text-[44px] font-semibold tracking-tight text-ink">
          Fermi
        </div>
        <p className="mt-3 max-w-[340px] text-[15px] leading-[1.65] text-ink-3">
          Open a workspace to begin a session. Each runs in
          its own subprocess.
        </p>
        <button
          onClick={start}
          disabled={creating}
          className={cn(
            'mt-7 rounded-xl border border-line bg-pane-2 px-5 py-2.5 text-[15px] font-medium text-ink transition',
            'hover:border-line hover:bg-line-soft',
            creating && 'opacity-50',
          )}
        >
          {creating ? 'Opening…' : 'Open a workspace'}
        </button>
        <div className="mt-4 text-[13px] text-ink-4">
          ⌘N new session · ⌘K commands
        </div>
      </div>
    </div>
  )
}
