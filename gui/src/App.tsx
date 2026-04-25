import { useEffect } from 'react'
import { Sidebar } from '@/components/Sidebar.js'
import { SessionPane } from '@/components/SessionPane.js'
import { EmptyState } from '@/components/EmptyState.js'
import { RightPane } from '@/components/RightPane.js'
import { CommandPalette } from '@/components/CommandPalette.js'
import { useSessionStore } from '@/state/sessionStore.js'

export function App(): JSX.Element {
  const init = useSessionStore((s) => s.init)
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)

  useEffect(() => {
    void init()
  }, [init])

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null

  return (
    <div className="flex h-full flex-col bg-pane">
      {/* Invisible drag region for macOS titlebar — Electron's hiddenInset
          handles the actual traffic lights; we just need the drag area. */}
      <div className="titlebar-drag h-9 shrink-0" />

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTab ? (
            <SessionPane key={activeTab.tabId} tab={activeTab} />
          ) : (
            <EmptyState />
          )}
        </main>
        {activeTab && <RightPane key={activeTab.tabId} tab={activeTab} />}
      </div>
      <CommandPalette />
    </div>
  )
}
