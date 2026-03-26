/**
 * Typed IPC channel definitions shared by main and renderer processes.
 *
 * Session-scoped channels take `sessionId` as first argument.
 * Global channels (models, store, providers) do not.
 */

// ------------------------------------------------------------------
// Session state
// ------------------------------------------------------------------

export type SessionState =
  | "idle"
  | "thinking"
  | "tool_calling"
  | "asking"
  | "cancelling";

// ------------------------------------------------------------------
// Model / Token info
// ------------------------------------------------------------------

export interface ModelInfo {
  name: string;
  provider: string;
  model: string;
  contextLength: number;
  supportsThinking: boolean;
  supportsMultimodal: boolean;
}

export interface CurrentModelDisplay {
  configName?: string;
  providerId: string;
  selectionKey: string;
  modelId: string;
  brandKey: string;
  brandLabel: string;
  providerLabel: string;
  modelLabel: string;
  modelDetailedLabel: string;
  scopedLabel: string;
  scopedDetailedLabel: string;
  note?: string;
}

export interface TokenInfo {
  inputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  contextBudget?: number;
}

export interface SessionSummary {
  turnCount: number;
  compactCount: number;
  createdAt: string;
  currentModel: string;
  currentModelDisplay?: CurrentModelDisplay | null;
}

// ------------------------------------------------------------------
// Conversation entry (matches TUI ConversationEntry)
// ------------------------------------------------------------------

export type ConversationEntryKind =
  | "user"
  | "assistant"
  | "interrupted_marker"
  | "progress"
  | "sub_agent_rollup"
  | "sub_agent_done"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "status"
  | "error"
  | "compact_mark";

export interface ConversationEntry {
  id?: string;
  kind: ConversationEntryKind;
  text: string;
  startedAt?: number;
  elapsedMs?: number;
  queued?: boolean;
  dim?: boolean;
  meta?: Record<string, unknown>;
}

// ------------------------------------------------------------------
// Preferences / Skills / MCP types
// ------------------------------------------------------------------

export interface SessionPreferences {
  thinkingLevel: string;
  thinkingLevels: string[];
  contextRatio: number;
  accentColor: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  enabled: boolean;
}

export interface McpStatusInfo {
  servers: Array<{
    name: string;
    toolCount: number;
    tools: string[];
  }>;
  totalTools: number;
}

// ------------------------------------------------------------------
// Model tree (hierarchical model picker)
// ------------------------------------------------------------------

export interface ModelTreeNode {
  kind?: "group" | "provider" | "vendor" | "model" | "action";
  id?: string;
  label: string;
  value: string;
  note?: string;
  isCurrent: boolean;
  credentialState?: "configured" | "missing" | "oauth_missing" | "not_required";
  keyMissing: boolean;
  keyHint?: string;
  brandKey?: string;
  brandLabel?: string;
  providerId?: string;
  selectionKey?: string;
  modelId?: string;
  children?: ModelTreeNode[];
}

// ------------------------------------------------------------------
// Active session info (for registry context)
// ------------------------------------------------------------------

export interface ActiveSessionInfo {
  sessionId: string;
  projectPath: string;
  sessionPath: string | undefined;
  state: SessionState;
  title: string;
  currentModel: string;
  currentModelDisplay?: CurrentModelDisplay | null;
}

// ------------------------------------------------------------------
// Invoke channels (renderer -> main, request/response)
// ------------------------------------------------------------------

export interface InvokeChannels {
  // ---- Session lifecycle (new) ----
  "session:create": {
    args: [projectPath: string];
    result: { sessionId: string };
  };
  "session:destroy": {
    args: [sessionId: string];
    result: void;
  };
  "session:setForeground": {
    args: [sessionId: string];
    result: void;
  };
  "session:listActive": {
    args: [];
    result: ActiveSessionInfo[];
  };
  "session:loadIntoNew": {
    args: [sessionPath: string, projectPath: string];
    result: { sessionId: string };
  };

  // ---- Session-scoped (require sessionId as first arg) ----
  "session:turn": {
    args: [sessionId: string, input: string];
    result: string;
  };
  "session:cancel": {
    args: [sessionId: string];
    result: void;
  };
  "session:interrupt": {
    args: [sessionId: string];
    result: { accepted: boolean; reason?: string };
  };
  "session:resume": {
    args: [sessionId: string];
    result: string;
  };
  "session:close": {
    args: [sessionId: string];
    result: void;
  };
  "session:reset": {
    args: [sessionId: string];
    result: void;
  };
  "session:switchModel": {
    args: [sessionId: string, modelConfigName: string];
    result: void;
  };
  "session:getState": {
    args: [sessionId: string];
    result: { state: SessionState; summary: SessionSummary; currentModel: string; currentModelDisplay: CurrentModelDisplay | null; cwd: string };
  };
  "session:deliverMessage": {
    args: [sessionId: string, content: string];
    result: void;
  };
  "ask:resolve": {
    args: [sessionId: string, askId: string, decision: unknown];
    result: void;
  };
  "command:execute": {
    args: [sessionId: string, name: string, argStr: string];
    result: { success: boolean; error?: string; messages?: string[] };
  };
  "session:getPreferences": {
    args: [sessionId: string];
    result: SessionPreferences;
  };
  "session:setPreference": {
    args: [sessionId: string, key: string, value: unknown];
    result: void;
  };
  "session:compact": {
    args: [sessionId: string, instruction: string];
    result: void;
  };
  "session:summarize": {
    args: [sessionId: string, instruction: string];
    result: void;
  };

