import { Sun, Moon } from 'lucide-react'
import { useSessionStore } from '@/state/sessionStore.js'
import { cn } from '@/lib/cn.js'
import { shortPath } from '@/lib/path.js'

export function TitleBar(): JSX.Element {
  const theme = useSessionStore((s) => s.theme)
  const setTheme = useSessionStore((s) => s.setTheme)
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.tabId === activeTabId)

  return (
    <header className="titlebar-drag relative flex h-9 shrink-0 items-center justify-center bg-transparent">
      <div className="titlebar-nodrag absolute left-20 flex h-full items-center gap-2.5 text-[12px] tracking-wide text-fg-3">
        <span className="font-display text-[13px] italic text-fg-2">Fermi</span>
        {activeTab?.workDir && (
          <>
            <span className="text-muted">·</span>
            <span className="font-mono text-[11px] text-fg-3" title={activeTab.workDir}>
              {shortPath(activeTab.workDir)}
            </span>
          </>
        )}
      </div>
      <div className="titlebar-nodrag absolute right-3 flex h-full items-center gap-1">
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded text-fg-3 transition',
            'hover:bg-bg-1 hover:text-fg',
          )}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
      </div>
    </header>
  )
}

