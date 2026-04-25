/**
 * Renderer-side typed wrapper over the preload bridge.
 * The preload script exposes `window.fermi`; we re-export it here with types
 * so the rest of the codebase can import a single api object.
 */
import type { CreateTabInput, RpcEvent, SessionTab } from '@shared/rpc.js'

interface FermiApi {
  tabs: {
    list(): Promise<readonly SessionTab[]>
    create(input: CreateTabInput): Promise<SessionTab>
    close(tabId: string): Promise<void>
  }
  rpc: {
    request<T = unknown>(tabId: string, method: string, params?: unknown): Promise<T>
    onEvent(handler: (e: RpcEvent) => void): () => void
  }
  workspace: {
    pickDirectory(): Promise<string | null>
  }
  theme: {
    getSystem(): Promise<'dark' | 'light'>
    onSystemChanged(handler: (theme: 'dark' | 'light') => void): () => void
  }
}

declare global {
  interface Window {
    fermi: FermiApi
  }
}

export const api: FermiApi = window.fermi