  // ---- Global (no sessionId) ----
  "session:getModels": {
    args: [];
    result: ModelInfo[];
  };
  "session:getModelTree": {
    args: [sessionId: string];
    result: ModelTreeNode[];
  };
  "session:getProviderKeyStatus": {
    args: [];
    result: unknown;
  };
  "session:setProviderKey": {
    args: [providerId: string, apiKey: string];
    result: { success: boolean; envVar: string };
  };
  "session:importProviderKey": {
    args: [providerId: string, externalEnvVar: string];
    result: { success: boolean; envVar: string };
  };
  "session:discoverLocalModels": {
    args: [providerId: string];
    result: { baseUrl: string; models: unknown[] };
  };
  "session:configureLocalProvider": {
    args: [providerId: string, config: { baseUrl: string; model: string; contextLength: number }];
    result: { success: boolean };
  };
  "session:getSkills": {
    args: [];
    result: SkillInfo[];
  };
  "session:setSkillEnabled": {
    args: [skillName: string, enabled: boolean];
    result: void;
  };
  "session:getMcpStatus": {
    args: [];
    result: McpStatusInfo;
  };
  "command:list": {
    args: [];
    result: Array<{ name: string; description: string }>;
  };

  // ---- Store (global) ----
  "store:listSessions": {
    args: [];
    result: Array<{ path: string; created: string; summary: string; title?: string; turns: number }>;
  };
  "store:listProjects": {
    args: [];
    result: Array<{ slug: string; originalPath: string; lastActiveAt: string }>;
  };
  "store:listProjectSessions": {
    args: [projectPath: string];
    result: Array<{ path: string; created: string; summary: string; title?: string; turns: number }>;
  };
  "store:renameSession": {
    args: [sessionPath: string, newTitle: string];
    result: { success: boolean; error?: string };
  };
  "store:deleteSession": {
    args: [sessionPath: string];
    result: { success: boolean; error?: string };
  };
  "store:archiveSession": {
    args: [sessionPath: string];
    result: { success: boolean; error?: string };
  };
  "store:unarchiveSession": {
    args: [sessionPath: string];
    result: { success: boolean; error?: string };
  };
  "store:listArchivedSessions": {
    args: [projectPath: string];
    result: Array<{ path: string; created: string; summary: string; title?: string; turns: number }>;
  };
  "store:getProjectOrder": {
    args: [];
    result: string[];
  };
  "store:setProjectOrder": {
    args: [order: string[]];
    result: void;
  };

  // ---- Shell / FS / Dialog (global) ----
  "shell:openExternal": {
    args: [url: string];
    result: void;
  };
  "fs:listDir": {
    args: [dirPath: string];
    result: string[];
  };
  "dialog:openFile": {
    args: [];
    result: string | null;
  };
  "dialog:openFolder": {
    args: [];
    result: string | null;
  };
}

// ------------------------------------------------------------------
// Event channels (main -> renderer, push)
// ------------------------------------------------------------------

export interface EventChannels {
  "log:updated": {
    sessionId: string;
    entries: ConversationEntry[];
  };
  "progress:event": {
    sessionId: string;
    step: number;
    agent: string;
    action: string;
    message: string;
    level: string;
    timestamp: number;
    usage: Record<string, number>;
    extra: Record<string, unknown>;
  };
  "ask:pending": {
    sessionId: string;
    ask: {
      id: string;
      kind: string;
      createdAt: string;
      summary: string;
      source: Record<string, unknown>;
      payload: Record<string, unknown>;
      options: string[];
    } | null;
  };
  "session:stateChanged": {
    sessionId: string;
    state: SessionState;
  };
  "session:foregroundChanged": {
    sessionId: string;
    projectPath: string;
  };
  "session:created": {
    sessionId: string;
    projectPath: string;
  };
  "session:destroyed": {
    sessionId: string;
  };
  "token:update": {
    sessionId: string;
  } & TokenInfo;
  "session:modelChanged": {
    sessionId: string;
    model: string;
    display: CurrentModelDisplay | null;
  };
  "sidebar:refresh": void;
}

// ------------------------------------------------------------------
// ElectronAPI (exposed via preload)
// ------------------------------------------------------------------

export interface ElectronAPI {
  invoke<K extends keyof InvokeChannels>(
    channel: K,
    ...args: InvokeChannels[K]["args"]
  ): Promise<InvokeChannels[K]["result"]>;

  on<K extends keyof EventChannels>(
    channel: K,
    callback: (data: EventChannels[K]) => void,
  ): () => void;

  off<K extends keyof EventChannels>(
    channel: K,
    callback: (...args: unknown[]) => void,
  ): void;
}

// ------------------------------------------------------------------
// Global window augmentation
// ------------------------------------------------------------------

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
