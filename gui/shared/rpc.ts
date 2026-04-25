/**
 * Shared types for the Fermi GUI ↔ subprocess JSON-RPC.
 *
 * Mirrors src/server/rpc-transport.ts. Used by both the Electron main process
 * (which talks to the subprocess) and the renderer (which talks to main via
 * the preload bridge).
 */

export interface RpcEvent {
  readonly tabId: string
  readonly method: string
  readonly params?: unknown
}

export interface SessionTab {
  readonly tabId: string
  readonly workDir: string
  readonly sessionId: string | null
  readonly title: string | null
  readonly displayName: string | null
  readonly selectedModel: string | null
  readonly modelProvider: string | null
  readonly createdAt: number
  readonly status: 'starting' | 'ready' | 'error' | 'closed'
  readonly errorMessage?: string
}

export interface CreateTabInput {
  readonly workDir: string
  readonly selectedModel?: string
  readonly selectedAgent?: string
}

export interface SessionMeta {
  readonly title: string | undefined
  readonly displayName: string
  readonly sessionDir: string | null
  readonly workDir: string
  readonly modelConfigName: string
  readonly modelProvider: string
  readonly thinkingLevel: string
  readonly accentColor: string | undefined
  readonly turnCount: number
}

export interface SessionStatus {
  readonly currentTurnRunning: boolean
  readonly sessionPhase: string
  readonly lastTurnEndStatus: string | null
  readonly pendingInboxCount: number
  readonly lifetimeToolCallCount: number
  readonly lastToolCallSummary: string
  readonly lastInputTokens: number
  readonly lastTotalTokens: number
  readonly lastCacheReadTokens: number
  readonly contextBudget: number
  readonly activeLogEntryId: string | null
  readonly hasPendingTurn: boolean
}

export interface ModelDescriptor {
  readonly name: string
  readonly provider: string
  readonly model: string
  readonly contextLength: number
  readonly supportsThinking: boolean
  readonly supportsMultimodal: boolean
}
