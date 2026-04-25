import { contextBridge, ipcRenderer } from 'electron'
import type { CreateTabInput, RpcEvent, SessionTab } from '../shared/rpc.js'

const api = {
  tabs: {
    list: (): Promise<readonly SessionTab[]> => ipcRenderer.invoke('tabs:list'),
    create: (input: CreateTabInput): Promise<SessionTab> => ipcRenderer.invoke('tabs:create', input),
    close: (tabId: string): Promise<void> => ipcRenderer.invoke('tabs:close', tabId),
  },
  rpc: {
    request: <T = unknown>(tabId: string, method: string, params?: unknown): Promise<T> =>
      ipcRenderer.invoke('rpc:request', { tabId, method, params }),
    onEvent: (handler: (e: RpcEvent) => void): (() => void) => {
      const listener = (_: unknown, e: RpcEvent) => handler(e)
      ipcRenderer.on('rpc:event', listener)
      return () => ipcRenderer.removeListener('rpc:event', listener)
    },
  },
  workspace: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('workspace:pickDirectory'),
  },
  theme: {
    getSystem: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('theme:getSystem'),
    onSystemChanged: (handler: (theme: 'dark' | 'light') => void): (() => void) => {
      const listener = (_: unknown, t: 'dark' | 'light') => handler(t)
      ipcRenderer.on('theme:systemChanged', listener)
      return () => ipcRenderer.removeListener('theme:systemChanged', listener)
    },
  },
}

contextBridge.exposeInMainWorld('fermi', api)

export type FermiApi = typeof api
