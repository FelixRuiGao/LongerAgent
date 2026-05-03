/**
 * Multi-turn conversation session with context management.
 *
 * Provides the Session class — the core runtime orchestrator.
 * Manages the Primary Agent's conversation,
 * auto-compact, and sub-agent lifecycle.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  unlinkSync,
  rmdirSync,
  rmSync,
  renameSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { getFermiHomeDir } from "./home-path.js";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
// child_process — now only used by BackgroundShellManager
import * as yaml from "js-yaml";
import { countTokens as gptCountTokens, encode as gptEncode } from "gpt-tokenizer/model/gpt-5";


import { loadTemplate, validateTemplate, assembleSystemPrompt } from "./templates/loader.js";

import { Agent, isNoReply, NO_REPLY_MARKER } from "./agents/agent.js";
import type {
  ToolLoopResult,
  ToolExecutor,
  ToolPreflightContext,
  ToolPreflightDecision,
  ResolveToolCallVisibilityCallback,
} from "./agents/tool-loop.js";
import { createEphemeralLogState } from "./ephemeral-log.js";
import { isCompactMarker, allocateContextId, stripContextTags, ContextTagStripBuffer } from "./context-rendering.js";
import { generateShowContext } from "./show-context.js";
import { getThinkingLevels, getHighestThinkingLevel, getModelMaxOutputTokens, type Config, type ModelConfig } from "./config.js";
import type { MCPClientManager } from "./mcp-client.js";
import { ProgressEvent, type ProgressLevel, type ProgressReporter } from "./progress.js";
import { ToolResult } from "./providers/base.js";
import type { ToolDef } from "./providers/base.js";
import {
  SPAWN_TOOL,

  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  AWAIT_EVENT_TOOL,
  SHOW_CONTEXT_TOOL,
  SUMMARIZE_TOOL,
  ASK_TOOL,
  SEND_TOOL,
} from "./tools/comm.js";
import {
  BASH_BACKGROUND_TOOL,
  BASH_OUTPUT_TOOL,
  KILL_SHELL_TOOL,
  executeTool,
} from "./tools/basic.js";
import { applyPatch, parsePatch } from "diff";
import type { FileMutation, BashMutation, BashMutationEntry } from "./tools/basic.js";
import type { RewindPlan, RewindApplyResult, RewindPathMutation, BashRewindEntry } from "./ui/contracts.js";
import { execSummarizeContextOnLog, buildCoveredContextIds } from "./summarize-context.js";
import { resolveSkillContent, loadSkillsMulti, type SkillMeta } from "./skills/loader.js";
import { toolBuiltinWebSearchPassthrough } from "./tools/web-search.js";
import {
  processFileAttachments,
  hasFiles as fileAttachHasFiles,
  hasImages as fileAttachHasImages,
  parseReferences,
} from "./file-attach.js";
import { SafePathError, safePath } from "./security/path.js";
import { parsePlanFile, formatPlanSnapshot, PLAN_FILENAME, type PlanCheckpoint } from "./plan-state.js";
import {
  buildToolExecutors,
  ensureCommTools,
  ensureSkillTool,
  buildSkillToolDef,
  registerMcpTools,
  ToolGate,
  type GateAdvisor,
} from "./tool-runtime.js";
import { BackgroundShellManager } from "./background-shell-manager.js";
import { PermissionAdvisor, PermissionRuleStore, initBashParser, type PermissionMode, type PermissionRule, type ApprovalOffer } from "./permissions/index.js";
import { HookRuntime, type HookEvent, type HookPayload } from "./hooks/index.js";
import type { HookManifest } from "./hooks/types.js";
import { assembleFullSystemPrompt } from "./prompt-assembler.js";
import {
  argOptionalString,
  argRequiredString,
  argRequiredStringArray,
  toolArgError,
} from "./tools/arg-helpers.js";
import {
  AskPendingError,
  ASK_CUSTOM_OPTION_LABEL,
  ASK_DISCUSS_FURTHER_GUIDANCE,
  ASK_DISCUSS_OPTION_LABEL,
  isAskPendingError,
  toPendingAskUi,
  type AgentQuestion,
  type AgentQuestionItem,
  type AgentQuestionAnswer,
  type AgentQuestionDecision,
  type ApprovalRequest,
  type AskAuditRecord,
  type AskRequest,
  type PendingAskUi,
  type PendingTurnState,
} from "./ask.js";
import {
  LogIdAllocator,
  type LogEntry,
  createSystemPrompt,
  createTurnStart,
  type TurnKind,
  createTurnEnd,
  createUserMessage as createUserMessageEntry,
  createAgentResult,
  createAssistantText,
  createReasoning,
  createToolCall,
  createToolResult as createToolResultEntry,
  createNoReply,
  createCompactMarker,
  createCompactContext,
  createSummary,
  createStatus,
  createError as createErrorEntry,
  createTokenUpdate,
  createAskRequest,
  createAskResolution,
} from "./log-entry.js";
import { projectToApiMessages, projectToTuiEntries } from "./log-projection.js";
import {
  archiveWindow,
  createGlobalTuiPreferences,
  createLogSessionMeta,
  loadLog,
  saveLog,
  validateAndRepairLog,
  type GlobalTuiPreferences,
  type LoadLogResult,
  type LogSessionMeta,
  type FermiSettings,
  type ModelSelectionState,
} from "./persistence.js";
import {
  CHILD_SESSION_CAPABILITIES,
  ROOT_SESSION_CAPABILITIES,
  type SessionCapabilities,
} from "./session-capabilities.js";
import type {
  ArchivedChildRecord,
  ChildSessionLifecycle,
  ChildSessionMetaRecord,
  ChildSessionMode,
  ChildSessionOutcome,
  ChildSessionPhase,
  ChildSessionSnapshot,
  MessageEnvelope,
  MessageType,
} from "./session-tree-types.js";
import {
  resolveAgentModelEntry,
  resolveModelTierEntry,
  resolvePersistedModelSelection,
  type PersistedModelSelection,
} from "./model-selection.js";
import { describeModel } from "./model-presentation.js";
import {
  type ContextThresholds,
  DEFAULT_THRESHOLDS,
  computeHysteresisThresholds,
} from "./settings.js";
// ------------------------------------------------------------------
// Message migration helper (old AgentMessage → MessageEnvelope)
// ------------------------------------------------------------------

function migrateMessageEnvelope(raw: Record<string, unknown>): MessageEnvelope {
  // New format already — pass through
  if (raw.type && typeof raw.type === "string" &&
      ["user_input", "peer_message", "system_notice"].includes(raw.type as string)) {
    return raw as unknown as MessageEnvelope;
  }
  // Old format: { from, to, content, timestamp }
  const from = (raw.from as string) ?? "system";
  let type: MessageType = "system_notice";
  if (from === "user") type = "user_input";
  else if (from === "main") type = "user_input";
  else if (from === "system") type = "system_notice";
  else type = "peer_message"; // agent name
  return {
    type,
    sender: from,
    content: (raw.content as string) ?? "",
    timestamp: (raw.timestamp as number) ?? 0,
  };
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const MAX_ACTIVATIONS_PER_TURN = 30;
const SUB_AGENT_OUTPUT_LIMIT = 12_000;
const SUB_AGENT_TIMEOUT = 600_000; // milliseconds
const MAX_COMPACT_PHASE_ROUNDS = 10;       // max activations during compact phase

// -- Compact Prompt: Output scenario --
const COMPACT_PROMPT_OUTPUT = `Condense this conversation into a continuation prompt — imagine you're writing a briefing for a fresh instance of yourself who must seamlessly pick up where we left off, with zero access to the original conversation.

**Before writing the continuation prompt**, make sure any stable, long-term knowledge from this session has been written to AGENTS.md if it belongs there.

**What the new instance will already have:** your system prompt and AGENTS.md persistent memory are automatically re-injected after compact. Do not duplicate their contents in the continuation prompt — focus on what they don't cover: current progress, session-specific context, and in-flight work state.

Your summary should capture everything that matters and nothing that doesn't. Use whatever structure best fits the actual content — there is no fixed template. But as you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's intent, goals, and any constraints or preferences they've expressed — stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and *why*.
- **Where exactly are we?** What's done, what's in progress, what's next. Be specific enough that work won't be repeated or skipped.
- **What artifacts exist?** Files read, created, or modified — with enough context about each to be actionable (not just a path list).
- **What tone/style/working relationship has been established?** If the user has shown preferences for how they like to collaborate, note them.
- **What explicit rules has the user stated?** Direct instructions about how to work, what not to do, approval requirements, or behavioral constraints the user has explicitly communicated (e.g., "don't modify code until I approve", "always run tests before committing"). Preserve these verbatim — they are binding rules, not suggestions.

**Err on the side of preserving more, not less.** The continuation prompt is the sole bridge between this conversation and the next — anything omitted is permanently lost to the new instance. Include all information that could plausibly be useful for subsequent work: partial findings, open questions, code snippets you'll need to reference, relevant file paths with context. A longer, thorough continuation prompt that preserves useful context is far better than a terse one that forces the new instance to re-discover things.

Write in natural prose. Use structure where it aids clarity, not for its own sake.`;

// -- Compact Prompt: Tool Call scenario --
const COMPACT_PROMPT_TOOLCALL = `[SYSTEM: COMPACT REQUIRED] The conversation has exceeded the context limit. Do NOT continue the task. Instead, produce a **continuation prompt** — a briefing that will allow a fresh instance of you (with no access to this conversation) to seamlessly resume the work.

You just made a tool call and received its result above. That result is real and should be reflected in your summary, but do not act on it — your only job right now is to write the continuation prompt.

**Before writing the continuation prompt**, make sure any stable, long-term knowledge from this session has been written to AGENTS.md if it belongs there.

**What the new instance will already have:** your system prompt and AGENTS.md persistent memory are automatically re-injected after compact. Do not duplicate their contents in the continuation prompt — focus on what they don't cover: current progress, session-specific context, and in-flight work state.

Write in natural prose. Use structure where it aids clarity, not for its own sake. As you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's intent, goals, constraints, and preferences — stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and why.
- **Where exactly did we stop?** Be precise: what was the last tool call, what did it return, and what was supposed to happen next? The new instance must be able to pick up mid-step without repeating or skipping anything.
- **What's done, what's in progress, what remains?** Give a clear picture of overall progress, not just the interrupted step.
- **What artifacts exist?** Files read, created, or modified — with enough context about each to be actionable.
- **What working style has the user shown?** Communication preferences, collaboration patterns, or explicit instructions about how they like to work.
- **What explicit rules has the user stated?** Direct instructions about how to work, what not to do, approval requirements, or behavioral constraints (e.g., "don't modify code until I approve", "always run tests before committing"). Preserve these verbatim — they are binding rules, not suggestions.

**Err on the side of preserving more, not less.** The continuation prompt is the sole bridge between this conversation and the next — anything omitted is permanently lost to the new instance. Include all information that could plausibly be useful for subsequent work: partial findings, open questions, code snippets you'll need to reference, relevant file paths with context. A longer, thorough continuation prompt that preserves useful context is far better than a terse one that forces the new instance to re-discover things.

End the summary with a clear, imperative statement of what the next instance should do first upon resuming.`;

// -- Compact Prompt: Sub-agent (output scenario) --
const SUB_AGENT_COMPACT_PROMPT_OUTPUT = `Your context is full. Write a continuation summary so a fresh instance of you can resume this task seamlessly.

Capture:
- **Task**: What you were asked to do and any constraints.
- **Progress**: What's done, what's in progress, what remains.
- **Key findings**: Discoveries, file paths, code references, decisions — anything the next instance needs to avoid re-doing work.
- **Next step**: What to do first upon resuming.

Be thorough — include all information that could be useful. The next instance has no access to this conversation.`;

// -- Compact Prompt: Sub-agent (tool call scenario) --
const SUB_AGENT_COMPACT_PROMPT_TOOLCALL = `[SYSTEM: COMPACT REQUIRED] Your context is full. Do NOT continue the task. Write a continuation summary instead.

You just made a tool call and received its result above. Reflect that result in your summary, but do not act on it further.

Capture:
- **Task**: What you were asked to do and any constraints.
- **Progress**: What's done, what's in progress, what remains.
- **Last action**: What tool call you just made, what it returned, and what you planned to do next.
- **Key findings**: Discoveries, file paths, code references, decisions — anything the next instance needs to avoid re-doing work.
- **Next step**: What to do first upon resuming.

Be thorough — include all information that could be useful. The next instance has no access to this conversation.`;

function appendManualInstruction(
  basePrompt: string,
  instruction: string | undefined,
  kind: "summarize" | "compact",
): string {
  const trimmed = instruction?.trim();
  if (!trimmed) return basePrompt;
  return `${basePrompt}\n\nAdditional user instruction for this manual ${kind} request:\n${trimmed}`;
}

// -- Hint Prompt generators (two-tier) --
function HINT_LEVEL1_PROMPT(pct: string): string {
  return `[SYSTEM: Context usage has reached ${pct}. Consider freeing space: call \`show_context\` first to see the distribution, then call \`summarize\` to compress groups you no longer need in full. Prioritize: completed subtasks, large tool results you've already extracted key info from, and exploratory steps that led to a conclusion. Always inspect with show_context before summarizing. After summarizing, continue your work normally.]`;
}

function HINT_LEVEL2_PROMPT(pct: string): string {
  return `[SYSTEM: Context usage has reached ${pct} — auto-compact will trigger soon. You should act now: call \`show_context\` to see the distribution, then immediately call \`summarize\` to compress older groups. Prioritize: completed subtasks, large tool results, and exploratory steps. Do not skip the show_context step. After summarizing, continue your work.]`;
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

const SYSTEM_PREFIXES = [
  "[AUTO-COMPACT]",
  "[Context After Auto-Compact]",
  "[MASTER PLAN:",
  "[PHASE PLAN:",
  "[SUB-AGENT UPDATE]",
  "[SESSION INTERRUPTED]",
  "[SKILL:",
];

const COMM_TOOL_NAMES = new Set([
  "spawn", "kill_agent", "check_status", "await_event", "show_context", "summarize", "ask", "skill",
  "bash_background", "bash_output", "kill_shell", "send",
]);

const SAFE_INTERRUPT_TOOLS = new Set([
  "ask",
  "check_status",
  "summarize",
  "glob",
  "grep",
  "kill_agent",
  "list_dir",
  "read_file",
  "send",
  "show_context",
  "skill",
  "spawn",
  "time",
  "await_event",
  "web_fetch",
  "web_search",
  "bash_output",
]);

// ------------------------------------------------------------------
// InlineImageInput — clipboard / drag-drop image passed to turn()
// ------------------------------------------------------------------

export interface InlineImageInput {
  id: string;
  base64: string;
  mediaType: string;
}

// ------------------------------------------------------------------
// MessageEnvelope — typed message envelope (see session-tree-types.ts)
// ------------------------------------------------------------------


// ------------------------------------------------------------------
// ChildSessionHandle — tracked nested child session state
// ------------------------------------------------------------------

interface ChildSessionHandle {
  id: string;
  numericId: number;
  template: string;
  mode: ChildSessionMode;
  lifecycle: ChildSessionLifecycle;
  status: "working" | "idle" | "error" | "interrupted" | "terminated" | "completed";
  phase: ChildSessionPhase;
  session: Session;
  sessionDir: string;
  artifactsDir: string;
  resultText: string;
  elapsed: number;
  startTime: number;
  turnPromise: Promise<string> | null;
  abortController: AbortController | null;
  recentEvents: string[];
  lifetimeToolCallCount: number;
  lastToolCallSummary: string;
  lastTotalTokens: number;
  lastOutcome: ChildSessionOutcome;
  lastActivityAt: number;
  order: number;
  /** Set by suspendAllChildSessions / archiveAllChildSessions to prevent zombie _finishChildTurn callbacks. */
  suspended: boolean;
  /** Resolve when _finishChildTurn completes. Created in _startChildTurn, resolved in _finishChildTurn. */
  settlePromise: Promise<void> | null;
  settleResolve: (() => void) | null;
  terminationCause?: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt";
}


// BackgroundShellEntry — moved to ./background-shell-manager.ts

interface PreparedChildRestore {
  record: ChildSessionMetaRecord;
  agent: Agent;
  sessionDir: string;
  artifactsDir: string;
  loaded: LoadLogResult;
}

interface PreparedSessionRestore {
  rootState: Session;
  children: PreparedChildRestore[];
  archivedRecords?: ArchivedChildRecord[];
  rootInbox?: MessageEnvelope[];
  warnings: string[];
}

// ------------------------------------------------------------------
// NoReplyStreamBuffer
// ------------------------------------------------------------------

class NoReplyStreamBuffer {
  private static readonly MARKER = "<NO_REPLY>";
  private static readonly MARKER_LEN = 10;

  private _downstream: (chunk: string) => void;
  private _buffer = "";
  private _phase: "detect" | "forwarding" | "suppressed" = "detect";
  detectedNoReply = false;

  constructor(downstream: (chunk: string) => void) {
    this._downstream = downstream;
  }

  feed(chunk: string): void {
    if (this._phase === "forwarding") {
      this._downstream(chunk);
      return;
    }
    if (this._phase === "suppressed") {
      return;
    }

    this._buffer += chunk;
    const stripped = this._buffer.trimStart();

    if (stripped && !stripped.startsWith("<")) {
      this._flushAndForward();
      return;
    }

    if (stripped.length < NoReplyStreamBuffer.MARKER_LEN) {
      if (stripped && !NoReplyStreamBuffer.MARKER.startsWith(stripped)) {
        this._flushAndForward();
      }
      return;
    }

    if (stripped.startsWith(NoReplyStreamBuffer.MARKER)) {
      this.detectedNoReply = true;
      this._buffer = "";
      this._phase = "suppressed";
    } else {
      this._flushAndForward();
    }
  }

  private _flushAndForward(): void {
    this._phase = "forwarding";
    if (this._buffer) {
      this._downstream(this._buffer);
      this._buffer = "";
    }
  }
}

// ------------------------------------------------------------------
// Session
// ------------------------------------------------------------------

export class Session {
  primaryAgent: Agent;
  config: Config;
  agentTemplates: Record<string, Agent>;
  private _promptsDirs?: string[];

  _progress?: ProgressReporter;
  private _mcpManager?: MCPClientManager;
  private _mcpConnected = false;

  /** Tool permission gate — add advisors to control tool execution. */
  readonly toolGate = new ToolGate();

  /** Permission advisor — classifies tools and enforces permission mode. */
  private _permissionAdvisor!: PermissionAdvisor;
  private _permissionRuleStore!: PermissionRuleStore;

  /** Hook runtime — fires events and evaluates hook commands. */
  readonly hookRuntime = new HookRuntime();

  _createdAt: string;
  private _title: string | undefined;
  private _cachedSummary: string | undefined;

  // Structured log (v2 architecture — dual-array transition)
  private _log: LogEntry[] = [];
  private _logRevision = 0;
  private _idAllocator = new LogIdAllocator();
  private _logListeners = new Set<() => void>();

  // Token tracking
  private _lastInputTokens = 0;
  private _lastTotalTokens = 0;
  private _lastCacheReadTokens = 0;

  // Compact phase
  private _compactInProgress = false;

  // Context thresholds (from settings.json, or defaults)
  private _thresholds: ContextThresholds = { ...DEFAULT_THRESHOLDS };
  private _hintResetNone = DEFAULT_THRESHOLDS.context_hint_level1 / 100 - 0.20;
  private _hintResetLevel1 = (DEFAULT_THRESHOLDS.context_hint_level1 + DEFAULT_THRESHOLDS.context_hint_level2) / 200;

  // Context window multiplier (0.0–1.0). Effective context = contextLength × _contextRatio.
  private _contextRatio = 1.0;

  // Hint compression (two-tier state machine)
  private _hintState: "none" | "level1_sent" | "level2_sent" = "none";

  // show_context: number of remaining rounds where annotations are active
  private _showContextRoundsRemaining = 0;
  private _showContextAnnotations: Map<string, string> | null = null;

  // /summarize tool whitelist mode
  private _summarizeToolWhitelist: Set<string> | null = null;

  // Pending summary entries to flush after tool_result is appended
  private _pendingSummaryEntries: LogEntry[] = [];

  // Skills
  private _skills = new Map<string, SkillMeta>();
  private _skillRoots: string[] = [];
  private _disabledSkills = new Set<string>();

  // Cached system prompt (static between reloads for prompt cache stability)
  private _cachedSystemPrompt: string | null = null;

  // Artifacts / persistence
  private _store: any;

  // Path variables
  private _projectRoot: string;
  private _sessionArtifactsOverride: string;
  private _systemData: string;

  // Plan state (parsed from {SESSION_ARTIFACTS}/plan.md)
  private _planState: PlanCheckpoint[] = [];
  private _planListeners: (() => void)[] = [];

  // Session tree / child sessions
  private _childSessions = new Map<string, ChildSessionHandle>();
  private _archivedChildren = new Map<string, ArchivedChildRecord>();
  private _subAgentCounter = 0;
  private _shellManager!: BackgroundShellManager;

  // Session capabilities / routing
  private _capabilities: SessionCapabilities = ROOT_SESSION_CAPABILITIES;
  private _statusSource?: () => ChildSessionSnapshot[];
  private _turnOutputTarget?: (text: string) => void;
  private _deferQueuedMessageInjectionOnTurnExit = false;
  private _selfPhase: ChildSessionPhase = "idle";
  private _lifetimeToolCallCount = 0;
  private _lastToolCallSummary = "";
  private _recentSessionEvents: string[] = [];

  // Active entry tracker — tracks which log entry is currently "live"
  private _activeLogEntryId: string | null = null;

  /** Update the active entry tracker; implicitly marks previous reasoning as complete. */
  private _setActiveLogEntry(entryId: string | null): void {
    if (this._activeLogEntryId === entryId) return;
    // If the previous active entry was a reasoning entry, mark it complete
    if (this._activeLogEntryId) {
      const prevEntry = this._log.find((e) => e.id === this._activeLogEntryId);
      if (prevEntry && prevEntry.type === "reasoning") {
        (prevEntry.meta as Record<string, unknown>).reasoningComplete = true;
      }
    }
    this._activeLogEntryId = entryId;
    this._touchLog();
  }
  private _lastTurnEndStatus: "completed" | "interrupted" | "error" | null = null;

  // Thinking level + accent
  private _persistedModelSelection: PersistedModelSelection = {};
  private _preferredThinkingLevel = "";
  private _preferredAccentColor?: string;
  private _thinkingLevel = "none";

  /** Stable key for OpenAI prompt cache routing affinity. */
  private _promptCacheKey: string;

  // Agent runtime state (for message delivery mode selection)
  private _agentState: "working" | "idle" | "waiting" = "idle";

  // Inbox: holds messages for push delivery into tool results.
  // Typed message inbox — all messages flow through _deliverMessage.
  private _inbox: MessageEnvelope[] = [];
  private _currentTurnSignal: AbortSignal | null = null;
  private _currentTurnAbortController: AbortController | null = null;

  // Turn serialization — prevents concurrent turn() calls from corrupting state
  private _turnInFlight: Promise<string | void> | null = null;
  private _turnRelease: (() => void) | null = null;

  /** Callback for incremental persistence — called at save-worthy checkpoints. */
  onSaveRequest?: () => void;

  // Counters
  _turnCount = 0;
  _compactCount = 0;
  private _usedContextIds = new Set<string>();

  // Tool executors
  private _toolExecutors: Record<string, ToolExecutor>;
  private _toolExecutorOverrides: Record<string, ToolExecutor> = {};

  // Ask state
  private _activeAsk: AskRequest | null = null;
  private _askHistory: AskAuditRecord[] = [];
  private _pendingTurnState: PendingTurnState | null = null;

  /** Allocate a unique random hex context ID. */
  private _allocateContextId(): string {
    return allocateContextId(this._usedContextIds);
  }

  private _setSelfPhase(phase: ChildSessionPhase): void {
    this._selfPhase = phase;
  }

  private _recordSessionEvent(summary: string): void {
    const text = summary.trim();
    if (!text) return;
    this._recentSessionEvents.push(text);
    if (this._recentSessionEvents.length > 5) {
      this._recentSessionEvents.shift();
    }
  }

  get pendingInboxCount(): number {
    return this._inbox.length;
  }

  get sessionPhase(): ChildSessionPhase {
    return this._selfPhase;
  }

  get permissionMode(): PermissionMode {
    return this._permissionAdvisor.sessionMode;
  }

  set permissionMode(mode: PermissionMode) {
    this._permissionAdvisor.sessionMode = mode;
    for (const handle of this._childSessions.values()) {
      handle.session.permissionMode = mode;
    }
  }

  get permissionRuleStore(): PermissionRuleStore {
    return this._permissionRuleStore;
  }

  get permissionAdvisor(): PermissionAdvisor {
    return this._permissionAdvisor;
  }

  get lifetimeToolCallCount(): number {
    return this._lifetimeToolCallCount;
  }

  get lastToolCallSummary(): string {
    return this._lastToolCallSummary;
  }

  get recentSessionEvents(): readonly string[] {
    return this._recentSessionEvents;
  }

  get currentTurnRunning(): boolean {
    return this._turnInFlight !== null;
  }

  get lastTurnEndStatus(): "completed" | "interrupted" | "error" | null {
    return this._lastTurnEndStatus;
  }

  getChildSessionSnapshots(): ChildSessionSnapshot[] {
    return [...this._childSessions.values()]
      .map((handle) => this._buildChildSessionSnapshot(handle))
      .sort((a, b) => {
        const rank = (snapshot: ChildSessionSnapshot): number => {
          if (snapshot.lifecycle === "running") return 0;
          if (snapshot.lifecycle === "blocked") return 1;
          if (snapshot.lifecycle === "idle") return 2;
          if (snapshot.lifecycle === "archived") return 3;
          return 3;
        };
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
        return a.numericId - b.numericId;
      });
  }

  getChildSessionLog(childId: string): readonly LogEntry[] | null {
    const handle = this._childSessions.get(childId);
    return handle ? handle.session.log : null;
  }

  private _isLiveChild(handle: ChildSessionHandle): boolean {
    return handle.lifecycle === "running" || handle.lifecycle === "blocked";
  }

  private _getStatusSourceSnapshots(): ChildSessionSnapshot[] {
    if (this._statusSource) {
      return this._statusSource();
    }
    return this.getChildSessionSnapshots();
  }

  private _buildChildSessionSnapshot(handle: ChildSessionHandle): ChildSessionSnapshot {
    const session = handle.session;
    const currentTurnRunning = typeof (session as any).currentTurnRunning === "boolean"
      ? (session as any).currentTurnRunning as boolean
      : handle.status === "working";
    const sessionPhase = typeof (session as any).sessionPhase === "string"
      ? (session as any).sessionPhase as ChildSessionPhase
      : handle.phase;
    const sessionLastTurnEndStatus = (session as any).lastTurnEndStatus as "completed" | "interrupted" | "error" | null | undefined;
    const lifetimeToolCallCount = typeof (session as any).lifetimeToolCallCount === "number"
      ? (session as any).lifetimeToolCallCount as number
      : handle.lifetimeToolCallCount;
    const lastTotalTokens = typeof (session as any).lastTotalTokens === "number"
      ? (session as any).lastTotalTokens as number
      : handle.lastTotalTokens;
    const lastToolCallSummary = typeof (session as any).lastToolCallSummary === "string"
      ? (session as any).lastToolCallSummary as string
      : handle.lastToolCallSummary;
    const recentEventsSource = Array.isArray((session as any).recentSessionEvents)
      ? (session as any).recentSessionEvents as string[]
      : handle.recentEvents;
    const pendingInboxCount = typeof (session as any).pendingInboxCount === "number"
      ? (session as any).pendingInboxCount as number
      : 0;
    const logRevision = typeof (session as any).getLogRevision === "function"
      ? (session as any).getLogRevision() as number
      : 0;
    const pendingAsk = typeof (session as any).getPendingAsk === "function"
      ? (session as any).getPendingAsk() as PendingAskUi | null
      : null;
    const hasPendingResume = typeof (session as any).hasPendingTurnToResume === "function"
      ? Boolean((session as any).hasPendingTurnToResume())
      : false;
    const phase = pendingAsk || hasPendingResume
      ? "waiting"
      : currentTurnRunning
        ? sessionPhase
        : "idle";
    const modelConfig = session.primaryAgent?.modelConfig;
    const modelDescriptor = modelConfig
      ? describeModel({
          configName: modelConfig.name,
          providerId: modelConfig.provider,
          selectionKey: modelConfig.model,
          modelId: modelConfig.model,
        })
      : null;
    const outcome =
      handle.lastOutcome !== "none"
        ? handle.lastOutcome
        : sessionLastTurnEndStatus === "completed"
          ? "completed"
          : sessionLastTurnEndStatus === "interrupted"
            ? "interrupted"
            : sessionLastTurnEndStatus === "error"
              ? "error"
              : "none";
    return {
      id: handle.id,
      numericId: handle.numericId,
      logRevision,
      template: handle.template,
      mode: handle.mode,
      lifecycle: handle.lifecycle,
      phase,
      outcome,
      running: currentTurnRunning,
      lifetimeToolCallCount,
      lastTotalTokens,
      lastToolCallSummary,
      recentEvents: [...recentEventsSource],
      pendingInboxCount,
      lastActivityAt: handle.lastActivityAt,
      // Child page chrome fields
      inputTokens: session.lastInputTokens,
      contextBudget: session.contextBudget,
      modelConfigName: modelConfig?.name ?? "",
      modelProvider: modelConfig?.provider ?? "",
      modelDisplayLabel: modelDescriptor?.scopedLabel ?? modelConfig?.model ?? "",
      pendingAskId: pendingAsk?.id ?? null,
      pendingAskKind: pendingAsk?.kind ?? null,
      activeLogEntryId: session.activeLogEntryId,
      turnElapsed: handle.startTime > 0 && currentTurnRunning
        ? (performance.now() - handle.startTime) / 1000
        : handle.elapsed,
      cacheReadTokens: session.lastCacheReadTokens,
    };
  }

  private _buildSubSessionBrief(): string {
    const snapshots = this._getStatusSourceSnapshots();
    if (snapshots.length === 0) return "No sub-sessions.";
    const lines = snapshots
      .filter((snapshot) =>
        snapshot.lifecycle === "running"
        || snapshot.lifecycle === "blocked"
        || snapshot.lifecycle === "idle"
        || snapshot.outcome !== "none"
      )
      .map((snapshot) => {
        const tools = `${snapshot.lifetimeToolCallCount} tool${snapshot.lifetimeToolCallCount === 1 ? "" : "s"}`;
        const tokens = snapshot.lastTotalTokens > 0 ? formatTokenCount(snapshot.lastTotalTokens) : "0";
        const latest = snapshot.lastToolCallSummary
          || snapshot.recentEvents[snapshot.recentEvents.length - 1]
          || (snapshot.outcome !== "none" ? snapshot.outcome : "no recent activity");
        return `- ${snapshot.id}: ${tools}, ${tokens} tokens. Latest: \`${latest}\``;
      });
    return lines.length > 0 ? lines.join("\n") : "No sub-sessions.";
  }

  private _buildDetailedChildStatusReport(): string {
    const snapshots = this.getChildSessionSnapshots();
    if (snapshots.length === 0) return "No sub-sessions tracked.";
    const sections = snapshots.map((snapshot) => {
      const recent = snapshot.recentEvents.length > 0
        ? snapshot.recentEvents.map((event, index) => `  ${index + 1}. ${event}`).join("\n")
        : "  (none)";
      const latest = snapshot.lastToolCallSummary || snapshot.recentEvents[snapshot.recentEvents.length - 1] || "(none)";
      return [
        `- ${snapshot.id}`,
        `  mode: ${snapshot.mode}`,
        `  lifecycle: ${snapshot.lifecycle}`,
        `  phase: ${snapshot.phase}`,
        `  outcome: ${snapshot.outcome}`,
        `  tokens: ${formatTokenCount(snapshot.lastTotalTokens)}`,
        `  tool calls: ${snapshot.lifetimeToolCallCount}`,
        `  pending inbox: ${snapshot.pendingInboxCount}`,
        `  latest: ${latest}`,
        `  recent:`,
        recent,
      ].join("\n");
    });
    return sections.join("\n\n");
  }

  constructor(opts: {
    primaryAgent: Agent;
    config: Config;
    agentTemplates?: Record<string, Agent>;
    skills?: Map<string, SkillMeta>;
    skillRoots?: string[];
    progress?: ProgressReporter;
    mcpManager?: MCPClientManager;
    promptsDirs?: string[];
    store?: any;
    contextRatio?: number;
    projectRoot?: string;
    sessionArtifactsDir?: string;
    capabilities?: SessionCapabilities;
    statusSource?: () => ChildSessionSnapshot[];
    onTurnOutput?: (text: string) => void;
    toolExecutorOverrides?: Record<string, ToolExecutor>;
    deferQueuedMessageInjectionOnTurnExit?: boolean;
    /** Stable key for OpenAI prompt cache routing affinity. Auto-generated if omitted. */
    promptCacheKey?: string;
    /** Permission mode for this session. Default: "reversible". */
    permissionMode?: PermissionMode;
    /** Shared rule store for child sessions. If omitted, a new store is created. */
    permissionRuleStore?: PermissionRuleStore;
    /** Pre-loaded hook manifests. Each session keeps its own runtime; hooks are copied in. */
    hooks?: readonly HookManifest[];
  }) {
    this.primaryAgent = opts.primaryAgent;
    // Default thinking level: highest available for this model (or "none" for non-thinking).
    // Resolves once at construction so the field is consistent before any setter call.
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      "",
    );
    this.config = opts.config;
    this.agentTemplates = opts.agentTemplates ?? {};
    this._skills = opts.skills ?? new Map();
    this._skillRoots = opts.skillRoots ?? [];
    this._progress = opts.progress;
    this._mcpManager = opts.mcpManager;
    this._promptsDirs = opts.promptsDirs;
    this._capabilities = opts.capabilities ?? ROOT_SESSION_CAPABILITIES;
    this._statusSource = opts.statusSource;
    this._turnOutputTarget = opts.onTurnOutput;
    this._toolExecutorOverrides = opts.toolExecutorOverrides ?? {};
    this._deferQueuedMessageInjectionOnTurnExit = opts.deferQueuedMessageInjectionOnTurnExit ?? false;

    // Apply context ratio
    if (opts.contextRatio !== undefined) {
      this._contextRatio = Math.max(0.01, Math.min(1.0, opts.contextRatio));
    }

    // Attach store if provided (must be set before _initConversation)
    if (opts.store) {
      this._store = opts.store;
    }

    // Resolve path variables
    this._projectRoot = opts.projectRoot ?? process.cwd();
    this._sessionArtifactsOverride = opts.sessionArtifactsDir ?? "";
    this._systemData = "";
    this._shellManager = new BackgroundShellManager({
      projectRoot: this._projectRoot,
      getSessionArtifactsDir: () => this._resolveSessionArtifacts(),
      deliverMessage: (msg) => this._deliverMessage(msg),
    });

    // Permission system
    this._permissionRuleStore = opts.permissionRuleStore ?? new PermissionRuleStore({
      projectStoreDir: this._store?.projectDir ?? this._projectRoot,
      workspaceRoot: this._projectRoot,
    });
    this._permissionAdvisor = new PermissionAdvisor({
      ruleStore: this._permissionRuleStore,
      sessionMode: opts.permissionMode ?? "reversible",
      projectRoot: this._projectRoot,
    });
    this.toolGate.addAdvisor(this._permissionAdvisor);

    this._createdAt = new Date().toISOString();
    this._promptCacheKey = opts.promptCacheKey ?? randomUUID();
    if (opts.hooks && opts.hooks.length > 0) {
      this.hookRuntime.setHooks([...opts.hooks]);
    }
    this._initConversation();
    this._toolExecutors = this._buildToolExecutors();
    this._ensureCommTools();
    this._ensureSkillTool();
    this._persistedModelSelection = this._buildPersistedModelSelection();
    this._updateInitialTokenEstimate();

    // Init tree-sitter bash parser (async, non-blocking)
    initBashParser();

    // Fire SessionStart hook (fire-and-forget)
    this.hookRuntime.fireAndForget("SessionStart", {
      event: "SessionStart",
      timestamp: Date.now(),
    });
  }

  private _buildPersistedModelSelection(
    overrides?: Partial<PersistedModelSelection>,
  ): PersistedModelSelection {
    return {
      modelConfigName: this.currentModelConfigName || undefined,
      modelProvider: this.primaryAgent.modelConfig.provider || undefined,
      modelSelectionKey: this.primaryAgent.modelConfig.model || undefined,
      modelId: this.primaryAgent.modelConfig.model || undefined,
      ...overrides,
    };
  }

  setPersistedModelSelection(selection: Partial<PersistedModelSelection>): void {
    this._persistedModelSelection = this._buildPersistedModelSelection(selection);
  }

  // ==================================================================
  // Initialisation helpers
  // ==================================================================

  _initConversation(): void {
    this._createdAt = new Date().toISOString();
    this._title = undefined;
    this._cachedSummary = undefined;
    this._log = [];
    this._logRevision = 0;
    this._idAllocator = new LogIdAllocator();

    // Assemble system prompt and cache it for prompt cache stability
    this._reloadPromptAndTools();
    this._appendEntry(
      createSystemPrompt(this._nextLogId("system_prompt"), this._cachedSystemPrompt!),
      false,
    );
    this._updateInitialTokenEstimate();
    this._notifyLogListeners();
  }

  /**
   * Effective context length for a given ModelConfig, scaled by context ratio.
   */
  _effectiveContextLength(mc: ModelConfig): number {
    return Math.round(mc.contextLength * this._contextRatio);
  }

  // ==================================================================
  // Message infrastructure
  // ==================================================================

  /**
   * Append a LogEntry to the structured log.
   * Auto-triggers save request and notifies log listeners.
   */
  private _appendEntry(entry: LogEntry, save = true): void {
    this._log.push(entry);
    this._bumpLogRevision();
    this._notifyLogListeners();
    if (save) this.onSaveRequest?.();
  }

  private _touchLog(): void {
    this._bumpLogRevision();
    this._notifyLogListeners();
  }

  private _bumpLogRevision(): void {
    this._logRevision += 1;
  }

  private _notifyLogListeners(): void {
    for (const listener of this._logListeners) {
      listener();
    }
  }

  /** Allocate the next log entry ID for a given type. */
  private _nextLogId(type: LogEntry["type"]): string {
    return this._idAllocator.next(type);
  }

  /** Compute the next roundIndex for the current turn based on existing entries. */
  private _computeNextRoundIndex(): number {
    let maxRound = -1;
    for (let i = this._log.length - 1; i >= 0; i--) {
      const e = this._log[i];
      if (e.turnIndex !== this._turnCount) break;
      if (e.roundIndex !== undefined && e.roundIndex > maxRound) {
        maxRound = e.roundIndex;
      }
    }
    return maxRound + 1;
  }

  private _findRoundContextId(turnIndex: number, roundIndex: number): string | undefined {
    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.turnIndex < turnIndex) break;
      if (entry.discarded) continue;
      if (entry.turnIndex !== turnIndex) continue;
      if (entry.roundIndex !== roundIndex) continue;
      const contextId = (entry.meta as Record<string, unknown>)["contextId"];
      if (typeof contextId === "string" && contextId.trim()) {
        return contextId;
      }
    }
    return undefined;
  }

  /**
   * Find the most recent user-side contextId by scanning backward through the log.
   * "User-side" means entries with apiRole "user" or "tool_result" that carry a contextId.
   * Used for context ID inheritance: text-only final rounds inherit this ID.
   */
  private _findPrecedingUserSideContextId(): string | undefined {
    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.discarded) continue;
      if (entry.apiRole === "user" || entry.apiRole === "tool_result") {
        const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
        if (typeof ctxId === "string" && ctxId.trim()) {
          return ctxId;
        }
      }
    }
    return undefined;
  }

  private _roundHasToolCalls(turnIndex: number, roundIndex: number): boolean {
    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.turnIndex < turnIndex) break;
      if (entry.discarded) continue;
      if (entry.turnIndex !== turnIndex) continue;
      if (entry.roundIndex !== roundIndex) continue;
      if (entry.type === "tool_call" && entry.apiRole === "assistant") return true;
    }
    return false;
  }

  private _resolveOutputRoundContextId(turnIndex: number, roundIndex: number): string {
    const roundContextId = this._findRoundContextId(turnIndex, roundIndex);
    if (this._roundHasToolCalls(turnIndex, roundIndex)) {
      return roundContextId ?? this._allocateContextId();
    }
    return this._findPrecedingUserSideContextId() ?? roundContextId ?? this._allocateContextId();
  }

  private _retagRoundEntries(turnIndex: number, roundIndex: number, contextId: string): void {
    let changed = false;
    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.turnIndex < turnIndex) break;
      if (entry.discarded) continue;
      if (entry.turnIndex !== turnIndex) continue;
      if (entry.roundIndex !== roundIndex) continue;
      if (
        entry.type !== "assistant_text" &&
        entry.type !== "reasoning" &&
        entry.type !== "tool_call" &&
        entry.type !== "tool_result" &&
        entry.type !== "no_reply"
      ) {
        continue;
      }
      if ((entry.meta as Record<string, unknown>)["contextId"] === contextId) continue;
      (entry.meta as Record<string, unknown>)["contextId"] = contextId;
      changed = true;
    }
    if (changed) this._touchLog();
  }

  private _findToolCallContextId(toolCallId: string, roundIndex?: number): string | undefined {
    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.turnIndex < this._turnCount) break;
      if (entry.discarded) continue;
      if (entry.type !== "tool_call") continue;
      if (entry.turnIndex !== this._turnCount) continue;
      const meta = entry.meta as Record<string, unknown>;
      if (String(meta["toolCallId"] ?? "") !== toolCallId) continue;
      const contextId = meta["contextId"];
      if (typeof contextId === "string" && contextId.trim()) {
        return contextId;
      }
      break;
    }
    if (typeof roundIndex === "number") {
      return this._findRoundContextId(this._turnCount, roundIndex);
    }
    return undefined;
  }

  // ------------------------------------------------------------------
  // Unified message delivery (v2 architecture)
  // ------------------------------------------------------------------

  /**
   * Unified message delivery entry point.
   * All states push to inbox. Idle state also schedules auto-resume.
   * Working/waiting: the activation boundary or await_event poll drains.
   */
  private _deliverMessage(msg: MessageEnvelope): void {
    this._inbox.push(msg);
    if (this._agentState === "idle") {
      this._scheduleAutoResume();
    }
  }

  /**
   * Public wrapper for TUI / GUI to deliver messages.
   * Preserves the original (source, content) signature for external callers.
   */
  deliverMessage(source: "user" | "system", content: string): void {
    this._deliverMessage({
      type: source === "user" ? "user_input" : "system_notice",
      sender: source,
      content,
      timestamp: Date.now(),
    });
  }

  private _autoResumeScheduled = false;

  /**
   * Schedule an auto-resume turn for the idle state. Used when messages arrive
   * (sub-agent completion, shell exit, etc.) while the parent agent has no
   * active turn. Without this, the queued messages would sit in the log
   * unprocessed until the user manually starts a new turn.
   */
  private _scheduleAutoResume(): void {
    if (this._autoResumeScheduled) return;
    if (this._activeAsk) return;
    if (this._pendingTurnState) return;
    this._autoResumeScheduled = true;
    queueMicrotask(() => {
      this._autoResumeScheduled = false;
      void this._autoResumeFromIdle().catch(() => { /* swallow — caller doesn't await */ });
    });
  }

  /**
   * Run a turn that drains queued messages without taking new user input.
   * Acquires the turn lock to serialize with normal turn() calls.
   */
  private async _autoResumeFromIdle(): Promise<void> {
    await this._withTurnLock(async () => {
      if (this._agentState !== "idle") return;
      if (this._activeAsk) return;
      if (this._pendingTurnState) return;
      // Skip if there's nothing to process: no inbox messages AND no recent
      // user_message entry awaiting a response.
      if (this._inbox.length === 0 && !this._hasUnprocessedUserMessage()) return;
      await this._turnInner("", { skipUserInput: true });
    });
  }

  /**
   * Scan the log backward to find whether the most recent turn-relevant entry
   * is a user_message that hasn't been responded to (no assistant_text/tool_call/
   * reasoning after it). Used by auto-resume to decide whether to fire a new
   * turn after a finally-block drain wrote messages without the model seeing
   * them.
   */
  private _hasUnprocessedUserMessage(): boolean {
    for (let i = this._log.length - 1; i >= 0; i--) {
      const e = this._log[i];
      if (e.discarded) continue;
      if (e.type === "user_message") return true;
      if (
        e.type === "assistant_text"
        || e.type === "tool_call"
        || e.type === "tool_result"
        || e.type === "reasoning"
        || e.type === "turn_end"
      ) {
        return false;
      }
    }
    return false;
  }

  /**
   * Check whether the inbox has pending messages.
   */
  private _hasInboxMessages(): boolean {
    return this._inbox.length > 0;
  }

  private _hasTrackedShells(): boolean {
    return this._shellManager.hasTrackedShells();
  }

  private _hasRunningShells(): boolean {
    return this._shellManager.hasRunningShells();
  }

  private _buildShellReport(): string {
    return this._shellManager.buildShellReport();
  }

  // ------------------------------------------------------------------
  // Inbox drain — per-entry rendering
  // ------------------------------------------------------------------

  /**
   * Drain the inbox, writing each message as a separate log entry.
   *
   * user_input: If the current turn already has a user_message, the
   *   user_input starts a new turn (turn_start + user_message).  The old
   *   turn is left without a turn_end — this is intentional to avoid a
   *   spurious "worked for Xs" display.  See Docs/SESSION.md §Turn
   *   splitting for the safety analysis.  If the current turn has no
   *   user_message yet (e.g. skipUserInput path), the user_input becomes
   *   the primary message of the current turn.
   *
   * peer_message / system_notice → hidden user_message in current turn.
   */
  private _drainInboxAsEntries(): void {
    if (this._inbox.length === 0) return;
    const messages = [...this._inbox];
    this._inbox = [];

    // Determine whether the current turn already has a primary user_message.
    let currentTurnHasUserMessage = false;
    for (let i = this._log.length - 1; i >= 0; i--) {
      const e = this._log[i];
      if (e.turnIndex < this._turnCount) break;
      if (e.turnIndex !== this._turnCount || e.discarded) continue;
      if (e.type === "user_message") { currentTurnHasUserMessage = true; break; }
    }

    for (const msg of messages) {
      const ctxId = this._allocateContextId();
      switch (msg.type) {
        case "user_input": {
          if (currentTurnHasUserMessage) {
            // Start a new turn for this real user message.
            // No turn_end for the old turn — see docstring above.
            this._turnCount += 1;
            this._appendEntry(
              createTurnStart(this._nextLogId("turn_start"), this._turnCount, "user"),
              false,
            );
          }
          currentTurnHasUserMessage = true;
          this._appendEntry(createUserMessageEntry(
            this._nextLogId("user_message"),
            this._turnCount,
            msg.content,
            msg.content,
            ctxId,
          ), false);
          break;
        }
        case "peer_message": {
          const entry = createUserMessageEntry(
            this._nextLogId("user_message"),
            this._turnCount,
            `[Agent ${msg.sender}]`,
            `<system-message>\n${msg.content}\n</system-message>`,
            ctxId,
          );
          entry.tuiVisible = false;
          this._appendEntry(entry, false);
          break;
        }
        case "system_notice": {
          const display = msg.tuiVisible ? msg.content : "[System]";
          const entry = createUserMessageEntry(
            this._nextLogId("user_message"),
            this._turnCount,
            display,
            `<system-message>\n${msg.content}\n</system-message>`,
            ctxId,
          );
          if (!msg.tuiVisible) entry.tuiVisible = false;
          this._appendEntry(entry, false);
          break;
        }
      }
    }
  }

  private _makeAbortPromise(signal: AbortSignal | null | undefined): Promise<"aborted"> | null {
    if (!signal) return null;
    if (signal.aborted) return Promise.resolve("aborted");
    return new Promise<"aborted">((resolve) => {
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
  }

  private _installCurrentTurnSignal(signal?: AbortSignal): {
    prevSignal: AbortSignal | null;
    prevController: AbortController | null;
    cleanup: () => void;
    signal: AbortSignal;
  } {
    const prevSignal = this._currentTurnSignal;
    const prevController = this._currentTurnAbortController;
    const controller = new AbortController();

    let cleanup = () => {};
    if (signal) {
      if (signal.aborted) {
        controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
      } else {
        const onAbort = () => controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
        signal.addEventListener("abort", onAbort, { once: true });
        cleanup = () => signal.removeEventListener("abort", onAbort);
      }
    }

    this._currentTurnAbortController = controller;
    this._currentTurnSignal = controller.signal;

    // Clear active entry tracker on abort
    controller.signal.addEventListener("abort", () => {
      this._activeLogEntryId = null;
    }, { once: true });

    return {
      prevSignal,
      prevController,
      cleanup,
      signal: controller.signal,
    };
  }

  private _restoreCurrentTurnSignal(state: {
    prevSignal: AbortSignal | null;
    prevController: AbortController | null;
    cleanup: () => void;
  }): void {
    state.cleanup();
    this._currentTurnSignal = state.prevSignal;
    this._currentTurnAbortController = state.prevController;
  }

  // ------------------------------------------------------------------
  // Turn serialization
  // ------------------------------------------------------------------

  /**
   * Wait for any in-flight turn to finish. Safe to call at any time.
   * Used by resetForNewSession, close, and callers that need to ensure
   * the previous turn has fully unwound before proceeding.
   */
  async waitForTurnComplete(): Promise<void> {
    while (this._turnInFlight) {
      try { await this._turnInFlight; } catch { /* ignore errors from aborted turns */ }
    }
  }

  /**
   * Promise-based turn lock. Ensures at most one turn entry point executes
   * at a time. Callers are serialized: if a turn is in flight, the next
   * caller waits for it to finish (which happens quickly after abort).
   */
  private async _withTurnLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForTurnComplete();
    let release!: () => void;
    this._turnInFlight = new Promise<void>((r) => { release = r; });
    this._turnRelease = release;
    try {
      return await fn();
    } finally {
      this._turnInFlight = null;
      this._turnRelease = null;
      release();
    }
  }

  /**
   * Prepare and execute interruption cleanup for the current turn.
   *
   * This captures a non-destructive delivery snapshot first, then kills active
   * workers and drops unconsumed runtime state.
   */
  requestTurnInterrupt(): { accepted: boolean; reason?: "compact_in_progress" } {
    if (this._compactInProgress) {
      return { accepted: false, reason: "compact_in_progress" };
    }

    // Abort main turn ONLY. Sub-agents and background shells are independent
    // background work — they continue running. Explicit Ctrl+X / Ctrl+K
    // kills them separately.
    this._currentTurnAbortController?.abort();
    this._activeAsk = null;
    this._pendingTurnState = null;
    return { accepted: true };
  }

  /**
   * Cascade-kill all running child agents and background shells.
   * Called by TUI on Ctrl+X.
   */
  interruptAllChildAgents(): void {
    if (this._childSessions.size > 0) {
      this._cascadeKillRunningChildren("user_mass_interrupt");
    }
  }

  hasRunningChildAgents(): boolean {
    for (const handle of this._childSessions.values()) {
      if (handle.lifecycle === "running" || handle.lifecycle === "blocked") return true;
    }
    return false;
  }

  killAllShells(): void {
    if (this._shellManager.hasTrackedShells()) {
      this._forceKillAllShells();
    }
  }

  /**
   * If a permission approval or agent_question ask is pending, synthesize
   * Deny/Decline resolution + denial tool_result. Returns true if anything
   * was denied. Called by TUI on ESC/Ctrl+C while a prompt is showing.
   */
  denyPendingAsk(): boolean {
    const ask = this._activeAsk;
    if (!ask) {
      // Find the child that owns the visible ask and deny via routing
      const pendingAsk = this.getPendingAsk();
      if (!pendingAsk) return false;
      const child = this._findChildWithPendingAsk(pendingAsk.id);
      if (!child) return false;
      child.session.denyPendingAsk();
      this._resumeChildPendingTurn(child);
      this._notifyLogListeners();
      this.onSaveRequest?.();
      return true;
    }

    if (ask.kind === "approval") {
      const denyIndex = ask.options.length - 1;
      this._resolveOwnApprovalAsk(ask.id, denyIndex);
      return true;
    }

    // agent_question: synthesize decline resolution + error tool_result.
    this._appendEntry(createAskResolution(
      this._nextLogId("ask_resolution"),
      this._turnCount,
      { declined: true },
      ask.id,
      "agent_question",
    ), false);

    const toolCallId = (ask.payload as Record<string, unknown>)["toolCallId"] as string ?? "ask";
    const contextId = this._findToolCallContextId(toolCallId, ask.roundIndex)
      ?? this._allocateContextId();
    this._appendEntry(createToolResultEntry(
      this._nextLogId("tool_result"),
      this._turnCount,
      ask.roundIndex ?? this._computeNextRoundIndex(),
      {
        toolCallId,
        toolName: "ask",
        content: "ERROR: User declined to answer the question.",
        toolSummary: "ask declined",
      },
      { isError: true, contextId },
    ), false);

    this._askHistory.push({
      askId: ask.id,
      kind: ask.kind,
      summary: ask.summary,
      decidedAt: new Date().toISOString(),
      decision: "declined",
      source: ask.source,
    });
    if (this._askHistory.length > 100) {
      this._askHistory = this._askHistory.slice(-100);
    }

    this._activeAsk = null;
    this._emitAskResolvedProgress(ask.id, "declined", "agent_question");
    this._pendingTurnState = { stage: "activation" };
    this.onSaveRequest?.();
    return true;
  }

  /**
   * Backward-compatible alias.
   */
  cancelCurrentTurn(): void {
    this.requestTurnInterrupt();
  }

  _resetTransientState(): void {
    this._lastInputTokens = 0;
    this._lastTotalTokens = 0;
    this._lastCacheReadTokens = 0;
    this._compactInProgress = false;
    this._hintState = "none";
    this._agentState = "idle";
    this._inbox = [];
    // _waitHandle removed — await_event uses polling now
    this._activeAsk = null;
    this._askHistory = [];
    this._pendingTurnState = null;
    if (this._childSessions.size > 0) {
      this._archiveAllChildSessions();
    }
    if (this._shellManager.hasTrackedShells()) {
      this._forceKillAllShells();
    }
    this._subAgentCounter = 0;
    this._shellManager.resetCounter();
    this._showContextRoundsRemaining = 0;
    this._showContextAnnotations = null;
    this._pendingSummaryEntries = [];
  }

  // ------------------------------------------------------------------
  // Log accessors (v2)
  // ------------------------------------------------------------------

  /** Read-only snapshot of the structured log. */
  get log(): readonly LogEntry[] {
    return this._log;
  }

  getLogRevision(): number {
    return this._logRevision;
  }

  /** The ID of the currently active (streaming/executing) log entry, or null. */
  get activeLogEntryId(): string | null {
    return this._activeLogEntryId;
  }

  /** Subscribe to log changes. Returns an unsubscribe function. */
  subscribeLog(listener: () => void): () => void {
    this._logListeners.add(listener);
    return () => { this._logListeners.delete(listener); };
  }

  // ------------------------------------------------------------------
  // Turn listing (shared by /summarize picker and /rewind picker)
  // ------------------------------------------------------------------

  /**
   * Return metadata for every turn in the log.
   * Each entry includes turnKind (from turn_start meta) and a preview.
   * Callers filter by turnKind, active window, etc.
   */
  listTurns(): Array<{
    turnIndex: number;
    entryIndex: number;
    turnKind: TurnKind;
    preview: string;
    timestamp: number;
    /** Whether this turn is inside the active window (after last compact_marker). */
    inActiveWindow: boolean;
  }> {
    let lastCompactMarkerIdx = -1;
    for (let i = this._log.length - 1; i >= 0; i--) {
      if (this._log[i].type === "compact_marker" && !this._log[i].discarded) {
        lastCompactMarkerIdx = i;
        break;
      }
    }

    const turns: Array<{
      turnIndex: number;
      entryIndex: number;
      turnKind: TurnKind;
      preview: string;
      timestamp: number;
      inActiveWindow: boolean;
    }> = [];

    for (let i = 0; i < this._log.length; i++) {
      const entry = this._log[i];
      if (entry.type !== "turn_start" || entry.discarded) continue;

      const meta = entry.meta as Record<string, unknown>;
      const turnKind = (meta.turnKind as TurnKind) ?? "user";

      let preview = "";
      for (let j = i + 1; j < this._log.length; j++) {
        const next = this._log[j];
        if (next.turnIndex !== entry.turnIndex) break;
        if (next.type === "user_message" && !next.discarded) {
          preview = (next.display || "").replace(/\s+/g, " ").trim().slice(0, 240);
          break;
        }
      }

      turns.push({
        turnIndex: entry.turnIndex,
        entryIndex: i,
        turnKind,
        preview: preview || `(turn ${entry.turnIndex})`,
        timestamp: entry.timestamp,
        inActiveWindow: i > lastCompactMarkerIdx,
      });
    }

    return turns;
  }

  // ------------------------------------------------------------------
  // Rewind
  // ------------------------------------------------------------------

  /**
   * Get the list of turn boundaries available for rewind.
   * Only shows real user turns (not injected/compact/summarize turns).
   * Includes turns before compact markers (rewind undoes compacts).
   * Returns turns in reverse chronological order (most recent first).
   */
  getRewindTargets(): Array<{
    turnIndex: number;
    entryIndex: number;
    preview: string;
    timestamp: number;
    fileCount: number;
    additions: number;
    deletions: number;
    filesReverted: boolean;
  }> {
    const userTurns = this.listTurns().filter(t => t.turnKind === "user" || t.turnKind === "summarize");

    // Collect per-turn mutation data: distinct paths, additions, deletions
    interface TurnMutData {
      livePaths: Set<string>;
      revertedPaths: Set<string>;
      additions: number;
      deletions: number;
    }
    const perTurn = new Map<number, TurnMutData>();
    for (const entry of this._log) {
      if (entry.type !== "tool_result" || entry.discarded) continue;
      const meta = entry.meta as Record<string, unknown>;
      const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
      const fm = toolMeta?.fileMutation as FileMutation | undefined;
      if (!fm) continue;
      const ti = entry.turnIndex;
      let cur = perTurn.get(ti);
      if (!cur) { cur = { livePaths: new Set(), revertedPaths: new Set(), additions: 0, deletions: 0 }; perTurn.set(ti, cur); }
      if (meta.fileMutationReverted) {
        cur.revertedPaths.add(fm.path);
      } else {
        cur.livePaths.add(fm.path);
        cur.additions += fm.additions ?? 0;
        cur.deletions += fm.deletions ?? 0;
      }
    }

    // Suffix accumulation: cumulative from each turn to the end
    const turnIndices = userTurns.map(t => t.turnIndex);
    const cumulative = new Map<number, { fileCount: number; additions: number; deletions: number; allReverted: boolean }>();
    const suffixLivePaths = new Set<string>();
    const suffixRevertedPaths = new Set<string>();
    let suffixAdd = 0;
    let suffixDel = 0;
    for (let i = turnIndices.length - 1; i >= 0; i--) {
      const ti = turnIndices[i];
      const cur = perTurn.get(ti);
      if (cur) {
        for (const p of cur.livePaths) suffixLivePaths.add(p);
        for (const p of cur.revertedPaths) suffixRevertedPaths.add(p);
        suffixAdd += cur.additions;
        suffixDel += cur.deletions;
      }
      const hasLive = suffixLivePaths.size > 0;
      const allReverted = !hasLive && suffixRevertedPaths.size > 0;
      cumulative.set(ti, {
        fileCount: suffixLivePaths.size,
        additions: suffixAdd,
        deletions: suffixDel,
        allReverted,
      });
    }

    return userTurns
      .map(t => {
        const cum = cumulative.get(t.turnIndex) ?? { fileCount: 0, additions: 0, deletions: 0, allReverted: false };
        return {
          turnIndex: t.turnIndex,
          entryIndex: t.entryIndex,
          preview: t.preview,
          timestamp: t.timestamp,
          fileCount: cum.fileCount,
          additions: cum.additions,
          deletions: cum.deletions,
          filesReverted: cum.allReverted,
        };
      })
      .reverse();
  }

  /**
   * Build a rewind plan: collect live file mutations from `fromTurnIndex`
   * onward, group by path, and classify each as applicable/warning/conflict.
   */
  async planRewind(fromTurnIndex: number): Promise<RewindPlan> {
    const mutations = this._collectLiveFileMutations(fromTurnIndex);
    const byPath = new Map<string, Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: FileMutation }>>();
    for (const m of mutations) {
      const arr = byPath.get(m.mutation.path) ?? [];
      arr.push(m);
      byPath.set(m.mutation.path, arr);
    }

    const applicable: RewindPlan["applicable"] = [];
    const warnings: RewindPlan["warnings"] = [];
    const conflicts: RewindPlan["conflicts"] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    const fileLineCounts = new Map<string, number>();

    for (const [filePath, muts] of byPath) {
      // Sort newest first — reverse patches apply in this order
      muts.sort((a, b) => b.turnIndex - a.turnIndex || mutations.indexOf(b) - mutations.indexOf(a));

      // Check for untracked mutations
      if (muts.some(m => m.mutation.untracked || !m.mutation.reversePatch)) {
        conflicts.push({ path: filePath, reason: "untracked" });
        continue;
      }

      // Read current disk state
      let diskContent: string;
      try {
        diskContent = readFileSync(filePath, { encoding: "utf-8" });
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          conflicts.push({ path: filePath, reason: "file_deleted" });
        } else {
          conflicts.push({ path: filePath, reason: "file_not_readable" });
        }
        continue;
      }

      const diskSha = createHash("sha256").update(diskContent, "utf-8").digest("hex");
      const latestPostSha = muts[0].mutation.postImageSha;
      const isDiskModified = diskSha !== latestPostSha;

      // Try applying the reverse patch chain
      const pathMutations: RewindPathMutation[] = muts.map(m => ({
        entryId: m.entryId,
        turnIndex: m.turnIndex,
        reversePatch: m.mutation.reversePatch!,
      }));

      let current: string | false = diskContent;
      for (const pm of pathMutations) {
        current = applyPatch(current as string, pm.reversePatch);
        if (current === false) break;
      }

      if (current === false) {
        conflicts.push({ path: filePath, reason: "patch_failed" });
        continue;
      }

      // Count line additions/deletions from the patches
      let pathAdd = 0;
      let pathDel = 0;
      for (const pm of pathMutations) {
        const parsed = parsePatch(pm.reversePatch);
        for (const p of parsed) {
          for (const hunk of p.hunks) {
            for (const line of hunk.lines) {
              if (line.startsWith("+") && !line.startsWith("+++")) pathDel++;
              if (line.startsWith("-") && !line.startsWith("---")) pathAdd++;
            }
          }
        }
      }
      // Reverse: what the forward edit added becomes what revert deletes
      totalAdditions += pathAdd;
      totalDeletions += pathDel;
      fileLineCounts.set(filePath, pathAdd + pathDel);

      if (isDiskModified) {
        warnings.push({ path: filePath, reason: "disk_modified", mutations: pathMutations });
      } else {
        applicable.push({ path: filePath, mutations: pathMutations });
      }
    }

    // Summary file: the one with the most changed lines
    let summaryFile = "";
    let maxLines = 0;
    for (const [p, count] of fileLineCounts) {
      if (count > maxLines) { maxLines = count; summaryFile = p; }
    }
    const totalFiles = applicable.length + warnings.length;
    const otherFileCount = Math.max(0, totalFiles - 1);

    const bashEntries = this._planBashRewindEntries(fromTurnIndex);

    return {
      fromTurnIndex,
      applicable,
      warnings,
      conflicts,
      bashEntries,
      totalAdditions,
      totalDeletions,
      summaryFile: summaryFile ? join(relative(this._projectRoot, summaryFile)) : "",
      otherFileCount,
    };
  }

  /**
   * Rewind conversation only: truncate log from the given turn onward.
   */
  rewindConversation(toTurnIndex: number): { removed: number; error?: string } {
    if (this._turnInFlight) {
      return { removed: 0, error: "Cannot rewind while a turn is in progress." };
    }

    const cutoff = this._log.findIndex(
      (e) => e.turnIndex >= toTurnIndex && e.type === "turn_start" && !e.discarded,
    );
    if (cutoff < 0) {
      return { removed: 0, error: `Turn ${toTurnIndex} not found in log.` };
    }

    this._killChildSessionsAndShells();
    const removed = this._log.length - cutoff;
    this._log.length = cutoff;
    this._resetAfterRewind();
    return { removed };
  }

  /**
   * Rewind files only: apply reverse patches and mark mutations as reverted.
   * Does not truncate the conversation log.
   */
  async rewindFiles(plan: RewindPlan): Promise<RewindApplyResult> {
    if (this._turnInFlight) {
      return { revertedPaths: [], conflictPaths: [], bashReverted: [], bashSkipped: [], error: "Cannot rewind while a turn is in progress." };
    }

    const journalPath = this._writeRewindJournal(plan);

    const revertedPaths: string[] = [];
    const conflictPaths: string[] = [];
    const bashReverted: string[] = [];
    const bashSkipped: string[] = [];

    // Build unified timeline: interleave file and bash operations by log position.
    // File mutation groups use the logIndex of their newest (first) mutation.
    type RewindOp =
      | { type: "file"; logIndex: number; entry: (typeof plan.applicable)[0] }
      | { type: "bash"; logIndex: number; be: BashRewindEntry };

    const ops: RewindOp[] = [];
    for (const entry of [...plan.applicable, ...plan.warnings]) {
      const newestLogIndex = this._findLogIndex(entry.mutations[0]?.entryId ?? "");
      ops.push({ type: "file", logIndex: newestLogIndex, entry });
    }
    for (const be of plan.bashEntries) {
      ops.push({ type: "bash", logIndex: be.logIndex, be });
    }
    // Sort by logIndex descending (newest first)
    ops.sort((a, b) => b.logIndex - a.logIndex);

    try {
      for (const op of ops) {
        if (op.type === "bash") {
          const be = op.be;
          // Re-classify at execution time — earlier file reverts may have
          // changed disk state, turning a plan-time conflict into applicable.
          const liveStatus = this._classifyBashRewindEntry(
            be.entryId, be.turnIndex, be.logIndex, be.bashEntryIndex, be.mutation,
          );
          if (liveStatus.status === "conflict") {
            const detailSuffix = liveStatus.conflictDetails?.length
              ? ": " + liveStatus.conflictDetails.join("; ")
              : "";
            bashSkipped.push(`${be.description} (${liveStatus.conflictReason})${detailSuffix}`);
            continue;
          }
          const success = this._executeBashRevert(be);
          if (success) {
            bashReverted.push(be.description);
            this._markBashMutationEntryReverted(be.entryId, be.bashEntryIndex);
          } else {
            bashSkipped.push(be.description);
          }
        } else {
          const entry = op.entry;
          let content: string;
          try {
            content = readFileSync(entry.path, { encoding: "utf-8" });
          } catch {
            conflictPaths.push(entry.path);
            continue;
          }
          let failed = false;
          for (const mut of entry.mutations) {
            const result = applyPatch(content, mut.reversePatch);
            if (result === false) { failed = true; break; }
            content = result;
          }
          if (failed) {
            conflictPaths.push(entry.path);
            continue;
          }
          const earliestMut = entry.mutations[entry.mutations.length - 1];
          const createdFile = this._isMutationFileCreation(earliestMut.entryId);
          if (content === "" && createdFile) {
            try { unlinkSync(entry.path); } catch { /* ignore ENOENT */ }
          } else {
            writeFileSync(entry.path, content, { encoding: "utf-8" });
          }
          revertedPaths.push(entry.path);

          for (const mut of entry.mutations) {
            this._markMutationReverted(mut.entryId);
          }
        }
      }
    } catch (e) {
      this._restoreFromRewindJournal(journalPath);
      return { revertedPaths: [], conflictPaths: [], bashReverted: [], bashSkipped: [], error: `Rewind failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    this._deleteRewindJournal(journalPath);

    this._refreshPlanState();
    this._bumpLogRevision();
    this._notifyLogListeners();
    this.onSaveRequest?.();

    return { revertedPaths, conflictPaths, bashReverted, bashSkipped };
  }

  private _executeBashRevert(be: BashRewindEntry): boolean {
    const me = be.mutation;
    try {
      if (me.kind === "mkdir" && me.createdDirs) {
        const dirs = [...me.createdDirs].reverse();
        for (const dir of dirs) {
          if (existsSync(dir)) rmdirSync(dir);
        }
        return true;
      }

      if (me.kind === "cp") {
        if (!me.target) return false;
        if (me.targetExisted && me.backupPath) {
          copyFileSync(me.backupPath, me.target);
          try { unlinkSync(me.backupPath); } catch { /* ignore */ }
        } else if (existsSync(me.target)) {
          const st = statSync(me.target);
          if (st.isDirectory()) {
            rmSync(me.target, { recursive: true });
          } else {
            unlinkSync(me.target);
          }
        }
        return true;
      }

      if (me.kind === "mv") {
        if (!me.source || !me.target) return false;
        renameSync(me.target, me.source);
        if (me.targetExisted && me.backupPath) {
          copyFileSync(me.backupPath, me.target);
          try { unlinkSync(me.backupPath); } catch { /* ignore */ }
        }
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private _markBashMutationEntryReverted(entryId: string, bashEntryIndex: number): void {
    const entry = this._log.find(e => e.id === entryId);
    if (!entry) return;
    const meta = entry.meta as Record<string, unknown>;
    const indices = (meta.bashMutationRevertedIndices as number[]) ?? [];
    if (!indices.includes(bashEntryIndex)) indices.push(bashEntryIndex);
    meta.bashMutationRevertedIndices = indices;

    // If all entries reverted, set the legacy flag too
    const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
    const bm = toolMeta?.bashMutation as BashMutation | undefined;
    if (bm && indices.length >= bm.entries.length) {
      meta.bashMutationReverted = true;
    }
  }

  /**
   * Rewind both conversation and files.
   */
  async rewindBoth(
    toTurnIndex: number,
    plan: RewindPlan,
  ): Promise<RewindApplyResult & { removed: number }> {
    const fileResult = await this.rewindFiles(plan);
    if (fileResult.error) {
      return { ...fileResult, removed: 0 };
    }
    const convResult = this.rewindConversation(toTurnIndex);
    return { ...fileResult, removed: convResult.removed, error: convResult.error };
  }

  // ---- Rewind helpers ----

  private _collectLiveFileMutations(
    fromTurnIndex: number,
  ): Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: FileMutation }> {
    const results: Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: FileMutation }> = [];
    for (let li = 0; li < this._log.length; li++) {
      const entry = this._log[li]!;
      if (entry.turnIndex < fromTurnIndex) continue;
      if (entry.type !== "tool_result" || entry.discarded) continue;
      const meta = entry.meta as Record<string, unknown>;
      if (meta.fileMutationReverted) continue;
      const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
      const fm = toolMeta?.fileMutation as FileMutation | undefined;
      if (!fm) continue;
      results.push({ entryId: entry.id, turnIndex: entry.turnIndex, logIndex: li, mutation: fm });
    }
    return results;
  }

  private _collectLiveBashMutations(
    fromTurnIndex: number,
  ): Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: BashMutation; revertedIndices: number[] }> {
    const results: Array<{ entryId: string; turnIndex: number; logIndex: number; mutation: BashMutation; revertedIndices: number[] }> = [];
    for (let li = 0; li < this._log.length; li++) {
      const entry = this._log[li]!;
      if (entry.turnIndex < fromTurnIndex) continue;
      if (entry.type !== "tool_result" || entry.discarded) continue;
      const meta = entry.meta as Record<string, unknown>;
      if (meta.bashMutationReverted) continue;
      const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
      const bm = toolMeta?.bashMutation as BashMutation | undefined;
      if (!bm) continue;
      const revertedIndices = (meta.bashMutationRevertedIndices as number[]) ?? [];
      results.push({ entryId: entry.id, turnIndex: entry.turnIndex, logIndex: li, mutation: bm, revertedIndices });
    }
    return results;
  }

  private _planBashRewindEntries(
    fromTurnIndex: number,
  ): BashRewindEntry[] {
    const collected = this._collectLiveBashMutations(fromTurnIndex);
    const entries: BashRewindEntry[] = [];

    for (let i = collected.length - 1; i >= 0; i--) {
      const { entryId, turnIndex, logIndex, mutation, revertedIndices } = collected[i]!;
      for (let j = mutation.entries.length - 1; j >= 0; j--) {
        if (revertedIndices.includes(j)) continue;
        const me = mutation.entries[j]!;
        const entry = this._classifyBashRewindEntry(entryId, turnIndex, logIndex, j, me);
        entries.push(entry);
      }
    }

    return entries;
  }

  private _classifyBashRewindEntry(
    entryId: string,
    turnIndex: number,
    logIndex: number,
    bashEntryIndex: number,
    me: BashMutationEntry,
  ): BashRewindEntry {
    const base = { entryId, turnIndex, logIndex, bashEntryIndex, mutation: me };

    if (me.kind === "mkdir" && me.createdDirs) {
      const dirs = [...me.createdDirs].reverse();
      const createdSet = new Set(me.createdDirs);
      const desc = `rmdir ${me.createdDirs.join(", ")}`;

      if (!dirs.some(d => existsSync(d))) {
        return { ...base, kind: "mkdir", description: desc, status: "conflict", conflictReason: "dir_deleted", conflictDetails: ["Directories already removed."] };
      }

      // Check emptiness, ignoring sibling dirs from the same mkdir command
      const nonEmptyDirs: string[] = [];
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        try {
          const contents = readdirSync(dir);
          const external = contents.filter(c => !createdSet.has(join(dir, c)));
          if (external.length > 0) nonEmptyDirs.push(dir);
        } catch { /* ignore */ }
      }

      if (nonEmptyDirs.length > 0) {
        const details: string[] = [];
        for (const dir of nonEmptyDirs) {
          try {
            const files = readdirSync(dir).filter(c => !createdSet.has(join(dir, c))).slice(0, 5);
            details.push(`${dir}: ${files.join(", ")}${files.length >= 5 ? ", ..." : ""}`);
          } catch { details.push(dir); }
        }
        return { ...base, kind: "mkdir", description: desc, status: "conflict", conflictReason: "dir_not_empty", conflictDetails: details };
      }

      return { ...base, kind: "mkdir", description: desc, status: "applicable" };
    }

    if (me.kind === "cp") {
      if (!me.target) {
        return { ...base, kind: "cp", description: "cp (unknown target)", status: "conflict", conflictReason: "backup_missing" };
      }

      if (!existsSync(me.target)) {
        return { ...base, kind: "cp", description: `rm ${me.target}`, status: "conflict", conflictReason: "target_deleted", conflictDetails: ["Target already removed."] };
      }

      if (me.targetExisted && me.backupPath && !existsSync(me.backupPath)) {
        return { ...base, kind: "cp", description: `restore ${me.target}`, status: "conflict", conflictReason: "backup_missing", conflictDetails: ["Backup file is missing."] };
      }

      if (me.postImageSha) {
        try {
          const currentSha = createHash("sha256").update(readFileSync(me.target)).digest("hex");
          if (currentSha !== me.postImageSha) {
            const desc = me.targetExisted ? `restore ${me.target}` : `rm ${me.target}`;
            return { ...base, kind: "cp", description: desc, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File was modified after the copy."] };
          }
        } catch {
          const desc = me.targetExisted ? `restore ${me.target}` : `rm ${me.target}`;
          return { ...base, kind: "cp", description: desc, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File type changed (cannot read as file)."] };
        }
      }

      const desc = me.targetExisted ? `restore ${me.target} from backup` : `rm ${me.target}`;
      return { ...base, kind: "cp", description: desc, status: "applicable" };
    }

    if (me.kind === "mv") {
      if (!me.source || !me.target) {
        return { ...base, kind: "mv", description: "mv (unknown paths)", status: "conflict", conflictReason: "backup_missing" };
      }

      if (!existsSync(me.target)) {
        return { ...base, kind: "mv", description: `mv → ${me.source}`, status: "conflict", conflictReason: "target_deleted", conflictDetails: ["Moved file was deleted."] };
      }

      if (existsSync(me.source)) {
        return { ...base, kind: "mv", description: `mv ${me.target} → ${me.source}`, status: "conflict", conflictReason: "source_occupied", conflictDetails: [`${me.source} already exists.`] };
      }

      if (me.postImageSha) {
        try {
          const currentSha = createHash("sha256").update(readFileSync(me.target)).digest("hex");
          if (currentSha !== me.postImageSha) {
            return { ...base, kind: "mv", description: `mv ${me.target} → ${me.source}`, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File was modified after the move."] };
          }
        } catch {
          return { ...base, kind: "mv", description: `mv ${me.target} → ${me.source}`, status: "conflict", conflictReason: "disk_modified", conflictDetails: ["File type changed (cannot read as file)."] };
        }
      }

      if (me.targetExisted && me.backupPath && !existsSync(me.backupPath)) {
        return { ...base, kind: "mv", description: `mv ${me.target} → ${me.source}`, status: "conflict", conflictReason: "backup_missing", conflictDetails: ["Backup of overwritten file is missing."] };
      }

      return { ...base, kind: "mv", description: `mv ${me.target} → ${me.source}`, status: "applicable" };
    }

    return { ...base, kind: me.kind, description: `${me.kind} (unknown)`, status: "conflict", conflictReason: "backup_missing" };
  }

  private _findLogIndex(entryId: string): number {
    return this._log.findIndex(e => e.id === entryId);
  }

  private _isMutationFileCreation(entryId: string): boolean {
    const entry = this._log.find(e => e.id === entryId);
    if (!entry) return false;
    const meta = entry.meta as Record<string, unknown>;
    const toolMeta = meta.toolMetadata as Record<string, unknown> | undefined;
    const fm = toolMeta?.fileMutation as FileMutation | undefined;
    return fm?.kind === "created";
  }

  private _markMutationReverted(entryId: string): void {
    const entry = this._log.find(e => e.id === entryId);
    if (entry) {
      (entry.meta as Record<string, unknown>).fileMutationReverted = true;
    }
  }

  private _killChildSessionsAndShells(): void {
    if (this._childSessions.size > 0) {
      this._archiveAllChildSessions();
    }
    if (this._shellManager.hasTrackedShells()) {
      this._forceKillAllShells();
    }
  }

  private _resetAfterRewind(): void {
    const log = this._log;
    this._turnCount = log.length > 0 ? (log[log.length - 1]?.turnIndex ?? 0) : 0;
    this._idAllocator.restoreFrom(log);

    this._compactInProgress = false;
    this._summarizeToolWhitelist = null;
    this._hintState = "none";
    this._agentState = "idle";
    this._inbox = [];
    this._activeAsk = null;
    this._pendingTurnState = null;
    this._showContextRoundsRemaining = 0;
    this._showContextAnnotations = null;
    this._activeLogEntryId = null;
    this._lastTurnEndStatus = null;
    this._cachedSummary = undefined;

    this._usedContextIds.clear();
    this._compactCount = 0;
    for (const entry of log) {
      const ctx = (entry.meta as Record<string, unknown>)?.["contextId"];
      if (typeof ctx === "string") this._usedContextIds.add(ctx);
      if (entry.type === "compact_marker" && !entry.discarded) {
        this._compactCount += 1;
      }
    }

    this._refreshPlanState();
    this._bumpLogRevision();
    this._notifyLogListeners();
    this.onSaveRequest?.();
  }

  private _getRewindJournalPath(): string {
    const dir = this._getArtifactsDirIfAvailable() ?? join(homedir(), ".vigil", "tmp");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, "rewind-journal.json");
  }

  private _writeRewindJournal(plan: RewindPlan): string {
    const journalPath = this._getRewindJournalPath();
    const preimages: Array<{ path: string; existed: boolean; content: string | null }> = [];
    const allPaths = [...plan.applicable, ...plan.warnings];
    for (const entry of allPaths) {
      try {
        const content = readFileSync(entry.path, { encoding: "utf-8" });
        preimages.push({ path: entry.path, existed: true, content });
      } catch {
        preimages.push({ path: entry.path, existed: false, content: null });
      }
    }
    writeFileSync(journalPath, JSON.stringify(preimages), { encoding: "utf-8" });
    return journalPath;
  }

  private _restoreFromRewindJournal(journalPath: string): void {
    try {
      const raw = readFileSync(journalPath, { encoding: "utf-8" });
      const preimages: Array<{ path: string; existed: boolean; content: string | null }> = JSON.parse(raw);
      for (const img of preimages) {
        try {
          if (img.existed && img.content !== null) {
            writeFileSync(img.path, img.content, { encoding: "utf-8" });
          } else if (!img.existed) {
            try { unlinkSync(img.path); } catch { /* ignore */ }
          }
        } catch { /* best effort */ }
      }
    } catch { /* journal corrupt or missing */ }
  }

  private _deleteRewindJournal(journalPath: string): void {
    try { unlinkSync(journalPath); } catch { /* ignore */ }
  }

  /**
   * Check for and recover from a crashed rewind on session restore.
   */
  recoverRewindIfNeeded(): void {
    const journalPath = this._getRewindJournalPath();
    if (!existsSync(journalPath)) return;
    this._restoreFromRewindJournal(journalPath);
    this._deleteRewindJournal(journalPath);
  }

  /**
   * Restore session from a loaded log.
   */
  prepareRestoreFromLog(
    meta: LogSessionMeta,
    entries: LogEntry[],
    idAllocator: LogIdAllocator,
  ): PreparedSessionRestore {
    if ((meta.childSessions?.length ?? 0) > 0 && !this._sessionArtifactsOverride && !this._getArtifactsDirIfAvailable()) {
      throw new Error(
        "Cannot restore child sessions before the session store is bound to the target session directory.",
      );
    }

    const shadow = this._createRestoreShadowSession();
    const clonedEntries = structuredClone(entries) as LogEntry[];
    const clonedAllocator = new LogIdAllocator();
    clonedAllocator.restoreFrom(clonedEntries);

    shadow._restoreFromLogUnsafe(meta, clonedEntries, clonedAllocator, { restoreChildren: false });

    const warnings: string[] = [];
    const allChildMeta = meta.childSessions ?? [];
    // Restore ALL children as full Session instances (including archived) so
    // TUI can display them and read their logs. _archivedChildren is only
    // populated on close/reset, not on restore.
    const children = this._prepareChildRestores(allChildMeta, warnings);

    // Root inbox from meta
    const rootInbox = (meta.inbox ?? []).map((raw) => migrateMessageEnvelope(raw as unknown as Record<string, unknown>));

    return { rootState: shadow, children, rootInbox, warnings };
  }

  commitPreparedRestore(prepared: PreparedSessionRestore): string[] {
    const shadow = prepared.rootState;
    const warnings = [...prepared.warnings];

    this._resetTransientState();
    this._mcpConnected = false;
    this._currentTurnSignal = null;
    this._currentTurnAbortController = null;
    this._turnInFlight = null;
    this._turnRelease = null;
    // _waitHandle removed — await_event uses polling now
    this.primaryAgent.replaceModelConfig({ ...shadow.primaryAgent.modelConfig });
    this._persistedModelSelection = { ...shadow._persistedModelSelection };

    this._log = shadow._log;
    // Do NOT copy shadow._logRevision — it is a transient change-detection
    // counter that must stay monotonically increasing on *this* session so
    // that UI subscribers (shouldSyncTranscript) always detect the swap.
    // Copying the shadow's small value can collide with the current value,
    // causing the transcript panel to skip the update.
    this._idAllocator = shadow._idAllocator;
    this._turnCount = shadow._turnCount;
    this._compactCount = shadow._compactCount;
    this._preferredThinkingLevel = shadow._preferredThinkingLevel;
    this._thinkingLevel = shadow._thinkingLevel;
    this._createdAt = shadow._createdAt;
    this._title = shadow._title;
    this._cachedSummary = shadow._cachedSummary;
    this._usedContextIds = new Set(shadow._usedContextIds);
    this._lastInputTokens = shadow._lastInputTokens;
    this._lastTotalTokens = shadow._lastTotalTokens;
    this._lastCacheReadTokens = shadow._lastCacheReadTokens;
    this._lifetimeToolCallCount = shadow._lifetimeToolCallCount;
    this._lastToolCallSummary = shadow._lastToolCallSummary;
    this._recentSessionEvents = [...shadow._recentSessionEvents];
    this._lastTurnEndStatus = shadow._lastTurnEndStatus;
    this._selfPhase = shadow._selfPhase;
    this._showContextRoundsRemaining = shadow._showContextRoundsRemaining;
    this._showContextAnnotations = shadow._showContextAnnotations
      ? new Map(shadow._showContextAnnotations)
      : null;
    this._activeAsk = shadow._activeAsk ? structuredClone(shadow._activeAsk) as AskRequest : null;
    this._askHistory = structuredClone(shadow._askHistory) as AskAuditRecord[];
    this._agentState = shadow._agentState;
    this._inbox = structuredClone(shadow._inbox) as MessageEnvelope[];
    this._pendingTurnState = shadow._pendingTurnState
      ? structuredClone(shadow._pendingTurnState) as PendingTurnState
      : null;

    this._childSessions = new Map();
    this._archivedChildren = new Map();
    this._subAgentCounter = 0;
    warnings.push(...this._commitPreparedChildren(prepared.children));

    // Restore root inbox from meta
    if (prepared.rootInbox && prepared.rootInbox.length > 0) {
      this._inbox = [...prepared.rootInbox];
    }

    // Restore plan state from plan.md if it exists
    this._refreshPlanState();

    this._bumpLogRevision();
    this._notifyLogListeners();
    return warnings;
  }

  restoreFromLog(
    meta: LogSessionMeta,
    entries: LogEntry[],
    idAllocator: LogIdAllocator,
  ): void {
    const prepared = this.prepareRestoreFromLog(meta, entries, idAllocator);
    this.commitPreparedRestore(prepared);
  }

  private _createRestoreShadowSession(): Session {
    const shadowStore =
      this._sessionArtifactsOverride || this._getArtifactsDirIfAvailable()
        ? this._store
        : undefined;
    const provider = (this.primaryAgent as unknown as { _provider?: unknown })._provider;
    const clonedPrimaryAgent = typeof (this.primaryAgent as { clone?: () => Agent }).clone === "function"
      ? (this.primaryAgent as { clone: () => Agent }).clone()
      : {
          name: this.primaryAgent.name,
          description: this.primaryAgent.description,
          systemPrompt: this.primaryAgent.systemPrompt,
          tools: [...this.primaryAgent.tools],
          maxToolRounds: this.primaryAgent.maxToolRounds,
          modelConfig: { ...this.primaryAgent.modelConfig },
          _provider: provider,
          replaceModelConfig(next: ModelConfig) {
            (this as { modelConfig: ModelConfig }).modelConfig = next;
          },
        } as unknown as Agent;
    const shadow = new Session({
      primaryAgent: clonedPrimaryAgent,
      config: this.config,
      agentTemplates: this.agentTemplates,
      skills: this._skills,
      skillRoots: this._skillRoots,
      progress: this._progress,
      mcpManager: this._mcpManager,
      promptsDirs: this._promptsDirs,
      store: shadowStore,
      contextRatio: this._contextRatio,
      projectRoot: this._projectRoot,
      sessionArtifactsDir: this._sessionArtifactsOverride || undefined,
      capabilities: this._capabilities,
      statusSource: this._statusSource,
      onTurnOutput: this._turnOutputTarget,
      toolExecutorOverrides: this._toolExecutorOverrides,
      deferQueuedMessageInjectionOnTurnExit: this._deferQueuedMessageInjectionOnTurnExit,
      permissionRuleStore: this._permissionRuleStore,
    });
    shadow.applyGlobalPreferences(this.getGlobalPreferences());
    return shadow;
  }

  private _restoreFromLogUnsafe(
    meta: LogSessionMeta,
    entries: LogEntry[],
    idAllocator: LogIdAllocator,
    opts?: { restoreChildren?: boolean; warnings?: string[] },
  ): void {
    const restoredSelection = resolvePersistedModelSelection(this, {
      modelConfigName: meta.modelConfigName || undefined,
      modelProvider: meta.modelProvider,
      modelSelectionKey: meta.modelSelectionKey,
      modelId: meta.modelId,
    });
    const restoredModelConfig = this.config.getModel(restoredSelection.selectedConfigName);
    const restoredThinkingPreference = meta.thinkingLevel ?? "";

    this._resetTransientState();
    this.primaryAgent.replaceModelConfig(restoredModelConfig);
    this._persistedModelSelection = this._buildPersistedModelSelection({
      modelConfigName: restoredSelection.selectedConfigName,
      modelProvider: restoredSelection.modelProvider,
      modelSelectionKey: restoredSelection.modelSelectionKey,
      modelId: restoredSelection.modelId,
    });

    // Core log state
    this._log = entries;
    this._logRevision = 0;
    this._idAllocator = idAllocator;

    // Counters from meta
    this._turnCount = meta.turnCount;
    this._compactCount = meta.compactCount;
    this._preferredThinkingLevel = restoredThinkingPreference;
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      restoredModelConfig.model,
      restoredThinkingPreference,
    );
    this._createdAt = meta.createdAt || this._createdAt;
    this._title = meta.title;
    this._cachedSummary = meta.summary || undefined;

    // Rebuild usedContextIds from entries
    this._usedContextIds = new Set<string>();
    for (const e of entries) {
      const ctxId = (e.meta as Record<string, unknown>)["contextId"];
      if (ctxId) this._usedContextIds.add(String(ctxId));
    }

    // Restore last token counts from log
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "token_update") {
        this._lastInputTokens = ((entries[i].meta as Record<string, unknown>)["inputTokens"] as number) ?? 0;
        this._lastTotalTokens = ((entries[i].meta as Record<string, unknown>)["totalTokens"] as number) ?? 0;
        this._lastCacheReadTokens = ((entries[i].meta as Record<string, unknown>)["cacheReadTokens"] as number) ?? 0;
        break;
      }
    }

    this._rebuildRuntimeSignalsFromLog();
    // ESC-deny model: resolve open asks as Deny/Decline FIRST so the
    // subsequent normalization sees them as completed tool_call → tool_result
    // pairs and doesn't add spurious "interrupted" markers.
    this._resolveOpenAsksAsDenyOnRestore();
    this._normalizeInterruptedTurnFromLog("Last turn was interrupted unexpectedly and recovered after restart.");
    if (opts?.restoreChildren !== false) {
      this._restoreChildSessionsFromLog(meta.childSessions ?? [], opts?.warnings);
    }

    // Rebuild ask history from ask_resolution entries
    this._askHistory = [];
    for (const e of entries) {
      if (e.type === "ask_resolution" && !e.discarded) {
        const m = e.meta as Record<string, unknown>;
        this._askHistory.push({
          askId: String(m["askId"] ?? ""),
          kind: (m["askKind"] as any) ?? "agent_question",
          summary: "",
          decidedAt: new Date(e.timestamp).toISOString(),
          decision: "answered",
          source: { agentId: this.primaryAgent.name },
        });
      }
    }

    this._bumpLogRevision();
    this._notifyLogListeners();
  }

  private _prepareChildRestores(
    childSessions: ChildSessionMetaRecord[],
    warnings: string[],
  ): PreparedChildRestore[] {
    if (childSessions.length === 0) return [];
    if (!this._sessionArtifactsOverride && !this._getArtifactsDirIfAvailable()) {
      throw new Error(
        "Cannot restore child sessions before the session store is bound to the target session directory.",
      );
    }

    const prepared: PreparedChildRestore[] = [];
    const ordered = [...childSessions].sort((a, b) => (a.order ?? a.numericId) - (b.order ?? b.numericId));
    for (const record of ordered) {
      let agent: Agent;
      try {
        if (this.agentTemplates[record.template]) {
          ({ agent } = this._createSubAgentFromPredefined(record.template, record.id));
        } else {
          ({ agent } = this._createSubAgentFromPath(this._resolveTemplatePath(record.template), record.id));
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to prepare child session '${record.id}': ${reason}`);
        continue;
      }

      const sessionDir = this._childSessionDir(record.id);
      const artifactsDir = join(sessionDir, "artifacts");

      try {
        const loaded = loadLog(sessionDir);
        const repaired = validateAndRepairLog(loaded.entries);
        if (repaired.repaired) {
          for (const warning of repaired.warnings) {
            warnings.push(`[repair:${record.id}] ${warning}`);
          }
        }
        prepared.push({
          record,
          agent,
          sessionDir,
          artifactsDir,
          loaded: {
            ...loaded,
            entries: repaired.entries,
          },
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to load child session '${record.id}': ${reason}`);
      }
    }
    return prepared;
  }

  private _commitPreparedChildren(children: PreparedChildRestore[]): string[] {
    if (children.length === 0) return [];

    const warnings: string[] = [];
    for (const prepared of children) {
      const { record, agent, loaded } = prepared;
      try {
        const handle = this._instantiateChildSession(
          record.id,
          record.template,
          record.mode,
          agent,
          { numericId: record.numericId, order: record.order },
        );
        handle.session.restoreFromLog(loaded.meta, loaded.entries, loaded.idAllocator);
        handle.lifecycle = record.lifecycle;
        handle.lastOutcome = record.outcome ?? "none";
        handle.lastActivityAt = Date.now();
        handle.resultText = this._extractLatestAssistantText(handle.session.log);
        handle.status =
          record.lifecycle === "archived"
            ? "terminated"
            : "idle";

        if (record.inbox && record.inbox.length > 0) {
          (handle.session as Session)._inbox = record.inbox.map((m) => migrateMessageEnvelope(m as unknown as Record<string, unknown>));
        }

        this._childSessions.set(record.id, handle);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to restore child session '${record.id}': ${reason}`);
      }
    }

    return warnings;
  }

  private _rebuildRuntimeSignalsFromLog(): void {
    this._lifetimeToolCallCount = 0;
    this._lastToolCallSummary = "";
    this._recentSessionEvents = [];
    this._lastTurnEndStatus = null;
    this._selfPhase = "idle";

    for (const entry of this._log) {
      if (entry.discarded) continue;
      if (entry.type === "tool_call" && entry.apiRole === "assistant") {
        this._lifetimeToolCallCount += 1;
        this._lastToolCallSummary = entry.display || this._lastToolCallSummary;
        if (entry.display) this._recordSessionEvent(entry.display);
      }
      if (entry.type === "tool_result") {
        const content = entry.content;
        if (content && typeof content === "object") {
          const toolSummary = String((content as Record<string, unknown>)["toolSummary"] ?? "").trim();
          if (toolSummary) {
            this._lastToolCallSummary = toolSummary;
            this._recordSessionEvent(toolSummary);
          }
        }
      }
      if (entry.type === "turn_end") {
        const status = (entry.meta as Record<string, unknown>)["status"];
        if (status === "completed" || status === "interrupted" || status === "error") {
          this._lastTurnEndStatus = status;
        }
      }
    }
  }

  private _normalizeInterruptedTurnFromLog(message: string): void {
    let turnStartIndex = -1;
    let interruptedTurnIndex = -1;

    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.discarded) continue;
      if (entry.type === "turn_end") {
        break;
      }
      if (entry.type === "turn_start") {
        turnStartIndex = i;
        interruptedTurnIndex = entry.turnIndex;
        break;
      }
    }

    if (turnStartIndex < 0 || interruptedTurnIndex < 0) return;

    const interruptedMarker = "[Interrupted here.]";
    this._activeLogEntryId = null;

    let latestRound: number | undefined;
    let latestRoundHasToolCall = false;

    for (let i = turnStartIndex; i < this._log.length; i++) {
      const entry = this._log[i];
      if (entry.discarded || entry.turnIndex !== interruptedTurnIndex) continue;
      if (entry.roundIndex !== undefined && (latestRound === undefined || entry.roundIndex > latestRound)) {
        latestRound = entry.roundIndex;
      }
    }

    if (latestRound !== undefined) {
      for (let i = turnStartIndex; i < this._log.length; i++) {
        const entry = this._log[i];
        if (entry.discarded || entry.turnIndex !== interruptedTurnIndex || entry.roundIndex !== latestRound) continue;
        if (entry.type === "tool_call" && entry.apiRole === "assistant") latestRoundHasToolCall = true;
      }
      if (!latestRoundHasToolCall) {
        for (let i = turnStartIndex; i < this._log.length; i++) {
          const entry = this._log[i];
          if (entry.discarded || entry.turnIndex !== interruptedTurnIndex || entry.roundIndex !== latestRound) continue;
          if (entry.type === "reasoning") entry.discarded = true;
        }
      }
    }

    // Partial text is kept as-is (no suffix appended).

    const originalTurnCount = this._turnCount;
    this._turnCount = interruptedTurnIndex;
    this._completeMissingToolResultsFromLog(turnStartIndex, "[Interrupted] Tool was not executed.");

    // Create [Interrupted here.] marker for API protocol (ensures proper role alternation
    // and model awareness), but hide from TUI — interrupted tools show their own status.
    const markerCtxId = this._findPrecedingUserSideContextId() ?? this._allocateContextId();
    const markerEntry = createAssistantText(
      this._nextLogId("assistant_text"),
      interruptedTurnIndex,
      this._computeNextRoundIndex(),
      interruptedMarker,
      interruptedMarker,
      markerCtxId,
    );
    markerEntry.tuiVisible = false;
    markerEntry.displayKind = null;
    this._appendEntry(markerEntry, false);

    const interruptionCtxId = this._allocateContextId();
    const interruptionEntry = createUserMessageEntry(
      this._nextLogId("user_message"),
      interruptedTurnIndex,
      message,
      message,
      interruptionCtxId,
    );
    interruptionEntry.tuiVisible = false;
    interruptionEntry.displayKind = null;
    this._appendEntry(interruptionEntry, false);
    this._appendEntry(
      createTurnEnd(this._nextLogId("turn_end"), interruptedTurnIndex, "interrupted"),
      false,
    );
    this._lastTurnEndStatus = "interrupted";
    this._turnCount = originalTurnCount;
    this._recordSessionEvent("recovered interrupted turn");
  }

  private _restoreChildSessionsFromLog(childSessions: ChildSessionMetaRecord[], warnings?: string[]): void {
    if (childSessions.length === 0) return;

    // Restore ALL children as full Session instances (including archived)
    // so TUI can display them and read their logs.
    const ordered = [...childSessions].sort((a, b) => (a.order ?? a.numericId) - (b.order ?? b.numericId));
    for (const record of ordered) {
      let agent: Agent;
      try {
        if (this.agentTemplates[record.template]) {
          ({ agent } = this._createSubAgentFromPredefined(record.template, record.id));
        } else {
          ({ agent } = this._createSubAgentFromPath(this._resolveTemplatePath(record.template), record.id));
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings?.push(`Failed to prepare child session '${record.id}': ${reason}`);
        console.warn(`Failed to restore child session '${record.id}':`, e);
        continue;
      }

      let handle: ChildSessionHandle;
      try {
        handle = this._instantiateChildSession(
          record.id,
          record.template,
          record.mode,
          agent,
          { numericId: record.numericId, order: record.order },
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings?.push(`Failed to instantiate child session '${record.id}': ${reason}`);
        console.warn(`Failed to instantiate child session '${record.id}':`, e);
        continue;
      }

      try {
        const loaded = loadLog(handle.sessionDir);
        handle.session.restoreFromLog(loaded.meta, loaded.entries, loaded.idAllocator);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        warnings?.push(`Failed to load child session log for '${record.id}': ${reason}`);
        console.warn(`Failed to load child session log for '${record.id}':`, e);
      }

      handle.lifecycle = record.lifecycle;
      handle.lastOutcome = record.outcome ?? "none";
      handle.lastActivityAt = Date.now();
      handle.resultText = this._extractLatestAssistantText(handle.session.log);
      handle.status = "idle";

      // Restore inbox if persisted (migrate old format)
      if (record.inbox && record.inbox.length > 0) {
        (handle.session as Session)._inbox = record.inbox.map((m) => migrateMessageEnvelope(m as unknown as Record<string, unknown>));
      }

      this._childSessions.set(record.id, handle);
    }
  }

  private _extractLatestAssistantText(entries: readonly LogEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.discarded) continue;
      if (entry.type === "assistant_text" || entry.type === "no_reply") {
        return String(entry.content ?? entry.display ?? "");
      }
    }
    return "";
  }

  /**
   * Get log data for persistence (v2).
   * Returns meta + entries suitable for saveLog().
   */
  getLogForPersistence(): { meta: LogSessionMeta; entries: readonly LogEntry[] } {
    // Include both active and archived children in persistence meta
    const childSessionsMeta: ChildSessionMetaRecord[] = [
      ...[...this._childSessions.values()].map((handle) => ({
        id: handle.id,
        numericId: handle.numericId,
        template: handle.template,
        mode: handle.mode,
        lifecycle: handle.lifecycle,
        outcome: handle.lastOutcome,
        order: handle.order,
        inbox: (handle.session as Session)._inbox.length > 0
          ? [...(handle.session as Session)._inbox]
          : undefined,
      })),
      ...[...this._archivedChildren.values()].map((record) => ({
        id: record.id,
        numericId: record.numericId,
        template: record.template,
        mode: record.mode,
        lifecycle: "archived" as ChildSessionLifecycle,
        outcome: record.outcome,
        order: record.order,
      })),
    ];
    return {
      meta: createLogSessionMeta({
        createdAt: this._createdAt,
        projectPath: this._projectRoot,
        modelConfigName: this._persistedModelSelection.modelConfigName ?? "",
        modelProvider: this._persistedModelSelection.modelProvider,
        modelSelectionKey: this._persistedModelSelection.modelSelectionKey,
        modelId: this._persistedModelSelection.modelId,
        turnCount: this._turnCount,
        compactCount: this._compactCount,
        thinkingLevel: this._thinkingLevel,
        title: this._title,
        summary: this._generateSummary(),
        childSessions: childSessionsMeta,
        inbox: this._inbox.length > 0 ? [...this._inbox] : undefined,
      }),
      entries: this._log,
    };
  }

  setStore(store: any): void {
    this._store = store;
    // Re-render system prompt in conversation to reflect correct paths
    this._refreshSystemPromptPaths();
  }

  /**
   * Full reset for /new — equivalent to constructing a fresh Session.
   * Leaves storage unbound; session/artifacts directories are created lazily
   * on the first subsequent turn.
   */
  async resetForNewSession(newStore?: any): Promise<void> {
    // 0. Terminate any in-flight turn before resetting
    this.requestTurnInterrupt();
    await this.waitForTurnComplete();

    // 1. Kill active sub-agents, reset transient flags
    this._resetTransientState();

    // 2. Update store FIRST (so path resolution picks up new session)
    if (newStore !== undefined) {
      this._store = newStore;
    }

    // 3. Reset counters
    this._turnCount = 0;
    this._compactCount = 0;
    this._usedContextIds = new Set<string>();

    // 4. Reset thinking state
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      this._preferredThinkingLevel,
    );

    // 5. Reset MCP connection flag (will reconnect on next turn)
    this._mcpConnected = false;

    // 6. Clear plan state
    if (this._planState.length > 0) {
      this._planState = [];
      this._notifyPlanListeners();
    }

    // 7. /new must start from a truly fresh session tree. _resetTransientState()
    // archives existing children so they can be saved before teardown, but those
    // archived handles must not leak into the next root session's persisted meta.
    this._childSessions = new Map();
    this._archivedChildren = new Map();

    // 8. Re-init conversation LAST (fresh session state, storage may still be lazy)
    // _initConversation also resets _log and _idAllocator
    this._initConversation();
  }

  private _buildToolExecutors(): Record<string, ToolExecutor> {
    return buildToolExecutors({
      projectRoot: this._projectRoot,
      getSessionArtifactsDir: () => this._resolveSessionArtifacts(),
      supportsMultimodal: this.primaryAgent.modelConfig.supportsMultimodal,
      commExecutors: {
        bash_background: (args) => this._shellManager.execBashBackground(args),
        bash_output: (args) => this._shellManager.execBashOutput(args),
        kill_shell: (args) => this._shellManager.execKillShell(args),
        spawn: (args) => this._execSpawn(args),
        kill_agent: (args) => this._execKillAgent(args),
        check_status: (args) => this._execCheckStatus(args),
        await_event: (args) => this._execAwaitEvent(args),
        show_context: (args) => this._execShowContext(args),
        summarize: (args) => this._execSummarizeTool(args),
        ask: (args) => this._execAsk(args),
        skill: (args) => this._execSkill(args),
        send: (args) => this._execSend(args),
        $web_search: (args) => toolBuiltinWebSearchPassthrough(args as Record<string, unknown>),
      },
      overrides: this._toolExecutorOverrides,
      onFileWrite: (filePath) => {
        if (this._isAgentsMdPath(filePath)) {
          this._reloadPromptAndTools();
        }
      },
      isPlanFile: (filePath) => this._isPlanFilePath(filePath),
      onPlanFileWrite: () => this._refreshPlanState(),
      getApprovedExternalPrefixes: () => {
        if (this._permissionAdvisor.sessionMode === "yolo") return ["/"];
        return this._permissionRuleStore.getApprovedExternalPrefixes();
      },
    });
  }

  private _ensureCommTools(): void {
    ensureCommTools(this.primaryAgent.tools, this._capabilities);
  }

  // ==================================================================
  // Skills
  // ==================================================================

  /** Read-only access to loaded skills (for command registration). */
  get skills(): ReadonlyMap<string, SkillMeta> {
    return this._skills;
  }

  // ==================================================================
  // Sub-agent introspection (for TUI/GUI)
  // ==================================================================

  getAgentLog(agentId: string): readonly LogEntry[] | null {
    const entry = this._childSessions.get(agentId);
    return entry ? entry.session.log : null;
  }

  getActiveAgentIds(): Array<{ id: string; status: string; interactive: boolean }> {
    const result: Array<{ id: string; status: string; interactive: boolean }> = [];
    for (const snapshot of this.getChildSessionSnapshots()) {
      const status = snapshot.running
        ? "working"
        : snapshot.lifecycle === "blocked"
          ? "waiting"
          : snapshot.lifecycle === "running"
            ? "working"
            : snapshot.lifecycle;
      result.push({
        id: snapshot.id,
        status,
        interactive: snapshot.mode === "persistent",
      });
    }
    return result;
  }

  get mcpManager(): MCPClientManager | undefined {
    return this._mcpManager;
  }

  async ensureMcpReady(): Promise<void> {
    await this._ensureMcp();
  }

  /** Read-only access to disabled skill names. */
  get disabledSkills(): ReadonlySet<string> {
    return this._disabledSkills;
  }

  /**
   * Return all skills from disk (both enabled and disabled) for UI display.
   */
  getAllSkillNames(): { name: string; description: string; enabled: boolean }[] {
    const allOnDisk = loadSkillsMulti(this._skillRoots);
    return [...allOnDisk.values()].map((s) => ({
      name: s.name,
      description: s.description,
      enabled: !this._disabledSkills.has(s.name),
    }));
  }

  /** Enable or disable a skill by name. Call reloadSkills() afterwards. */
  setSkillEnabled(name: string, enabled: boolean): void {
    if (enabled) {
      this._disabledSkills.delete(name);
    } else {
      this._disabledSkills.add(name);
    }
  }

  /**
   * Rescan skill directories, apply disabled filter, and rebuild
   * the skill tool definition. Returns change report for callers
   * that need it (e.g. /skills command).
   */
  reloadSkills(): { added: string[]; removed: string[]; total: number } {
    const oldNames = new Set(this._skills.keys());
    this._refreshSkills();
    const newNames = new Set(this._skills.keys());

    const added = [...newNames].filter((n) => !oldNames.has(n));
    const removed = [...oldNames].filter((n) => !newNames.has(n));

    return { added, removed, total: this._skills.size };
  }

  /**
   * Build the `skill` tool definition dynamically from loaded skills.
   * Returns null if no skills are available for the agent.
   */
  private _ensureSkillTool(): void {
    this.primaryAgent.tools = ensureSkillTool(
      this.primaryAgent.tools,
      this._capabilities,
      this._skills,
    );
  }

  /**
   * Refresh skills from disk. Called automatically before each API call
   * so that newly installed, removed, or modified skills take effect
   * without a manual reload step.
   */
  private _refreshSkills(): void {
    if (this._skillRoots.length === 0) return;
    const freshAll = loadSkillsMulti(this._skillRoots);
    const filtered = new Map<string, SkillMeta>();
    for (const [name, skill] of freshAll) {
      if (!this._disabledSkills.has(name)) {
        filtered.set(name, skill);
      }
    }
    this._skills = filtered;
    this._ensureSkillTool();
  }

  /** Execute the `skill` tool — load and return skill instructions. */
  private _execSkill(
    args: Record<string, unknown>,
  ): ToolResult {
    const name = ((args["name"] as string) ?? "").trim();
    if (!name) {
      return new ToolResult({ content: "Error: 'name' parameter is required." });
    }

    const skill = this._skills.get(name);
    if (!skill) {
      const available = [...this._skills.keys()].join(", ");
      return new ToolResult({
        content: `Error: Unknown skill "${name}". Available: ${available || "(none)"}`,
      });
    }

    if (skill.disableModelInvocation) {
      return new ToolResult({
        content: `Error: Skill "${name}" can only be invoked by the user via /${name}.`,
      });
    }

    const skillArgs = ((args["arguments"] as string) ?? "").trim();
    const content = resolveSkillContent(skill, skillArgs);

    return new ToolResult({
      content:
        `[SKILL: ${skill.name}]\n` +
        `Skill directory: ${skill.dir}\n\n` +
        content,
    });
  }

  // ==================================================================
  // Session title
  // ==================================================================

  setTitle(title: string): void {
    this._title = title || undefined;
    // No onSaveRequest — renaming should not update last_active_at.
    // The caller (store:renameSession) writes title to disk directly.
  }

  getTitle(): string | undefined {
    return this._title;
  }

  getDisplayName(): string {
    return this._title || this._generateSummary();
  }

  // ==================================================================
  // Plan state
  // ==================================================================

  getPlanState(): PlanCheckpoint[] {
    return this._planState;
  }

  subscribePlan(listener: () => void): () => void {
    this._planListeners.push(listener);
    return () => {
      const idx = this._planListeners.indexOf(listener);
      if (idx !== -1) this._planListeners.splice(idx, 1);
    };
  }

  private _notifyPlanListeners(): void {
    for (const listener of this._planListeners) {
      listener();
    }
  }

  /**
   * Resolve the plan file path. Returns undefined if artifacts dir
   * is not yet available (session storage not created).
   */
  private _getPlanFilePath(): string | undefined {
    const dir = this._sessionArtifactsOverride
      || this._getArtifactsDirIfAvailable();
    if (!dir) return undefined;
    return join(dir, PLAN_FILENAME);
  }

  /**
   * Read and parse the plan file if it exists.
   * Updates _planState and notifies listeners if changed.
   */
  private _refreshPlanState(): void {
    const planPath = this._getPlanFilePath();
    if (!planPath || !existsSync(planPath)) {
      if (this._planState.length > 0) {
        this._planState = [];
        this._notifyPlanListeners();
      }
      return;
    }
    try {
      const content = readFileSync(planPath, "utf-8");
      this._planState = parsePlanFile(content);
      this._notifyPlanListeners();
    } catch {
      // File read error — leave state unchanged.
    }
  }

  // ==================================================================
  // Thinking level + cache hit
  // ==================================================================

  get thinkingLevel(): string {
    return this._thinkingLevel;
  }

  set thinkingLevel(value: string) {
    this._preferredThinkingLevel = value;
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      value,
    );
  }

  get accentColor(): string | undefined {
    return this._preferredAccentColor;
  }

  set accentColor(value: string | undefined) {
    this._preferredAccentColor = value;
  }

  /** The model name from the primary agent's config. */
  get currentModelName(): string {
    return this.primaryAgent.modelConfig.model;
  }

  /** The config name for the current model (e.g., "my-claude"). */
  get currentModelConfigName(): string {
    return this.primaryAgent.modelConfig.name;
  }

  /**
   * Switch the primary agent to a different model config.
   * Only callable between turns (not while a turn is in progress).
   */
  switchModel(modelConfigName: string): void {
    const newModelConfig = this.config.getModel(modelConfigName);
    this.primaryAgent.replaceModelConfig(newModelConfig);
    this._persistedModelSelection = this._buildPersistedModelSelection({
      modelConfigName,
      modelProvider: newModelConfig.provider,
      modelSelectionKey: newModelConfig.model,
      modelId: newModelConfig.model,
    });
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      newModelConfig.model,
      this._preferredThinkingLevel,
    );
    if (this._turnCount === 0) {
      this._updateInitialTokenEstimate();
      this._notifyLogListeners();
    }
  }

  applyGlobalPreferences(preferences: GlobalTuiPreferences): void {
    const prefs = createGlobalTuiPreferences(preferences);
    this._preferredThinkingLevel = prefs.thinkingLevel;
    this._preferredAccentColor = prefs.accentColor;
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      prefs.thinkingLevel,
    );

    // Restore disabled skills
    if (prefs.disabledSkills && prefs.disabledSkills.length > 0) {
      this._disabledSkills = new Set(prefs.disabledSkills);
      this.reloadSkills();
    }

    // Restore permission mode
    if (prefs.permissionMode && ["read_only", "reversible", "yolo"].includes(prefs.permissionMode)) {
      this._permissionAdvisor.sessionMode = prefs.permissionMode as PermissionMode;
    }
  }

  /**
   * Apply settings from the new FermiSettings + ModelSelectionState system.
   * This replaces applyGlobalPreferences for the new config architecture.
   */
  applySettings(settings: FermiSettings, modelState: ModelSelectionState): void {
    const thinkingLevel = modelState.thinking_level ?? settings.thinking_level ?? "";
    this._preferredThinkingLevel = thinkingLevel;
    this._preferredAccentColor = settings.accent_color;
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      thinkingLevel,
    );

    // Restore disabled skills
    if (settings.disabled_skills && settings.disabled_skills.length > 0) {
      this._disabledSkills = new Set(settings.disabled_skills);
      this.reloadSkills();
    }

    // Restore permission mode
    if (settings.permission_mode && ["read_only", "reversible", "yolo"].includes(settings.permission_mode)) {
      this._permissionAdvisor.sessionMode = settings.permission_mode as PermissionMode;
    }
  }

  getGlobalPreferences(): GlobalTuiPreferences {
    return createGlobalTuiPreferences({
      modelConfigName: this._persistedModelSelection.modelConfigName ?? undefined,
      modelProvider: this._persistedModelSelection.modelProvider ?? undefined,
      modelSelectionKey: this._persistedModelSelection.modelSelectionKey ?? undefined,
      modelId: this._persistedModelSelection.modelId ?? undefined,
      thinkingLevel: this._preferredThinkingLevel,
      accentColor: this._preferredAccentColor,
      disabledSkills: this._disabledSkills.size > 0
        ? [...this._disabledSkills]
        : undefined,
      permissionMode: this._permissionAdvisor.sessionMode,
    });
  }

  private _resolveThinkingLevelForModel(modelName: string, preferredLevel: string): string {
    const levels = getThinkingLevels(modelName);
    const highest = levels.length > 0 ? levels[levels.length - 1] : undefined;
    // Non-thinking model — no thinking level to set
    if (!highest) return "none";
    // No preference or legacy "default" — use highest
    if (!preferredLevel || preferredLevel === "default") return highest;
    // Preferred level valid for this model — use it
    if (levels.includes(preferredLevel)) return preferredLevel;
    // Preferred level not available on this model — use highest
    return highest;
  }

  /** Input tokens from the most recent provider response. */
  get lastInputTokens(): number {
    return this._lastInputTokens;
  }

  set lastInputTokens(value: number) {
    this._lastInputTokens = value;
  }

  /** Total tokens (input + output) from the most recent provider response. */
  get lastTotalTokens(): number {
    return this._lastTotalTokens;
  }

  set lastTotalTokens(value: number) {
    this._lastTotalTokens = value;
  }

  /** Cache-read tokens from the most recent provider response. */
  get lastCacheReadTokens(): number {
    return this._lastCacheReadTokens;
  }

  set lastCacheReadTokens(value: number) {
    this._lastCacheReadTokens = value;
  }

  /** Effective context budget: contextLength × contextRatio. */
  get contextBudget(): number {
    return Math.round((this.primaryAgent?.modelConfig?.contextLength ?? 0) * this._contextRatio);
  }

  appendStatusMessage(text: string, statusType = "status", ephemeral = false): void {
    const entry = createStatus(this._nextLogId("status"), this._turnCount, text, statusType);
    if (ephemeral) {
      (entry.meta as Record<string, unknown>)["ephemeral"] = true;
    }
    this._appendEntry(entry, true);
  }

  appendErrorMessage(text: string, errorType?: string): void {
    this._appendEntry(
      createErrorEntry(this._nextLogId("error"), this._turnCount, text, errorType),
      true,
    );
  }

  private _getManualContextCommandBlocker(command: "/summarize" | "/compact"): string | null {
    if (this._compactInProgress) {
      return `Cannot run ${command} while compact is in progress.`;
    }
    if (this._agentState !== "idle") {
      return `Cannot run ${command} while the current turn is still running.`;
    }
    if (this._activeAsk) {
      return `Cannot run ${command} while an ask is pending.`;
    }
    if (this._pendingTurnState) {
      return `Cannot run ${command} while a turn is waiting to resume.`;
    }
    if (this._hasActiveAgents()) {
      return `Cannot run ${command} while sub-agents are still running.`;
    }
    if (this._hasRunningShells()) {
      return `Cannot run ${command} while background shells are still running.`;
    }
    if (this._hasInboxMessages()) {
      return `Cannot run ${command} while queued messages are waiting to be delivered.`;
    }
    if (this._hasInboxMessages()) {
      return `Cannot run ${command} while sub-agent results are waiting to be delivered.`;
    }
    return null;
  }

  private async _runInjectedTurn(
    displayText: string,
    content: string,
    opts?: { signal?: AbortSignal; turnKind?: TurnKind },
  ): Promise<string> {
    const userCtxId = this._allocateContextId();
    this._lastTurnEndStatus = null;
    this._turnCount += 1;
    this._appendEntry(
      createTurnStart(this._nextLogId("turn_start"), this._turnCount, opts?.turnKind ?? "summarize"),
      false,
    );
    this._appendEntry(
      createUserMessageEntry(
        this._nextLogId("user_message"),
        this._turnCount,
        displayText,
        content,
        userCtxId,
      ),
      false,
    );
    this.onSaveRequest?.();

    const textAccumulator = { text: "" };
    const reasoningAccumulator = { text: "" };
    return this._runTurnActivationLoop(opts?.signal, textAccumulator, reasoningAccumulator);
  }

  /**
   * Return the list of items available for the /summarize picker.
   * Includes real user turns and visible summary entries in the active window.
   * Excludes the current turn.
   */
  getSummarizeTargets(): Array<{
    kind: "turn" | "summary";
    turnIndex: number;
    preview: string;
    timestamp: number;
    contextId?: string;
  }> {
    // Find active window start
    let windowStart = 0;
    for (let i = this._log.length - 1; i >= 0; i--) {
      if (this._log[i].type === "compact_marker" && !this._log[i].discarded) {
        windowStart = i + 1;
        break;
      }
    }

    // Collect covered set to exclude superseded summaries
    const coveredSet = buildCoveredContextIds(this._log);

    // 1. Real user turns in active window
    const items: Array<{
      kind: "turn" | "summary";
      turnIndex: number;
      preview: string;
      timestamp: number;
      contextId?: string;
      sortKey: number;
    }> = [];

    for (const t of this.listTurns()) {
      if (!t.inActiveWindow || t.turnKind !== "user") continue;
      if (t.turnIndex > this._turnCount) continue;
      items.push({
        kind: "turn",
        turnIndex: t.turnIndex,
        preview: t.preview,
        timestamp: t.timestamp,
        sortKey: t.entryIndex,
      });
    }

    // 2. Visible summary entries in active window (not superseded)
    for (let i = windowStart; i < this._log.length; i++) {
      const entry = this._log[i];
      if (entry.type !== "summary" || entry.discarded) continue;
      const ctxId = (entry.meta as Record<string, unknown>)["contextId"] as string | undefined;
      if (ctxId && coveredSet.has(ctxId)) continue;
      const display = (entry.display || "").slice(0, 80).replace(/\n/g, " ");
      items.push({
        kind: "summary",
        turnIndex: entry.turnIndex,
        preview: display || "(summary)",
        timestamp: entry.timestamp,
        contextId: ctxId,
        sortKey: i,
      });
    }

    items.sort((a, b) => a.sortKey - b.sortKey);
    return items.map(({ sortKey: _, ...rest }) => rest);
  }

  /**
   * Map a turn range to the set of visible (non-covered) context IDs.
   * Only includes context IDs in the active window that are not already
   * covered by a later summary.
   */
  getContextIdsForTurnRange(startTurn: number, endTurn: number): string[] {
    const coveredSet = buildCoveredContextIds(this._log);
    const contextIds: string[] = [];
    const seen = new Set<string>();

    // Find active window start
    let windowStart = 0;
    for (let i = this._log.length - 1; i >= 0; i--) {
      if (this._log[i].type === "compact_marker" && !this._log[i].discarded) {
        windowStart = i + 1;
        break;
      }
    }

    for (let i = windowStart; i < this._log.length; i++) {
      const entry = this._log[i];
      if (entry.turnIndex < startTurn || entry.turnIndex > endTurn) continue;
      if (entry.discarded) continue;
      const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
      if (!ctxId || typeof ctxId !== "string") continue;
      if (coveredSet.has(ctxId)) continue;
      if (seen.has(ctxId)) continue;
      seen.add(ctxId);
      contextIds.push(ctxId);
    }

    return contextIds;
  }

  static readonly SUMMARIZE_TOOL_WHITELIST = new Set([
    "show_context", "summarize", "read_file", "grep", "glob", "list_dir",
  ]);

  async runManualSummarize(
    options?: {
      signal?: AbortSignal;
      targetContextIds?: string[];
      focusPrompt?: string;
    },
  ): Promise<string> {
    return this._withTurnLock(async () => {
      this._ensureSessionStorageReady();
      await this._ensureMcp();

      const blocker = this._getManualContextCommandBlocker("/summarize");
      if (blocker) throw new Error(blocker);

      const targetIds = options?.targetContextIds;
      if (!targetIds || targetIds.length === 0) {
        throw new Error("/summarize requires selecting target turns first.");
      }

      const idList = targetIds.map(id => `  - ${id}`).join("\n");
      let prompt = [
        `[Targeted summarize request]`,
        ``,
        `The user has selected the following context groups to be summarized:`,
        idList,
        ``,
        `Instructions:`,
        `1. First call \`show_context\` to inspect the content and size of each group.`,
        `2. You may call \`read_file\`, \`grep\`, \`glob\`, or \`list_dir\` to verify details before writing the summary.`,
        `3. Call \`summarize\` to compress the selected groups. You MUST only target the context_ids listed above.`,
        `4. Your summary content should match the information density of the original — do not over-compress.`,
        `   Preserve: user message intent and original wording, file paths with line numbers, key decisions and why,`,
        `   unresolved issues, code references you'd look back at, and any constraints or rules the user stated.`,
        `5. After summarizing, reply briefly with what you compressed and stop.`,
        ``,
        `Do NOT continue the main task. Do NOT call show_context(dismiss=true).`,
      ].join("\n");
      if (options?.focusPrompt?.trim()) {
        prompt += `\n\nUser focus: ${options.focusPrompt.trim()}`;
      }
      const displayText = options?.focusPrompt?.trim()
        ? `/summarize ${options.focusPrompt.trim()}`
        : `/summarize ${targetIds.length} context groups`;

      // Enable tool whitelist for this turn
      this._summarizeToolWhitelist = (this.constructor as typeof Session).SUMMARIZE_TOOL_WHITELIST;
      try {
        return await this._runInjectedTurn(
          displayText,
          prompt,
          { signal: options?.signal, turnKind: "summarize" },
        );
      } finally {
        this._summarizeToolWhitelist = null;
      }
    });
  }

  async runManualCompact(instruction?: string, options?: { signal?: AbortSignal }): Promise<void> {
    return this._withTurnLock(async () => {
      this._ensureSessionStorageReady();

      const blocker = this._getManualContextCommandBlocker("/compact");
      if (blocker) throw new Error(blocker);

      this._turnCount += 1;
      this._lastTurnEndStatus = null;
      this._appendEntry(
        createTurnStart(this._nextLogId("turn_start"), this._turnCount, "compact"),
        false,
      );
      this._appendEntry(
        createStatus(
          this._nextLogId("status"),
          this._turnCount,
          "[Manual compact requested]",
          "manual_compact",
        ),
        false,
      );
      this.onSaveRequest?.();

      const prompt = appendManualInstruction(
        COMPACT_PROMPT_OUTPUT,
        instruction,
        "compact",
      );
      const prevAgentState = this._agentState;
      const turnSignalState = this._installCurrentTurnSignal(options?.signal);
      this._agentState = "working";
      try {
        await this._doAutoCompact("output", turnSignalState.signal, prompt);
        this._hintState = "none";
        this.onSaveRequest?.();
      } finally {
        this._restoreCurrentTurnSignal(turnSignalState);
        this._agentState = prevAgentState;
      }
    });
  }

  // ==================================================================
  // Ask state
  // ==================================================================

  /**
   * Restore ask state from log entries.
   * Scans for unclosed ask_request (no matching ask_resolution).
   */
  /**
   * ESC-deny model: on restore, any open ask_request without a matching
   * ask_resolution is treated as "user never decided" → synthesize a
   * Deny/Decline resolution + a matching tool_result so the model sees
   * a definite outcome. Must run BEFORE _normalizeInterruptedTurnFromLog.
   */
  private _resolveOpenAsksAsDenyOnRestore(): void {
    const log = this._log;
    const resolvedAskIds = new Set<string>();
    for (const e of log) {
      if (e.discarded) continue;
      if (e.type === "ask_resolution") {
        resolvedAskIds.add(String((e.meta as Record<string, unknown>)["askId"] ?? ""));
      }
    }

    const openAsks: LogEntry[] = [];
    for (const e of log) {
      if (e.discarded) continue;
      if (e.type !== "ask_request") continue;
      const askId = String((e.meta as Record<string, unknown>)["askId"] ?? "");
      if (!resolvedAskIds.has(askId)) openAsks.push(e);
    }
    if (openAsks.length === 0) return;

    for (const askEntry of openAsks) {
      const askId = String((askEntry.meta as Record<string, unknown>)["askId"] ?? "");
      const askKind = String((askEntry.meta as Record<string, unknown>)["askKind"] ?? "agent_question");
      const roundIndex = typeof (askEntry.meta as Record<string, unknown>)["roundIndex"] === "number"
        ? ((askEntry.meta as Record<string, unknown>)["roundIndex"] as number)
        : (askEntry.roundIndex ?? this._computeNextRoundIndex());
      const payload = askEntry.content as Record<string, unknown> | null;
      const toolCallId = String((askEntry.meta as Record<string, unknown>)["toolCallId"] ?? "");

      if (askKind === "approval") {
        const toolName = String(payload?.["toolName"] ?? "");
        this._appendEntry(createAskResolution(
          this._nextLogId("ask_resolution"),
          askEntry.turnIndex,
          { choice: "Deny", toolName, restored: true },
          askId,
          "approval",
        ), false);
        if (toolCallId) {
          const ctxId = this._findToolCallContextId(toolCallId, roundIndex)
            ?? this._allocateContextId();
          this._appendEntry(createToolResultEntry(
            this._nextLogId("tool_result"),
            askEntry.turnIndex,
            roundIndex,
            {
              toolCallId,
              toolName: toolName || "bash",
              content: "ERROR: Tool execution was cancelled before user decision (session restored).",
              toolSummary: `${toolName || "tool"} cancelled`,
            },
            { isError: true, contextId: ctxId },
          ), false);
        }
      } else {
        this._appendEntry(createAskResolution(
          this._nextLogId("ask_resolution"),
          askEntry.turnIndex,
          { declined: true, restored: true },
          askId,
          "agent_question",
        ), false);
        const askToolCallId = toolCallId || (payload?.["toolCallId"] as string | undefined) || "ask";
        const ctxId = this._findToolCallContextId(askToolCallId, roundIndex)
          ?? this._allocateContextId();
        this._appendEntry(createToolResultEntry(
          this._nextLogId("tool_result"),
          askEntry.turnIndex,
          roundIndex,
          {
            toolCallId: askToolCallId,
            toolName: "ask",
            content: "ERROR: User declined to answer the question (session restored).",
            toolSummary: "ask declined",
          },
          { isError: true, contextId: ctxId },
        ), false);
      }
    }
  }

  getPendingAsk(): PendingAskUi | null {
    const ownAsk = toPendingAskUi(this._activeAsk);
    if (ownAsk) return ownAsk;
    for (const handle of this._childSessions.values()) {
      const childAsk = handle.session.getPendingAsk();
      if (childAsk) return childAsk;
    }
    return null;
  }

  hasPendingTurnToResume(): boolean {
    return this._pendingTurnState !== null;
  }

  resolveAsk(
    askId: string,
    _decision: string,
    _inputText?: string,
  ): void {
    const ask = this._activeAsk;
    if (!ask) {
      throw new Error("No active ask to resolve.");
    }
    if (ask.id !== askId) {
      throw new Error(`Ask id mismatch (active=${ask.id}, got=${askId}).`);
    }
    throw new Error("Use resolveAgentQuestionAsk() for agent_question asks.");
  }

  private _emitAskRequestedProgress(ask: AskRequest): void {
    if (!this._progress) return;
    this._progress.emit({
      step: this._turnCount,
      agent: ask.source.agentName || this.primaryAgent.name,
      action: "ask_requested",
      message: `  [ask] ${ask.summary}`,
      level: "normal" as ProgressLevel,
      timestamp: Date.now() / 1000,
      usage: {},
      extra: { ask: toPendingAskUi(ask) },
    });
  }

  private _emitAskResolvedProgress(askId: string, decision: string, askKind?: string): void {
    if (!this._progress) return;
    this._progress.emit({
      step: this._turnCount,
      agent: this.primaryAgent.name,
      action: "ask_resolved",
      message: `  [ask] resolved: ${decision}`,
      level: "normal" as ProgressLevel,
      timestamp: Date.now() / 1000,
      usage: {},
      extra: { askId, decision, askKind },
    });
  }

  /** Returns true if the path is strictly inside the session artifacts dir. */
  private _isInsideArtifactsDir(rawPath: unknown): boolean {
    if (typeof rawPath !== "string" || !rawPath) return false;
    const artifactsDir = this._getArtifactsDirIfAvailable();
    if (!artifactsDir) return false;
    const absPath = isAbsolute(rawPath) ? rawPath : resolve(this._projectRoot, rawPath);
    const rel = relative(artifactsDir, absPath);
    if (!rel) return false; // exact match means writing the artifacts dir itself
    if (rel.startsWith("..")) return false;
    if (isAbsolute(rel)) return false;
    return true;
  }

  private _beforeToolExecute = async (
    ctx: ToolPreflightContext,
  ): Promise<ToolPreflightDecision | void> => {
    // 0a. /summarize tool whitelist: reject tools not in the whitelist
    if (this._summarizeToolWhitelist) {
      if (!this._summarizeToolWhitelist.has(ctx.toolName)) {
        return {
          kind: "deny",
          message: `Tool "${ctx.toolName}" is not available during /summarize. Allowed: ${[...this._summarizeToolWhitelist].join(", ")}.`,
        };
      }
      // Block show_context(dismiss=true) during /summarize
      if (ctx.toolName === "show_context") {
        const args = ctx.toolArgs as Record<string, unknown>;
        if (args["dismiss"]) {
          return {
            kind: "deny",
            message: "Cannot dismiss context annotations during /summarize.",
          };
        }
      }
    }

    // 0b. Artifacts-dir bypass: write_file/edit_file inside session artifacts/
    //    don't need approval (Fermi-style auto-allow for agent-owned scratch space).
    const isFileWrite = ctx.toolName === "write_file" || ctx.toolName === "edit_file";
    const skipPermissionGate =
      isFileWrite && this._isInsideArtifactsDir((ctx.toolArgs as Record<string, unknown>)["path"]);

    // 1. Permission gate check (skip for artifacts writes)
    if (!skipPermissionGate) {
      const decision = await this.toolGate.evaluate(ctx);
      switch (decision.kind) {
        case "deny":
          return { kind: "deny", message: decision.message };
        case "ask": {
          const options = decision.offers.map((o) => o.label);
          options.push("Deny");

          const BROAD_RULE_COMMANDS = new Set(["cp", "mv", "rm", "chmod", "chown"]);
          const hasPersistent = decision.offers.some(o => o.type === "tool_pattern");
          const pattern = decision.assessment.canonicalPattern ?? "";
          const persistentWarning = hasPersistent && BROAD_RULE_COMMANDS.has(pattern)
            ? `Persistent rules below will apply to ALL "${pattern}" commands, which may cause DANGER.`
            : undefined;

          const ask: ApprovalRequest = {
            id: `approval-${randomUUID().slice(0, 8)}`,
            kind: "approval",
            createdAt: new Date().toISOString(),
            source: { agentId: ctx.agentName },
            summary: decision.question,
            roundIndex: undefined,
            payload: {
              toolCallId: ctx.toolCallId,
              toolName: ctx.toolName,
              toolSummary: ctx.summary,
              permissionClass: decision.assessment.permissionClass,
              offers: decision.offers.map((o) => ({
                type: o.type,
                label: o.label,
                scope: o.scope,
                rule: o.rule as Record<string, unknown> | undefined,
              })),
              persistentWarning,
            },
            options,
          };
          return { kind: "ask", ask };
        }
      }
    }

    // 2. PreToolUse hooks (run after permission gate allows)
    if (this.hookRuntime.hooks.length > 0) {
      const hookPayload: HookPayload = {
        event: "PreToolUse",
        timestamp: Date.now(),
        toolName: ctx.toolName,
        toolArgs: ctx.toolArgs,
        toolCallId: ctx.toolCallId,
      };
      const hookResult = await this.hookRuntime.evaluate("PreToolUse", hookPayload);
      if (hookResult.decision === "deny") {
        return { kind: "deny", message: hookResult.denyReason ?? "Denied by hook" };
      }
      // Apply updatedInput from hooks (merge into tool args)
      if (hookResult.updatedInput) {
        Object.assign(ctx.toolArgs, hookResult.updatedInput);
      }
    }

    return undefined;
  };


  // ==================================================================
  // Main turn loop
  // ==================================================================

  async resumePendingTurn(options?: { signal?: AbortSignal }): Promise<string> {
    return this._withTurnLock(async () => {
      if (this._activeAsk) {
        throw new Error("Cannot resume while an ask is still pending approval.");
      }
      const pending = this._pendingTurnState;
      if (!pending) return "";

      this._pendingTurnState = null;
      if (pending.stage === "pre_user_input") {
        // Already inside the lock — call the inner turn logic directly
        return this._turnInner(pending.userInput ?? "", options);
      }

      // Drain any pending tool_calls (including the just-approved one and any
      // siblings that were emitted in parallel but never reached). This is the
      // single, canonical execution path post-approval. Stops on suspension.
      const suspended = await this._drainPendingToolCalls();
      if (suspended) {
        // A new approval ask was raised; the TUI handles it, then resume()
        // is called again.
        return "";
      }

      // Post-resume activation boundary drain: tool_results from the
      // just-resolved approval are in the log; drain any queued inbox
      // messages before the model sees them in the next activation.
      if (this._hasInboxMessages()) {
        this._drainInboxAsEntries();
      }

      const textAccumulator = { text: "" };
      const reasoningAccumulator = { text: "" };
      const result = await this._runTurnActivationLoop(options?.signal, textAccumulator, reasoningAccumulator);
      // Notify parent of the resumed turn's output. Without this, post-approval
      // assistant_text is lost and agent_result.content shows "(no output)".
      if (!this._activeAsk) {
        this._turnOutputTarget?.(result?.trim() || "");
        if (result?.trim()) this._recordSessionEvent("returned output");
      }
      return result;
    });
  }

  /**
   * Drain pending tool_calls in the current turn (in emission order).
   * For each: gate → execute → append tool_result, updating tool_call meta.
   * Returns true if a new approval ask was raised (suspends the loop).
   *
   * This is the single canonical path for executing tool_calls outside of
   * the streaming tool-loop — used after approval resume and to handle
   * orphan parallel tool_calls.
   */
  private async _drainPendingToolCalls(): Promise<boolean> {
    while (true) {
      const next = this._findNextPendingToolCall();
      if (!next) return false;

      // Mark as running in tool_call meta so the display shows shimmer.
      this._updateToolCallExecState(next.toolCallId, "running");

      const ctx: ToolPreflightContext = {
        agentName: next.agentName,
        toolName: next.toolName,
        toolArgs: next.toolArgs,
        toolCallId: next.toolCallId,
        summary: `${next.agentName} is calling ${next.toolName}`,
      };

      let denyMessage: string | undefined;
      let allowOnce = false;
      // Skip the permission gate if this tool_call was already approved
      // (allow-once grant was set in resolveApprovalAsk before resume).
      allowOnce = this._permissionAdvisor["_allowOnceGrants"].has(next.toolCallId);
      if (!allowOnce) {
        const decision = await this._beforeToolExecute(ctx);
        if (decision && decision.kind === "ask") {
          const ask = decision.ask;
          const askContextId = this._findToolCallContextId(next.toolCallId, next.roundIndex);
          this._updateToolCallExecState(next.toolCallId, "not_started");
          this._activeAsk = ask;
          this._emitAskRequestedProgress(this._activeAsk);
          this._appendEntry(createAskRequest(
            this._nextLogId("ask_request"),
            this._turnCount,
            this._activeAsk.payload,
            this._activeAsk.id,
            this._activeAsk.kind,
            next.toolCallId,
            next.roundIndex,
            askContextId,
          ), false);
          this._pendingTurnState = { stage: "activation" };
          this.onSaveRequest?.();
          return true;
        }
        if (decision && decision.kind === "deny") {
          denyMessage = decision.message;
        }
      } else {
        // Gate already passed; still run hooks
        if (this.hookRuntime.hooks.length > 0) {
          const hookResult = await this.hookRuntime.evaluate("PreToolUse", {
            event: "PreToolUse",
            timestamp: Date.now(),
            toolName: next.toolName,
            toolArgs: next.toolArgs,
            toolCallId: next.toolCallId,
          });
          if (hookResult.decision === "deny") {
            denyMessage = hookResult.denyReason ?? "Denied by hook";
          } else if (hookResult.updatedInput) {
            Object.assign(next.toolArgs, hookResult.updatedInput);
          }
        }
      }

      // Execute (or deny)
      const contextId = this._findToolCallContextId(next.toolCallId, next.roundIndex)
        ?? this._allocateContextId();
      const execStartMs = Date.now();
      let resultContent = "";
      let isError = false;
      let toolMetadata: Record<string, unknown> = {};

      if (denyMessage) {
        resultContent = `ERROR: ${denyMessage}`;
        isError = true;
      } else {
        const executor = this._toolExecutors[next.toolName];
        try {
          if (!executor) {
            resultContent = `ERROR: No executor for tool '${next.toolName}'`;
            isError = true;
          } else {
            const result = await executor(next.toolArgs, { signal: this._currentTurnSignal ?? undefined });
            if (typeof result === "string") {
              resultContent = result;
            } else if (result instanceof ToolResult) {
              resultContent = result.content;
              toolMetadata = { ...result.metadata };
              if (result.contentBlocks) {
                toolMetadata._contentBlocks = result.contentBlocks;
              }
            } else {
              resultContent = String(result);
            }
            isError = resultContent.startsWith("ERROR:");
          }
        } catch (e) {
          resultContent = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
          isError = true;
        }
      }

      // Build preview (matches tool-loop's logic)
      const previewSrc = toolMetadata["tui_preview"];
      let previewText: string | undefined;
      let previewDim: boolean | undefined;
      if (previewSrc && typeof previewSrc === "object") {
        const text = (previewSrc as Record<string, unknown>)["text"];
        if (typeof text === "string" && text.trim()) {
          previewText = text;
          previewDim = (previewSrc as Record<string, unknown>)["dim"] === true ? true : undefined;
        }
      }
      if (!previewText && !isError) {
        const lines = resultContent.split("\n");
        previewText = lines.length > 20
          ? lines.slice(0, 20).join("\n") + `\n... (${lines.length - 20} more lines)`
          : resultContent;
        previewDim = true;
      }

      this._appendEntry(createToolResultEntry(
        this._nextLogId("tool_result"),
        this._turnCount,
        next.roundIndex,
        {
          toolCallId: next.toolCallId,
          toolName: next.toolName,
          content: resultContent,
          toolSummary: `${next.toolName} ${isError ? "failed" : "completed"}`,
        },
        {
          isError,
          contextId,
          toolMetadata: Object.keys(toolMetadata).length > 0 ? toolMetadata : undefined,
          execStartMs,
          previewText,
          previewDim,
        },
      ));
      this._updateToolCallExecState(next.toolCallId, isError ? "failed" : "completed");

      if (this.hookRuntime.hooks.length > 0) {
        const event = isError ? "PostToolUseFailure" : "PostToolUse";
        this.hookRuntime.fireAndForget(event, {
          event,
          timestamp: Date.now(),
          toolName: next.toolName,
          toolCallId: next.toolCallId,
          agentId: next.agentName,
        });
      }

      this.onSaveRequest?.();
    }
  }

  /**
   * Find the next pending tool_call in the current turn (no matching result),
   * in log/emission order. Returns null when all are resolved.
   */
  private _findNextPendingToolCall(): {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    roundIndex: number;
    agentName: string;
  } | null {
    const resultIds = new Set<string>();
    for (const entry of this._log) {
      if (entry.type !== "tool_result") continue;
      if (entry.discarded) continue;
      if (entry.turnIndex !== this._turnCount) continue;
      const meta = entry.meta as Record<string, unknown>;
      const id = String(meta["toolCallId"] ?? "");
      if (id) resultIds.add(id);
    }

    for (const entry of this._log) {
      if (entry.type !== "tool_call") continue;
      if (entry.discarded) continue;
      if (entry.turnIndex !== this._turnCount) continue;
      const meta = entry.meta as Record<string, unknown>;
      const toolCallId = String(meta["toolCallId"] ?? "");
      if (!toolCallId || resultIds.has(toolCallId)) continue;
      const content = entry.content as { name?: string; arguments?: Record<string, unknown> };
      return {
        toolCallId,
        toolName: String(content.name ?? meta["toolName"] ?? ""),
        toolArgs: content.arguments ?? {},
        roundIndex: entry.roundIndex ?? 0,
        agentName: String(meta["agentName"] ?? this.primaryAgent.name),
      };
    }
    return null;
  }

  /** Update tool_call entry's toolExecState meta in-place. */
  private _updateToolCallExecState(
    toolCallId: string,
    state: "not_started" | "running" | "completed" | "failed",
  ): void {
    for (const entry of this._log) {
      if (entry.type !== "tool_call") continue;
      const meta = entry.meta as Record<string, unknown>;
      if (String(meta["toolCallId"] ?? "") !== toolCallId) continue;
      meta["toolExecState"] = state;
      this._touchLog();
      return;
    }
  }

  private async _runTurnActivationLoop(
    signal: AbortSignal | undefined,
    textAccumulator: { text: string },
    reasoningAccumulator: { text: string },
  ): Promise<string> {
    let finalText = "";
    let turnEndStatus: "completed" | "interrupted" | "error" | null = null;
    const turnSignalState = this._installCurrentTurnSignal(signal);
    const activeSignal = turnSignalState.signal;
    const turnStartMs = performance.now();
    try {
      let reachedLimit = true;
      for (let activationIdx = 0; activationIdx < MAX_ACTIVATIONS_PER_TURN; activationIdx++) {
        if (activeSignal.aborted) break;

        const t0 = performance.now();
        const logLenBeforeActivation = this._log.length;
        textAccumulator.text = "";
        reasoningAccumulator.text = "";
        this._agentState = "working";
        this._setSelfPhase("thinking");

        if (this._progress) {
          this._progress.onAgentStart(this._turnCount, this.primaryAgent.name);
        }

        let result: ToolLoopResult;
        try {
          result = await this._runActivation(activeSignal, textAccumulator, reasoningAccumulator);
        } catch (err: unknown) {
          if ((err as any)?.name === "AbortError" || activeSignal.aborted) {
            this._handleInterruption(logLenBeforeActivation, textAccumulator.text, {
              activationCompleted: false,
            });
            this.onSaveRequest?.();
            finalText = textAccumulator.text.trim() || "";
            turnEndStatus = "interrupted";
            break;
          }

          throw err;
        }

        // Check abort AFTER successful completion — handles providers that
        // don't throw AbortError (stream finishes before abort takes effect).
        if (activeSignal.aborted) {
          this._handleInterruption(logLenBeforeActivation, textAccumulator.text, {
            activationCompleted: true,
          });
          this.onSaveRequest?.();
          finalText = textAccumulator.text.trim() || "";
          turnEndStatus = "interrupted";
          break;
        }

        this._lastInputTokens = result.lastInputTokens;
        this._lastTotalTokens = result.lastTotalTokens ?? 0;
        this._updateHintStateAfterApiCall();

        if (result.suspendedAsk) {
          const askContextId =
            this._findToolCallContextId(result.suspendedAsk.toolCallId, result.suspendedAsk.roundIndex);
          this._activeAsk = result.suspendedAsk.ask;
          this._emitAskRequestedProgress(this._activeAsk);
          this._appendEntry(createAskRequest(
            this._nextLogId("ask_request"),
            this._turnCount,
            this._activeAsk.payload,
            this._activeAsk.id,
            this._activeAsk.kind,
            result.suspendedAsk.toolCallId,
            result.suspendedAsk.roundIndex,
            askContextId,
          ), false);
          if (!result.compactNeeded) {
            this._checkAndInjectHint(result);
          }
          this.onSaveRequest?.();
          reachedLimit = false;
          break;
        }

        const elapsed = (performance.now() - t0) / 1000;
        let agentEndEmitted = false;

        const emitAgentEndOnce = () => {
          if (agentEndEmitted || !this._progress) return;
          this._progress.onAgentEnd(
            this._turnCount,
            this.primaryAgent.name,
            elapsed,
            result.totalUsage as Record<string, number>,
          );
          agentEndEmitted = true;
        };

        const _trimmedText = result.text.trimEnd();
        const _hasNoReply = isNoReply(result.text)
          || _trimmedText.endsWith(NO_REPLY_MARKER)
          || (!_trimmedText && result.toolHistory.length === 0);

        if (_hasNoReply) {
          // Strip the <NO_REPLY> marker (if present) — treat as empty response.
          // Emit progress event so TUI can show a status message.
          if (_trimmedText.endsWith(NO_REPLY_MARKER)) {
            result.text = _trimmedText
              .slice(0, _trimmedText.length - NO_REPLY_MARKER.length)
              .trim();
          }

          if (this._progress) {
            this._progress.onNoReplyClear(this.primaryAgent.name);
          }
          emitAgentEndOnce();
          if (this._progress) {
            this._progress.onAgentNoReply(this.primaryAgent.name);
          }
          // Fall through to normal response handling — turn ends naturally.
        }

        const shouldMaterializeFinalResponse =
          !result.compactNeeded || result.compactScenario === "output";

        if (result.text && shouldMaterializeFinalResponse) {
          finalText = result.text;

          // v2 log: create final assistant_text + optional reasoning entries
          {
            const finalRound = (result.textHandledInLog || result.reasoningHandledInLog)
              ? Math.max(0, this._computeNextRoundIndex() - 1)
              : this._computeNextRoundIndex();
            const finalContextId = this._resolveOutputRoundContextId(this._turnCount, finalRound);
            if (result.textHandledInLog || result.reasoningHandledInLog) {
              this._retagRoundEntries(this._turnCount, finalRound, finalContextId);
            }
            if (result.reasoningContent && !result.reasoningHandledInLog) {
              this._appendEntry(createReasoning(
                this._nextLogId("reasoning"),
                this._turnCount,
                finalRound,
                result.reasoningContent,
                result.reasoningContent,
                result.reasoningState,
                finalContextId,
              ), false);
            }
            if (!result.textHandledInLog) {
              const displayText = stripContextTags(result.text);
              this._appendEntry(createAssistantText(
                this._nextLogId("assistant_text"),
                this._turnCount,
                finalRound,
                displayText,
                stripContextTags(result.text),
                finalContextId,
              ), false);
            }
          }
        }

        emitAgentEndOnce();
        this.onSaveRequest?.();

        if (result.compactNeeded && result.compactScenario) {
          if (this._hasInboxMessages()) {
            this._drainInboxAsEntries();
          }
          const logLenBefore = this._log.length;
          try {
            await this._doAutoCompact(result.compactScenario, activeSignal);
          } catch (compactErr) {
            if ((compactErr as any)?.name === "AbortError" || activeSignal.aborted) {
              // Mark compact-phase entries as discarded
              for (let ci = logLenBefore; ci < this._log.length; ci++) {
                this._log[ci].discarded = true;
              }
              this._appendEntry(createStatus(
                this._nextLogId("status"),
                this._turnCount,
                "[This turn was interrupted during context compaction.]",
                "compact_interrupted",
              ), false);
              this.onSaveRequest?.();
              finalText = textAccumulator.text.trim() || "";
              turnEndStatus = "interrupted";
              break;
            }
            throw compactErr;
          }
          this.onSaveRequest?.();

          if (result.compactScenario === "output") {
            reachedLimit = false;
            turnEndStatus = "completed";
            break;
          } else {
            // Reset activation budget after compact — the agent gets a fresh
            // context and should not be penalised for pre-compact activations.
            activationIdx = -1;  // for-loop increment will set it to 0
            continue;
          }
        }

        if (!result.compactNeeded) {
          this._checkAndInjectHint(result);
        }

        // Final output (no tool calls in the last provider call) → turn ends.
        // Sub-agent results are processed via auto-resume in a new turn.
        // Model should use await_event explicitly to wait for sub-agents.
        // Note: toolHistory.length is cumulative across all rounds in the tool
        // loop, so it can be > 0 even when the last call had no tool_calls.
        if (result.endedWithoutToolCalls) {
          reachedLimit = false;
          turnEndStatus = "completed";
          break;
        }

        // ★ ACTIVATION BOUNDARY DRAIN — after tool_results, before next activation ★
        if (this._hasInboxMessages()) {
          this._drainInboxAsEntries();
          continue;  // new activation to process drained messages
        }
      }

      if (reachedLimit && !activeSignal.aborted) {
        console.warn(`Turn reached activation limit (${MAX_ACTIVATIONS_PER_TURN})`);
        if (!finalText) {
          finalText =
            "[Turn terminated: reached maximum activation limit " +
            "without producing output. This may indicate a stuck loop.]";
        }
        turnEndStatus = "error";
      }
    } finally {
      this._restoreCurrentTurnSignal(turnSignalState);
      if (turnEndStatus === "interrupted" && this._hasActiveAgents()) {
        await this._waitForAllChildTurnsSettled();
      }
      // Drain any messages that arrived after the last activation boundary.
      if (!this._deferQueuedMessageInjectionOnTurnExit && this._hasInboxMessages()) {
        this._drainInboxAsEntries();
      }
      this._agentState = "idle";
      // Finalize tool_call entries stuck in non-terminal state (e.g. abort during await_event).
      // Scan backward: only the current round's tool_calls can be affected; stop at the first
      // non-tool_call entry after seeing at least one tool_call (entries are interleaved with
      // tool_result, token_update, etc. so we skip those).
      {
        let sawToolCall = false;
        for (let i = this._log.length - 1; i >= 0; i--) {
          const entry = this._log[i];
          if (entry.type !== "tool_call") {
            if (sawToolCall) break;
            continue;
          }
          sawToolCall = true;
          const execState = (entry.meta as Record<string, unknown>)["toolExecState"];
          if (execState === "running" || execState === "not_started") {
            (entry.meta as Record<string, unknown>)["toolExecState"] = "failed";
          }
        }
      }
      this._activeLogEntryId = null;
      this._setSelfPhase("idle");
      if (!this._activeAsk && this._turnCount > 0 && turnEndStatus) {
        this._lastTurnEndStatus = turnEndStatus;
        const turnElapsedMs = Math.round(performance.now() - turnStartMs);
        let interruptHints: string[] | undefined;
        if (turnEndStatus === "interrupted") {
          interruptHints = this._collectInterruptHints();
        }
        this._appendEntry(
          createTurnEnd(this._nextLogId("turn_end"), this._turnCount, turnEndStatus, turnElapsedMs, interruptHints),
          false,
        );
        this.onSaveRequest?.();
      }
      // If the finally drain wrote messages to the log without the model
      // seeing them, schedule an auto-resume turn to process them.
      if (!this._activeAsk && this._hasUnprocessedUserMessage()) {
        this._scheduleAutoResume();
      }
    }

    return finalText;
  }

  async turn(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[]; skipUserInput?: boolean }): Promise<string> {
    return this._withTurnLock(() => this._turnInner(userInput, options));
  }

  /** Inner turn logic, called from within the turn lock. */
  private async _turnInner(userInput: string, options?: { signal?: AbortSignal; inlineImages?: InlineImageInput[]; skipUserInput?: boolean }): Promise<string> {
    this._ensureSessionStorageReady();
    if (this._mcpManager) {
      await this._ensureMcp();
    }

    const signal = options?.signal;
    if (this._pendingTurnState && !this._activeAsk) {
      // Already inside the lock via turn() — handle resume inline to avoid deadlock
      if (this._activeAsk) {
        throw new Error("Cannot resume while an ask is still pending approval.");
      }
      const pending = this._pendingTurnState;
      if (!pending) return "";
      this._pendingTurnState = null;
      if (pending.stage === "pre_user_input") {
        return this._turnInner(pending.userInput ?? "", options);
      }
      const ta = { text: "" };
      const ra = { text: "" };
      const resumed = await this._runTurnActivationLoop(options?.signal, ta, ra);
      if (resumed && !this._activeAsk) {
        this._turnOutputTarget?.(resumed);
        this._recordSessionEvent("returned output");
      }
      return resumed;
    }

    // skipUserInput path: auto-resume from idle. Drain inbox as individual
    // entries instead of writing a synthetic empty user input.
    if (options?.skipUserInput) {
      this._lastTurnEndStatus = null;
      this._turnCount += 1;
      this._appendEntry(
        createTurnStart(this._nextLogId("turn_start"), this._turnCount, "user"),
        false,
      );
      this._drainInboxAsEntries();
      this.onSaveRequest?.();
    } else {
      let userContent: string | Array<Record<string, unknown>>;
      try {
        userContent = await this._processFileAttachments(userInput);
      } catch (err) {
        if (isAskPendingError(err)) {
          this._pendingTurnState = { stage: "pre_user_input", userInput };
          this.onSaveRequest?.();
          return "";
        }
        throw err;
      }
      // Fire UserPromptSubmit hooks (can deny or modify the prompt)
      if (this.hookRuntime.hooks.length > 0) {
        this.hookRuntime.clearTurnContext();
        const hookResult = await this.hookRuntime.evaluate("UserPromptSubmit", {
          event: "UserPromptSubmit",
          timestamp: Date.now(),
          userPrompt: typeof userContent === "string" ? userContent : userInput,
        });
        if (hookResult.decision === "deny") {
          this.appendStatusMessage(
            `Prompt blocked by hook: ${hookResult.denyReason ?? "denied"}`,
            "hook_deny",
          );
          return "";
        }
      }

      // Assign context_id to user message (metadata only, no visible §{id}§ tag in content)
      const userCtxId = this._allocateContextId();
      this._lastTurnEndStatus = null;
      this._turnCount += 1;

      // v2 log: turn_start + user_message
      this._appendEntry(
        createTurnStart(this._nextLogId("turn_start"), this._turnCount, "user"),
        false,
      );
      // Merge inline images (clipboard paste) into multimodal content
      const inlineImages = options?.inlineImages;
      if (inlineImages && inlineImages.length > 0) {
        const parts: Array<Record<string, unknown>> = [];
        if (typeof userContent === "string") {
          if (userContent.trim()) {
            parts.push({ type: "text", text: userContent });
          }
        } else {
          parts.push(...userContent);
        }
        for (const img of inlineImages) {
          parts.push({
            type: "image",
            media_type: img.mediaType,
            data: img.base64,
          });
        }
        userContent = parts;
      }

      // display = original user input (what they typed); content = expanded for API
      const displayText = userInput;
      // For the log entry, replace inline base64 images with image_ref file paths
      const logContent = this._extractAndSaveImages(userContent);
      this._appendEntry(
        createUserMessageEntry(
          this._nextLogId("user_message"),
          this._turnCount,
          displayText,
          logContent,
          userCtxId,
        ),
        false,
      );
    }
    this.onSaveRequest?.();

    // Track streamed content for abort recovery
    const textAccumulator = { text: "" };
    const reasoningAccumulator = { text: "" };
    try {
      const result = await this._runTurnActivationLoop(signal, textAccumulator, reasoningAccumulator);
      // Always notify parent — even for empty results.
      if (!this._activeAsk) {
        this._turnOutputTarget?.(result?.trim() || "");
        if (result?.trim()) this._recordSessionEvent("returned output");
      }
      return result;
    } catch (err) {
      // Deliver error to parent so it's never silently lost
      if (!this._activeAsk) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this._turnOutputTarget?.(`[Error] ${errorMsg}`);
      }
      if (!this._activeAsk && this._turnCount > 0 && this._lastTurnEndStatus === null) {
        this._lastTurnEndStatus = "error";
        this._appendEntry(
          createTurnEnd(this._nextLogId("turn_end"), this._turnCount, "error"),
          false,
        );
        this.onSaveRequest?.();
      }
      throw err;
    }
  }

  /**
   * Handle interruption using structured log (v2).
   *
   * Rules:
   * - Keep completed reasoning, drop incomplete reasoning of the currently interrupted round
   * - Keep partial text and append " [Interrupted here.]" when interruption happens mid-activation
   * - For each complete tool_call lacking result, append interrupted tool_result
   * - Append synthetic interruption user message
   */
  private _handleInterruption(
    logLenBefore: number,
    accumulatedText: string,
    opts?: { activationCompleted?: boolean },
  ): void {
    const activationCompleted = opts?.activationCompleted ?? false;
    const interruptedSuffix = " [Interrupted here.]";
    const interruptedMarker = "[Interrupted here.]";

    // Clear ask runtime state and active entry tracker for interrupted turn.
    this._activeAsk = null;
    this._pendingTurnState = null;
    this._activeLogEntryId = null;

    let latestRound: number | undefined;
    let latestRoundHasToolCall = false;
    let hasAssistantInActivation = false;
    let latestAssistantEntry: LogEntry | null = null;

    for (let i = logLenBefore; i < this._log.length; i++) {
      const e = this._log[i];
      if (e.discarded) continue;
      if (e.roundIndex !== undefined && (latestRound === undefined || e.roundIndex > latestRound)) {
        latestRound = e.roundIndex;
      }
    }

    if (latestRound !== undefined) {
      for (let i = logLenBefore; i < this._log.length; i++) {
        const e = this._log[i];
        if (e.discarded || e.roundIndex !== latestRound) continue;
        if (e.type === "tool_call" && e.apiRole === "assistant") latestRoundHasToolCall = true;
      }
    }

    // Drop incomplete reasoning in the interrupted in-flight round only.
    if (!activationCompleted && latestRound !== undefined && !latestRoundHasToolCall) {
      for (let i = logLenBefore; i < this._log.length; i++) {
        const e = this._log[i];
        if (e.discarded) continue;
        if (e.roundIndex !== latestRound) continue;
        if (e.type === "reasoning") {
          e.discarded = true;
        }
      }
    }

    for (let i = logLenBefore; i < this._log.length; i++) {
      const e = this._log[i];
      if (e.type === "assistant_text" && !e.discarded) {
        hasAssistantInActivation = true;
        latestAssistantEntry = e;
      }
    }

    // Mid-activation interruption: materialize any unsaved partial text (without suffix).
    if (!activationCompleted && !latestAssistantEntry) {
      const partialText = stripContextTags(accumulatedText).trim();
      if (partialText) {
        const partialContextId = this._findPrecedingUserSideContextId() ?? this._allocateContextId();
        this._appendEntry(createAssistantText(
          this._nextLogId("assistant_text"),
          this._turnCount,
          this._computeNextRoundIndex(),
          partialText,
          partialText,
          partialContextId,
        ), false);
        hasAssistantInActivation = true;
      }
    }

    // Complete all materialized tool calls that have no results yet.
    // These tool calls were never executed (abort happened before tool execution).
    this._completeMissingToolResultsFromLog(
      logLenBefore,
      "[Interrupted] Tool was not executed.",
    );

    // Create [Interrupted here.] marker for API protocol (ensures proper role alternation
    // and model awareness), but hide from TUI — interrupted tools show their own status.
    const markerCtxId = this._findPrecedingUserSideContextId() ?? this._allocateContextId();
    const markerEntry = createAssistantText(
      this._nextLogId("assistant_text"),
      this._turnCount,
      this._computeNextRoundIndex(),
      interruptedMarker,
      interruptedMarker,
      markerCtxId,
    );
    markerEntry.tuiVisible = false;
    markerEntry.displayKind = null;
    this._appendEntry(markerEntry, false);

    const interruptionMessage = "Last turn was interrupted by the user.";
    this._recordSessionEvent("interrupted by user");
    const interruptionCtxId = this._allocateContextId();
    const interruptionEntry = createUserMessageEntry(
      this._nextLogId("user_message"),
      this._turnCount,
      interruptionMessage,
      interruptionMessage,
      interruptionCtxId,
    );
    // Keep interruption recovery context for the provider, but don't surface
    // this synthetic message in the conversation UI.
    interruptionEntry.tuiVisible = false;
    interruptionEntry.displayKind = null;
    this._appendEntry(interruptionEntry, false);
  }

  /**
   * Scan the current turn's log entries to collect human-readable interrupt hints.
   * Called after _handleInterruption, before writing turn_end.
   */
  private _collectInterruptHints(): string[] {
    const hints: string[] = [];
    const turnIdx = this._turnCount;
    let hasDiscardedReasoning = false;
    let hasPartialEffects = false;
    let hasIncompleteArgs = false;

    for (const e of this._log) {
      if (e.turnIndex !== turnIdx) continue;
      if (e.type === "reasoning" && e.discarded) {
        hasDiscardedReasoning = true;
      }
      if (e.type === "tool_result" && typeof e.display === "string") {
        if (e.display.includes("may have had partial effects")) {
          hasPartialEffects = true;
        }
        if (e.display.includes("Incomplete arguments")) {
          hasIncompleteArgs = true;
        }
      }
    }

    if (hasDiscardedReasoning) {
      hints.push("Thinking was discarded and not transmitted to the model.");
    }
    if (hasPartialEffects) {
      hints.push("Some tools may have had partial effects.");
    }
    if (hasIncompleteArgs) {
      hints.push("Some tools had incomplete arguments and were not executed.");
    }
    return hints;
  }

  private _toolMayHavePartialEffects(toolName: string): boolean {
    return !SAFE_INTERRUPT_TOOLS.has(toolName);
  }

  /**
   * Scan log entries from `fromIdx` onwards: for each tool_call entry,
   * check if a tool_result exists for it. Create missing tool_results.
   */
  private _completeMissingToolResultsFromLog(fromIdx: number, interruptedContent: string): void {
    const pendingToolCalls: Array<{
      id: string;
      name: string;
      roundIndex?: number;
      contextId?: string;
      execState?: string;
      streamState?: string;
    }> = [];
    const resolvedToolCallIds = new Set<string>();

    for (let i = fromIdx; i < this._log.length; i++) {
      const e = this._log[i];
      if (e.type === "tool_call") {
        if (e.apiRole !== "assistant") continue;
        const meta = e.meta as Record<string, unknown>;
        pendingToolCalls.push({
          id: (meta["toolCallId"] as string) ?? "",
          name: (meta["toolName"] as string) ?? "",
          roundIndex: e.roundIndex,
          contextId: typeof meta["contextId"] === "string" ? meta["contextId"] as string : undefined,
          execState: typeof meta["toolExecState"] === "string" ? meta["toolExecState"] as string : undefined,
          streamState: typeof meta["toolStreamState"] === "string" ? meta["toolStreamState"] as string : undefined,
        });
      } else if (e.type === "tool_result") {
        resolvedToolCallIds.add((e.meta as Record<string, unknown>)["toolCallId"] as string);
      }
    }

    for (const tc of pendingToolCalls) {
      if (resolvedToolCallIds.has(tc.id)) continue;
      if (!tc.id) continue;
      const content =
        tc.execState === "running"
          ? this._toolMayHavePartialEffects(tc.name)
            ? "[Interrupted] Tool execution was interrupted and may have had partial effects."
            : "[Interrupted] Tool execution was interrupted."
          : interruptedContent;
      this._appendEntry(createToolResultEntry(
        this._nextLogId("tool_result"),
        this._turnCount,
        tc.roundIndex ?? this._computeNextRoundIndex(),
        {
          toolCallId: tc.id,
          toolName: tc.name,
          content,
          toolSummary: content,
        },
        { isError: false, contextId: tc.contextId, previewText: content, previewDim: true },
      ), false);
    }
  }

  private _getLastSendableRole(): string | null {
    const messages = projectToApiMessages(this._log, {
      systemPrompt: this._getSystemPrompt(),
      resolveImageRef: (refPath) => this._resolveImageRef(refPath),
      requiresAlternatingRoles: (this.primaryAgent as any)._provider?.requiresAlternatingRoles,
    });
    if (messages.length === 0) return null;
    const role = messages[messages.length - 1]["role"];
    return typeof role === "string" ? role : null;
  }

  private _isUserSideProtocolRole(role: string | null): boolean {
    if (!role) return true;
    if (role === "assistant") return false;
    return true;
  }

  // ==================================================================
  // Activation
  // ==================================================================

  private async _runActivation(
    signal?: AbortSignal,
    textAccumulator?: { text: string },
    reasoningAccumulator?: { text: string },
    suppressStreaming?: boolean,
  ): Promise<ToolLoopResult> {
    const baseRoundIndex = this._computeNextRoundIndex();
    const streamedAssistantEntries = new Map<number, LogEntry>();
    const streamedReasoningEntries = new Map<number, LogEntry>();
    const textBuffers = new Map<number, NoReplyStreamBuffer>();
    const roundContextIds = new Map<number, string>();
    const getRoundContextId = (roundIndex: number): string => {
      let contextId = roundContextIds.get(roundIndex);
      if (!contextId) {
        contextId = this._allocateContextId();
        roundContextIds.set(roundIndex, contextId);
      }
      return contextId;
    };

    let onTextChunk: ((roundIndex: number, chunk: string) => boolean | void) | undefined;
    let onReasoningChunk: ((roundIndex: number, chunk: string) => boolean | void) | undefined;

    if (suppressStreaming) {
      // During compact phase: accumulate text but don't stream to TUI
      if (textAccumulator) {
        const stripBuf = new ContextTagStripBuffer((chunk: string) => {
          textAccumulator.text += chunk;
        });
        const buf = new NoReplyStreamBuffer((chunk: string) => stripBuf.feed(chunk));
        onTextChunk = (_roundIndex: number, chunk: string) => {
          buf.feed(chunk);
          return false;
        };
      }
      if (reasoningAccumulator) {
        onReasoningChunk = (_roundIndex: number, chunk: string) => {
          reasoningAccumulator.text += chunk;
          return false;
        };
      }
    } else {
      const agentName = this.primaryAgent.name;
      const progress = this._progress;

      // Track the last chunk kind per round so that when the provider
      // interleaves reasoning and text items (e.g. Responses API),
      // each contiguous segment gets its own LogEntry instead of being
      // merged into a single sticky entry at the first-chunk position.
      let lastStreamKind: "reasoning" | "text" | null = null;
      let lastStreamRound = -1;

      onTextChunk = (roundIndex: number, chunk: string) => {
        // If switching from reasoning → text in same round, start fresh buffers + entry
        if (lastStreamRound === roundIndex && lastStreamKind === "reasoning") {
          streamedAssistantEntries.delete(roundIndex);
          textBuffers.delete(roundIndex);
        }
        lastStreamKind = "text";
        lastStreamRound = roundIndex;

        let roundBuffer = textBuffers.get(roundIndex);
        if (!roundBuffer) {
          const stripBuf = new ContextTagStripBuffer((cleanChunk: string) => {
            if (textAccumulator) textAccumulator.text += cleanChunk;
            if (progress) progress.onTextChunk(agentName, cleanChunk);
            this._setSelfPhase("generating");

            const entry = streamedAssistantEntries.get(roundIndex);
            if (!entry) {
              const nextEntry = createAssistantText(
                this._nextLogId("assistant_text"),
                this._turnCount,
                roundIndex,
                cleanChunk,
                cleanChunk,
                getRoundContextId(roundIndex),
              );
              this._appendEntry(nextEntry, false);
              streamedAssistantEntries.set(roundIndex, nextEntry);
              this._setActiveLogEntry(nextEntry.id);
            } else {
              entry.display += cleanChunk;
              entry.content = String(entry.content ?? "") + cleanChunk;
              if (this._activeLogEntryId !== entry.id) {
                this._setActiveLogEntry(entry.id);
              } else {
                this._touchLog();
              }
            }
          });
          roundBuffer = new NoReplyStreamBuffer((cleanChunk: string) => stripBuf.feed(cleanChunk));
          textBuffers.set(roundIndex, roundBuffer);
        }
        roundBuffer.feed(chunk);
        // Check if the streaming callback actually created/updated a log entry
        return streamedAssistantEntries.has(roundIndex);
      };

      onReasoningChunk = (roundIndex: number, chunk: string) => {
        if (reasoningAccumulator) reasoningAccumulator.text += chunk;
        if (progress) progress.onReasoningChunk(agentName, chunk);
        this._setSelfPhase("thinking");

        // If switching from text → reasoning in same round, start a new reasoning entry
        if (lastStreamRound === roundIndex && lastStreamKind === "text") {
          streamedReasoningEntries.delete(roundIndex);
        }
        lastStreamKind = "reasoning";
        lastStreamRound = roundIndex;

        const entry = streamedReasoningEntries.get(roundIndex);
        if (!entry) {
          const nextEntry = createReasoning(
            this._nextLogId("reasoning"),
            this._turnCount,
            roundIndex,
            chunk,
            chunk,
            undefined,
            getRoundContextId(roundIndex),
          );
          this._appendEntry(nextEntry, false);
          streamedReasoningEntries.set(roundIndex, nextEntry);
          this._setActiveLogEntry(nextEntry.id);
        } else {
          entry.display += chunk;
          entry.content = String(entry.content ?? "") + chunk;
          // Keep active tracker pointing to this reasoning entry
          if (this._activeLogEntryId !== entry.id) {
            this._setActiveLogEntry(entry.id);
          } else {
            this._touchLog();
          }
        }
        return true;
      };
    }

    // Mark reasoning entry as complete when the provider finishes streaming reasoning
    const onReasoningDone = (roundIndex: number) => {
      const entry = streamedReasoningEntries.get(roundIndex);
      if (entry) {
        (entry.meta as Record<string, unknown>).reasoningComplete = true;
        if (this._activeLogEntryId === entry.id) {
          this._activeLogEntryId = null;
        }
        this._touchLog();
      }
    };

    let onToolCall: ((name: string, tool: string, args: Record<string, unknown>, summary: string) => void) | undefined;
    if (this._progress) {
      const step = this._turnCount;
      const progress = this._progress;

      onToolCall = (name: string, tool: string, args: Record<string, unknown>, summary: string) => {
        progress.onToolCall(step, name, tool, args, summary);
      };
    }
    const origOnToolCall = onToolCall;
    onToolCall = (name: string, tool: string, args: Record<string, unknown>, summary: string) => {
      origOnToolCall?.(name, tool, args, summary);
      this._setSelfPhase("tool_calling");
      this._lifetimeToolCallCount += 1;
      this._lastToolCallSummary = summary;
      this._recordSessionEvent(summary);
    };

    const onToolResult = (name: string, tool: string, toolCallId: string, isError: boolean, summary: string) => {
      // Flush deferred summary entries now that tool_result is in the log
      if (this._pendingSummaryEntries.length > 0) {
        const pending = this._pendingSummaryEntries.splice(0);
        for (const entry of pending) {
          this._appendEntry(entry, false);
        }
      }
      if (this._progress) {
        this._progress.onToolResult(this._turnCount, name, tool, toolCallId, isError, summary);
      }
      // Fire PostToolUse / PostToolUseFailure hooks
      if (this.hookRuntime.hooks.length > 0) {
        const event = isError ? "PostToolUseFailure" : "PostToolUse";
        this.hookRuntime.fireAndForget(event, {
          event,
          timestamp: Date.now(),
          toolName: tool,
          toolCallId,
          agentId: name,
        });
      }
    };

    // Streaming tool call callbacks — set active entry for early display
    const onToolCallPartialCb = (_callId: string, _name: string, _rawArguments: string) => {
      // Active entry tracking happens in tool-loop via appendEntry → _appendEntry;
      // we find the just-appended pending tool_call entry and mark it active
      const lastEntry = this._log[this._log.length - 1];
      if (lastEntry && lastEntry.type === "tool_call") {
        this._setActiveLogEntry(lastEntry.id);
      }
    };

    // Token update callback: update _lastInputTokens after each provider call
    // so the TUI can display real-time context usage.
    const onTokenUpdate = (inputTokens: number, usage?: import("./providers/base.js").Usage) => {
      this._lastInputTokens = inputTokens;
      this._lastTotalTokens = usage?.totalTokens ?? inputTokens;
      this._lastCacheReadTokens = usage?.cacheReadTokens ?? 0;
      this._appendEntry(
        createTokenUpdate(
          this._nextLogId("token_update"),
          this._turnCount,
          inputTokens,
          usage?.cacheReadTokens,
          usage?.cacheCreationTokens,
          usage?.totalTokens,
        ),
        false,
      );
      if (this._progress) {
        const extra: Record<string, unknown> = { input_tokens: inputTokens };
        if (usage) {
          if (usage.cacheReadTokens > 0) extra["cache_read_tokens"] = usage.cacheReadTokens;
          if (usage.cacheCreationTokens > 0) extra["cache_creation_tokens"] = usage.cacheCreationTokens;
        }
        this._progress.emit({
          step: this._turnCount,
          agent: this.primaryAgent.name,
          action: "token_update",
          message: "",
          level: "quiet" as ProgressLevel,
          timestamp: Date.now() / 1000,
          usage: { input_tokens: inputTokens },
          extra,
        });
      }
    };

    const agentName = this.primaryAgent.name;
    const emitRetryAttempt = (attempt: number, max: number, delaySec: number, errMsg: string) => {
      if (!this._compactInProgress) {
        this._appendEntry(
          createStatus(
            this._nextLogId("status"),
            this._turnCount,
            `[Network retry ${attempt}/${max}] waiting ${delaySec}s: ${errMsg}`,
            "retry_attempt",
          ),
          false,
        );
      }
      this._progress?.onRetryAttempt(agentName, attempt, max, delaySec, errMsg);
    };
    const emitRetrySuccess = (attempt: number) => {
      if (!this._compactInProgress) {
        this._appendEntry(
          createStatus(
            this._nextLogId("status"),
            this._turnCount,
            `[Network retry succeeded] attempt ${attempt}`,
            "retry_success",
          ),
          false,
        );
      }
      this._progress?.onRetrySuccess(agentName, attempt);
    };
    const emitRetryExhausted = (max: number, errMsg: string) => {
      if (!this._compactInProgress) {
        this._appendEntry(
          createErrorEntry(
            this._nextLogId("error"),
            this._turnCount,
            `[Network retry exhausted after ${max} attempts] ${errMsg}`,
            "retry_exhausted",
          ),
          false,
        );
      }
      this._progress?.onRetryExhausted(agentName, max, errMsg);
    };

    // v2: callback-based message management
    // getMessages projects from _log via projectToApiMessages
    const getMessages = (): Array<Record<string, unknown>> => {
      const showAnnotations = this._showContextRoundsRemaining > 0
        ? this._showContextAnnotations ?? undefined
        : undefined;
      return projectToApiMessages(this._log, {
        systemPrompt: this._getSystemPrompt(),
        resolveImageRef: (refPath) => this._resolveImageRef(refPath),
        requiresAlternatingRoles: (this.primaryAgent as any)._provider?.requiresAlternatingRoles,
        showContextAnnotations: showAnnotations ?? undefined,
        enforceToolCallProtocol: true,
      });
    };

    const appendEntry = (entry: LogEntry): void => {
      if (this._compactInProgress) {
        entry.tuiVisible = false;
        entry.displayKind = null;
        (entry.meta as Record<string, unknown>)["compactPhase"] = true;
      }
      this._appendEntry(entry, false);
      if (
        entry.type === "tool_call"
        && entry.tuiVisible
        && !this._compactInProgress
        && entry.meta["toolExecState"] !== "completed"
        && entry.meta["toolExecState"] !== "failed"
        && (entry.meta["toolExecState"] === "running"
          || entry.meta["toolExecState"] === "not_started"
          || entry.meta["toolStreamState"] === "partial"
          || entry.meta["toolStreamState"] === "closed")
      ) {
        this._setActiveLogEntry(entry.id);
      }
    };

    const allocId = (type: LogEntry["type"]): string => {
      return this._nextLogId(type);
    };

    /** Update an existing log entry in-place (for finalizing pending tool call entries). */
    const updateEntryFn = (entryId: string, patch: {
      apiRole?: LogEntry["apiRole"];
      content?: unknown;
      display?: string;
      tuiVisible?: boolean;
      displayKind?: LogEntry["displayKind"];
      meta?: Record<string, unknown>;
    }): void => {
      const entry = this._log.find((e) => e.id === entryId);
      if (!entry) return;
      if (patch.apiRole !== undefined) entry.apiRole = patch.apiRole;
      if (patch.content !== undefined) entry.content = patch.content;
      if (patch.display !== undefined) entry.display = patch.display;
      if (patch.tuiVisible !== undefined) entry.tuiVisible = patch.tuiVisible;
      if (patch.displayKind !== undefined) entry.displayKind = patch.displayKind;
      if (patch.meta !== undefined) entry.meta = patch.meta;
      if (entry.type === "tool_call" && !entry.tuiVisible) {
        if (this._activeLogEntryId === entry.id) {
          this._setActiveLogEntry(null);
        } else {
          this._touchLog();
        }
        return;
      }
      if (entry.type === "tool_call" && patch.meta) {
        const execState = patch.meta["toolExecState"];
        const streamState = patch.meta["toolStreamState"];
        // Check completion first — exec finished takes priority over stream state
        if (execState === "completed" || execState === "failed") {
          if (this._activeLogEntryId === entry.id) {
            this._setActiveLogEntry(null);
          } else {
            this._touchLog();
          }
          return;
        }
        if (
          execState === "running"
          || execState === "not_started"
          || streamState === "partial"
          || streamState === "closed"
        ) {
          if (this._activeLogEntryId !== entry.id) {
            this._setActiveLogEntry(entry.id);
          } else {
            this._touchLog();
          }
          return;
        }
      }
      this._touchLog();
    };

    /** Mark a log entry as discarded (for cleanup on retry). */
    const discardEntryFn = (entryId: string): void => {
      const entry = this._log.find((e) => e.id === entryId);
      if (!entry) return;
      entry.discarded = true;
      entry.tuiVisible = false;
      this._touchLog();
    };

    return this.primaryAgent.asyncRunWithMessages(
      getMessages,
      appendEntry,
      allocId,
      this._turnCount,
      baseRoundIndex,
      this._toolExecutors,
      onToolCall,
      onToolResult,
      onTextChunk,
      onReasoningChunk,
      onReasoningDone,
      signal,
      (roundIndex) => getRoundContextId(roundIndex),
      this._buildCompactCheck(),
      onTokenUpdate,
      this._thinkingLevel === "none" ? undefined : this._thinkingLevel,
      this._promptCacheKey,
      this._compactInProgress ? undefined : (() => this.onSaveRequest?.()),
      this._beforeToolExecute,
      () => null,
      () => this._drainInboxAsEntries(),
      !suppressStreaming,
      emitRetryAttempt,
      emitRetrySuccess,
      emitRetryExhausted,
      onToolCallPartialCb,
      this._resolveToolCallVisibility,
      updateEntryFn,
      discardEntryFn,
    );
  }

  // ==================================================================
  // Tool argument helpers
  // ==================================================================

  // Arg-validation helpers — delegates to standalone functions in tools/arg-helpers.ts
  private _toolArgError(toolName: string, message: string): ToolResult {
    return toolArgError(toolName, message);
  }
  private _argOptionalString(toolName: string, args: Record<string, unknown>, key: string): string | undefined | ToolResult {
    return argOptionalString(toolName, args, key);
  }
  private _argRequiredString(toolName: string, args: Record<string, unknown>, key: string, opts?: { nonEmpty?: boolean }): string | ToolResult {
    return argRequiredString(toolName, args, key, opts);
  }
  private _argRequiredStringArray(toolName: string, args: Record<string, unknown>, key: string): string[] | ToolResult {
    return argRequiredStringArray(toolName, args, key);
  }

  // ==================================================================
  // Ask tool
  // ==================================================================

  private _execAsk(args: Record<string, unknown>): ToolResult {
    // Validate args
    const questions = args["questions"];
    if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) {
      return new ToolResult({
        content: "Error: 'questions' must be an array of 1-4 items.",
      });
    }
    const parsedQuestions: AgentQuestionItem[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i] as Record<string, unknown>;
      if (!q || typeof q["question"] !== "string") {
        return new ToolResult({
          content: `Error: questions[${i}].question must be a string.`,
        });
      }
      const opts = q["options"];
      if (!Array.isArray(opts) || opts.length === 0 || opts.length > 4) {
        return new ToolResult({
          content: `Error: questions[${i}].options must be an array of 1-4 items.`,
        });
      }
      const parsedOpts = [];
      for (let j = 0; j < opts.length; j++) {
        const o = opts[j] as Record<string, unknown>;
        if (!o || typeof o["label"] !== "string") {
          return new ToolResult({
            content: `Error: questions[${i}].options[${j}].label must be a string.`,
          });
        }
        parsedOpts.push({
          label: o["label"] as string,
          description: typeof o["description"] === "string" ? (o["description"] as string) : undefined,
          kind: "normal" as const,
        });
      }
      parsedOpts.push({
        label: ASK_CUSTOM_OPTION_LABEL,
        kind: "custom_input" as const,
        systemAdded: true,
      });
      parsedOpts.push({
        label: ASK_DISCUSS_OPTION_LABEL,
        kind: "discuss_further" as const,
        systemAdded: true,
      });
      parsedQuestions.push({
        question: q["question"] as string,
        options: parsedOpts,
      });
    }

    const ask: AgentQuestion = {
      id: randomUUID(),
      kind: "agent_question",
      createdAt: new Date().toISOString(),
      source: {
        agentId: this.primaryAgent.name,
        agentName: this.primaryAgent.name,
        toolName: "ask",
      },
      roundIndex: undefined,
      summary: `Agent asking: ${parsedQuestions[0].question}${parsedQuestions.length > 1 ? ` (+${parsedQuestions.length - 1} more)` : ""}`,
      payload: { questions: parsedQuestions, toolCallId: "" },
      options: [], // per-question options are in payload
    };
    throw new AskPendingError(ask);
  }

  private _buildAgentQuestionToolResult(
    questions: AgentQuestionItem[],
    decision: AgentQuestionDecision,
  ): ToolResult {
    const lines: string[] = [];
    let hasDiscussFurther = false;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const answer = decision.answers.find((a) => a.questionIndex === i);
      lines.push(`Question ${i + 1}: "${q.question}"`);
      if (!answer) {
        lines.push("Answer: [missing]");
      } else {
        lines.push(`Answer: ${answer.answerText}`);
        const selected = q.options[answer.selectedOptionIndex];
        if (selected?.kind === "discuss_further") {
          hasDiscussFurther = true;
        }
      }
      if (answer?.note) {
        lines.push(`User note: ${answer.note}`);
      }
      lines.push("");
    }
    if (hasDiscussFurther) {
      lines.push(ASK_DISCUSS_FURTHER_GUIDANCE);
    }
    return new ToolResult({ content: lines.join("\n").trim() });
  }

  private _buildAgentQuestionPreview(
    questions: AgentQuestionItem[],
    decision: AgentQuestionDecision,
  ): string {
    const lines: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const answer = decision.answers.find((a) => a.questionIndex === i);
      // Show question with all options, marking the selected one
      lines.push(`Q${questions.length > 1 ? i + 1 : ""}: ${q.question}`);
      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j];
        const isSelected = answer?.selectedOptionIndex === j;
        const marker = isSelected ? "●" : "○";
        const desc = opt.description ? ` — ${opt.description}` : "";
        lines.push(`  ${marker} ${opt.label}${desc}`);
      }
      if (answer && q.options[answer.selectedOptionIndex]?.kind === "custom_input") {
        lines.push(`  ✎ ${answer.answerText}`);
      }
      if (answer?.note) {
        lines.push(`  📝 ${answer.note}`);
      }
    }
    return lines.join("\n");
  }

  resolveAgentQuestionAsk(
    askId: string,
    decision: AgentQuestionDecision,
  ): void {
    this._withAskRouting(
      askId,
      () => this._resolveOwnAgentQuestionAsk(askId, decision),
      (child) => child.session.resolveAgentQuestionAsk(askId, decision),
    );
  }

  private _resolveOwnAgentQuestionAsk(askId: string, decision: AgentQuestionDecision): void {
    const ask = this._activeAsk!;
    if (ask.kind !== "agent_question") {
      throw new Error(`Ask kind mismatch (active=${ask.kind}, expected=agent_question).`);
    }

    // Create ask_resolution entry in log
    this._appendEntry(createAskResolution(
      this._nextLogId("ask_resolution"),
      this._turnCount,
      { answers: decision.answers },
      askId,
      "agent_question",
    ), false);

    const toolResult = this._buildAgentQuestionToolResult(
      ask.payload.questions,
      decision,
    );
    const previewText = this._buildAgentQuestionPreview(
      ask.payload.questions,
      decision,
    );
    const toolCallId = ask.payload.toolCallId || "ask";
    const toolResultContextId =
      this._findToolCallContextId(toolCallId, ask.roundIndex)
        ?? this._allocateContextId();
    this._appendEntry(createToolResultEntry(
      this._nextLogId("tool_result"),
      this._turnCount,
      ask.roundIndex ?? this._computeNextRoundIndex(),
      {
        toolCallId,
        toolName: "ask",
        content: toolResult.content,
        toolSummary: "ask resolved",
      },
      {
        isError: false,
        contextId: toolResultContextId,
        previewText,
      },
    ), false);

    this._askHistory.push({
      askId: ask.id,
      kind: ask.kind,
      summary: ask.summary,
      decidedAt: new Date().toISOString(),
      decision: "answered",
      source: ask.source,
    });
    if (this._askHistory.length > 100) {
      this._askHistory = this._askHistory.slice(-100);
    }

    this._activeAsk = null;
    this._emitAskResolvedProgress(askId, "answered", "agent_question");
    this._pendingTurnState = { stage: "activation" };

    this.onSaveRequest?.();
  }

  /**
   * Resolve a permission approval ask.
   * @param askId  The ask ID to resolve.
   * @param choiceIndex  Index into the ask's options array. Last option is always "Deny".
   */
  resolveApprovalAsk(askId: string, choiceIndex: number): void {
    this._withAskRouting(
      askId,
      () => this._resolveOwnApprovalAsk(askId, choiceIndex),
      (child) => child.session.resolveApprovalAsk(askId, choiceIndex),
    );
  }

  private _resolveOwnApprovalAsk(askId: string, choiceIndex: number): void {
    const ask = this._activeAsk!;
    if (ask.kind !== "approval") throw new Error(`Ask kind mismatch (active=${ask.kind}, expected=approval).`);

    const payload = ask.payload as ApprovalRequest["payload"];
    const choiceLabel = ask.options[choiceIndex] ?? "Deny";
    const isDeny = choiceLabel === "Deny";
    const offer = !isDeny ? payload.offers[choiceIndex] : null;

    // Log the resolution
    this._appendEntry(createAskResolution(
      this._nextLogId("ask_resolution"),
      this._turnCount,
      { choice: choiceLabel, toolName: payload.toolName },
      askId,
      "approval",
    ), false);

    if (isDeny) {
      // Inject a deny tool_result so the model knows
      const toolCallId = payload.toolCallId;
      const contextId = this._findToolCallContextId(toolCallId, ask.roundIndex)
        ?? this._allocateContextId();
      this._appendEntry(createToolResultEntry(
        this._nextLogId("tool_result"),
        this._turnCount,
        ask.roundIndex ?? this._computeNextRoundIndex(),
        {
          toolCallId,
          toolName: payload.toolName,
          content: `ERROR: Tool execution denied by user.`,
          toolSummary: `${payload.toolName} denied`,
        },
        { isError: true, contextId },
      ), false);
    } else {
      // Apply the offer. The approved tool_call's grant is consumed in
      // _drainPendingToolCalls during resume.
      if (offer?.type === "tool_once") {
        this._permissionAdvisor.grantAllowOnce(payload.toolCallId);
      } else if (offer?.type === "mode_upgrade") {
        this.permissionMode = "reversible";
        this._permissionAdvisor.grantAllowOnce(payload.toolCallId);
      } else if ((offer?.type === "tool_pattern" || offer?.type === "external_path") && offer.rule) {
        this._permissionAdvisor.acceptOffer({
          type: offer.type as ApprovalOffer["type"],
          label: offer.label,
          scope: offer.scope as ApprovalOffer["scope"],
          rule: offer.rule as unknown as PermissionRule,
        });
        this._permissionAdvisor.grantAllowOnce(payload.toolCallId);
      }
    }

    this._askHistory.push({
      askId: ask.id,
      kind: "approval",
      summary: ask.summary,
      decidedAt: new Date().toISOString(),
      decision: choiceLabel,
      source: ask.source,
    });

    this._activeAsk = null;
    this._emitAskResolvedProgress(askId, choiceLabel, "approval");
    this._pendingTurnState = { stage: "activation" };

    this.onSaveRequest?.();
  }

  private _findChildWithPendingAsk(askId: string): ChildSessionHandle | null {
    for (const handle of this._childSessions.values()) {
      const ask = handle.session.getPendingAsk();
      if (ask?.id === askId) return handle;
    }
    return null;
  }

  /**
   * Route an ask operation to the correct session (self or child).
   * If the ask belongs to this session, runs onSelf. If it belongs to a
   * child, runs onChild then resumes the child's pending turn.
   */
  private _withAskRouting<T>(
    askId: string,
    onSelf: () => T,
    onChild: (child: ChildSessionHandle) => T,
  ): T {
    if (this._activeAsk?.id === askId) return onSelf();
    const child = this._findChildWithPendingAsk(askId);
    if (!child) throw new Error("No active ask to resolve.");
    const result = onChild(child);
    this._resumeChildPendingTurn(child);
    this._notifyLogListeners();
    this.onSaveRequest?.();
    return result;
  }

  private _execShowContext(args: Record<string, unknown>): ToolResult {
    // Handle dismiss mode: clear annotations without generating new ones
    if (args["dismiss"]) {
      this._showContextRoundsRemaining = 0;
      this._showContextAnnotations = null;
      return new ToolResult({ content: "Context annotations dismissed." });
    }

    const mc = this.primaryAgent.modelConfig;
    const provider = (this.primaryAgent as any)._provider;
    const effectiveMax = mc.maxTokens;
    const budget = provider.budgetCalcMode === "full_context"
      ? this._effectiveContextLength(mc) : this._effectiveContextLength(mc) - effectiveMax;

    const result = generateShowContext(this._log, this._lastInputTokens, budget);
    this._showContextRoundsRemaining = 1;
    this._showContextAnnotations = result.annotations;
    return new ToolResult({ content: result.contextMap });
  }

  private _execSummarizeTool(args: Record<string, unknown>): ToolResult {
    const result = execSummarizeContextOnLog(
      args,
      this._log,
      () => this._allocateContextId(),
      () => this._nextLogId("summary"),
      this._turnCount,
    );

    // Defer summary entries — they must appear AFTER the tool_result to avoid
    // breaking the tool_call → tool_result pairing in API projections.
    this._pendingSummaryEntries.push(...result.newEntries);

    this._annotateLatestSummarizeToolCall(result.results);

    this._touchLog();

    // Auto-dismiss show_context annotations after a successful summarize
    if (result.results.some((r) => r.success)) {
      this._showContextRoundsRemaining = 0;
      this._showContextAnnotations = null;
    }

    return new ToolResult({ content: result.output });
  }

  private _annotateLatestSummarizeToolCall(results: Array<{ success: boolean; newContextId?: string }>): void {
    const resolvedToolCallIds = new Set<string>();
    let summarizeEntry: LogEntry | null = null;

    for (let i = this._log.length - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.discarded) continue;
      if (entry.type === "tool_result") {
        const toolCallId = (entry.meta as Record<string, unknown>)["toolCallId"];
        if (toolCallId) resolvedToolCallIds.add(String(toolCallId));
        continue;
      }
      if (entry.type !== "tool_call") continue;
      const toolCallId = String((entry.meta as Record<string, unknown>)["toolCallId"] ?? "");
      if (resolvedToolCallIds.has(toolCallId)) continue;
      if ((entry.meta as Record<string, unknown>)["toolName"] !== "summarize") continue;
      summarizeEntry = entry;
      break;
    }

    if (!summarizeEntry) return;
    const content = summarizeEntry.content as Record<string, unknown>;
    const args = (content["arguments"] as Record<string, unknown>) ?? {};
    const operations = ((args["operations"] as Array<Record<string, unknown>>) ?? []).map((op) => ({ ...op }));

    for (let i = 0; i < operations.length && i < results.length; i++) {
      if (!results[i].success || !results[i].newContextId) continue;
      operations[i]["_result_context_id"] = results[i].newContextId;
    }

    summarizeEntry.content = {
      ...content,
      arguments: {
        ...args,
        operations,
      },
    };
  }

  // ==================================================================
  // AGENTS.md persistent memory
  // ==================================================================

  /**
   * Read AGENTS.md from user home (~/) and project root, concatenating both.
   * Global file comes first, project file second.
   */
  /**
   * Check if a file path refers to an AGENTS.md file (global or project).
   * Used to auto-reload the system prompt cache after writes.
   */
  private _isAgentsMdPath(filePath: string): boolean {
    const resolved = resolve(filePath);
    const globalPath = join(getFermiHomeDir(), "AGENTS.md");
    const projectPath = join(this._projectRoot, "AGENTS.md");
    return resolved === resolve(globalPath) || resolved === resolve(projectPath);
  }

  /** Check if a file path refers to the plan file (SESSION_ARTIFACTS/plan.md). */
  private _isPlanFilePath(filePath: string): boolean {
    const planPath = this._getPlanFilePath();
    if (!planPath) return false;
    return resolve(filePath) === resolve(planPath);
  }

  private _resolveToolCallVisibility: ResolveToolCallVisibilityCallback = ({
    toolName,
    toolArgs,
  }) => {
    if (toolName !== "edit_file" && toolName !== "write_file") {
      return undefined;
    }
    const filePath = typeof toolArgs.path === "string" ? toolArgs.path : "";
    if (filePath && this._isPlanFilePath(filePath)) {
      return "hide";
    }
    return undefined;
  };

  private _countProjectedMessageTokens(content: unknown): number {
    if (typeof content === "string") {
      return gptEncode(content).length;
    }
    if (Array.isArray(content)) {
      return content.reduce((sum, item) => sum + this._countProjectedMessageTokens(item), 0);
    }
    if (content && typeof content === "object") {
      const record = content as Record<string, unknown>;
      if (typeof record["text"] === "string") {
        return gptEncode(record["text"]).length;
      }
      if (typeof record["content"] === "string") {
        return gptEncode(record["content"]).length;
      }
      if (typeof record["input_text"] === "string") {
        return gptEncode(record["input_text"]).length;
      }
    }
    return 0;
  }

  private _estimateToolDefinitionTokens(): number {
    const tools = Array.isArray(this.primaryAgent.tools) ? this.primaryAgent.tools : [];
    if (tools.length === 0) return 0;

    try {
      const provider = (this.primaryAgent as any)._provider as Record<string, unknown> | undefined;
      const convertTools = provider?.["_convertTools"];
      if (typeof convertTools === "function") {
        const converted = convertTools.call(provider, tools);
        const normalized = Array.isArray(converted)
          ? converted
          : converted && typeof converted === "object" && Array.isArray((converted as Record<string, unknown>)["toolsList"])
          ? (converted as Record<string, unknown>)["toolsList"]
          : tools;
        return gptEncode(JSON.stringify(normalized)).length;
      }
    } catch {
      // Fall back to raw tool definitions.
    }

    return gptEncode(JSON.stringify(tools)).length;
  }

  private _estimateInitialApiInputTokens(): number {
    const messages = projectToApiMessages(this._log, {
      systemPrompt: this._getSystemPrompt(),
      resolveImageRef: (refPath) => this._resolveImageRef(refPath),
      requiresAlternatingRoles: (this.primaryAgent as any)._provider?.requiresAlternatingRoles,
    });

    try {
      return gptCountTokens(messages as any) + this._estimateToolDefinitionTokens();
    } catch {
      return messages.reduce((sum, message) => sum + this._countProjectedMessageTokens(message["content"]), 0)
        + this._estimateToolDefinitionTokens();
    }
  }

  private _updateInitialTokenEstimate(): void {
    if (this._turnCount !== 0) return;
    const estimate = this._estimateInitialApiInputTokens();
    this._lastInputTokens = estimate;
    this._lastTotalTokens = estimate;
    this._lastCacheReadTokens = 0;
  }

  private _getArtifactsDirIfAvailable(): string | undefined {
    if (!this._store) return undefined;
    const d = this._store.artifactsDir;
    if (d) return d;
    return undefined;
  }

  private _getPredictedArtifactsDirIfAvailable(): string | undefined {
    if (!this._store || typeof this._store.predictNextArtifactsDir !== "function") return undefined;
    try {
      return this._store.predictNextArtifactsDir();
    } catch {
      return undefined;
    }
  }

  private _createMissingSessionDirOrThrow(): void {
    if (!this._store) return;
    if (this._store.sessionDir) return;
    if (typeof this._store.createSession !== "function") {
      throw new Error(
        "Session artifacts directory is unavailable. " +
        "No session directory is active and the attached SessionStore " +
        "cannot create one.",
      );
    }
    try {
      this._store.createSession();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(
        "Failed to create session storage before running this turn. " +
        `Reason: ${reason}`,
      );
    }
  }

  private _ensureSessionStorageReady(): void {
    if (this._sessionArtifactsOverride) {
      this._refreshSystemPromptPaths();
      return;
    }
    if (!this._store) {
      throw new Error(
        "Session artifacts directory is unavailable. " +
        "No SessionStore is attached and no paths.session_artifacts override is configured.",
      );
    }
    if (!this._store.sessionDir) {
      this._createMissingSessionDirOrThrow();
    }
    const artifacts = this._getArtifactsDirIfAvailable();
    if (!artifacts) {
      throw new Error(
        "Session artifacts directory is unavailable after session initialization. " +
        "Possible causes: (1) ~/.fermi/ is not writable, (2) disk is full, " +
        "(3) permission issues creating the artifacts directory.",
      );
    }
    this._refreshSystemPromptPaths();
  }

  private _getArtifactsDir(): string {
    if (this._sessionArtifactsOverride) return this._sessionArtifactsOverride;
    const d = this._getArtifactsDirIfAvailable();
    if (d) return d;
    throw new Error(
      "Session artifacts directory is unavailable. " +
      "This usually means no active session directory exists yet, or session " +
      "persistence failed to initialize. " +
      "Possible causes: (1) ~/.fermi/ is not writable, (2) disk is full, " +
      "(3) SessionStore is missing or not ready.",
    );
  }

  // ==================================================================
  // Path variable resolution
  // ==================================================================

  private _resolveSessionArtifacts(options?: { allowUnresolved?: boolean }): string {
    if (this._sessionArtifactsOverride) return this._sessionArtifactsOverride;
    const d = this._getArtifactsDirIfAvailable();
    if (d) return d;
    if (options?.allowUnresolved) return "{SESSION_ARTIFACTS}";
    return this._getArtifactsDir();
  }

  private _resolveSystemData(options?: { allowUnresolved?: boolean }): string {
    if (this._systemData) return this._systemData;
    if (this._store?.projectDir) return this._store.projectDir;
    if (options?.allowUnresolved) return "{SYSTEM_DATA}";
    const artifacts = this._getArtifactsDir();
    return join(artifacts, "..");
  }

  private _renderSystemPrompt(rawPrompt: string): string {
    const predictedArtifacts = this._getPredictedArtifactsDirIfAvailable();
    return rawPrompt
      .replace(/\{PROJECT_ROOT\}/g, this._projectRoot)
      .replace(/\{SESSION_ARTIFACTS\}/g, predictedArtifacts ?? this._resolveSessionArtifacts({ allowUnresolved: true }))
      .replace(/\{SYSTEM_DATA\}/g, this._resolveSystemData({ allowUnresolved: true }));
  }

  /**
   * Assemble the full system prompt using the layered assembler.
   * Called by _reloadPromptAndTools(), not per-call.
   */
  private _assembleSystemPrompt(): string {
    const recipe = this.primaryAgent.promptRecipe;
    const agentPrompt = recipe
      ? assembleSystemPrompt(recipe)
      : this.primaryAgent.systemPrompt;

    return assembleFullSystemPrompt({
      agentPrompt,
      projectRoot: this._projectRoot,
      sessionArtifacts: this._getPredictedArtifactsDirIfAvailable()
        ?? this._resolveSessionArtifacts({ allowUnresolved: true }),
      systemData: this._resolveSystemData({ allowUnresolved: true }),
      agentModels: this.config.agentModels,
    });
  }

  /**
   * Get the cached system prompt. Computed once and reused across API calls
   * for prompt cache stability. Refreshed only by _reloadPromptAndTools().
   */
  private _getSystemPrompt(): string {
    if (!this._cachedSystemPrompt) {
      this._cachedSystemPrompt = this._assembleSystemPrompt();
    }
    // Append hook additional context (dynamic, not cached)
    const hookCtx = this.hookRuntime.getAdditionalContext();
    if (hookCtx) {
      return this._cachedSystemPrompt + "\n\n" + hookCtx;
    }
    return this._cachedSystemPrompt;
  }

  /**
   * Reload system prompt, skills, and tool definitions.
   * Called at session init, on `/reload`, and after AGENTS.md writes.
   * Invalidates the prompt cache so the next API call gets a fresh prompt.
   */
  _reloadPromptAndTools(): void {
    this._refreshSkills();
    this._cachedSystemPrompt = this._assembleSystemPrompt();
  }

  /**
   * Update the system message in the conversation with re-rendered paths.
   * Called by setStore() to fix paths after the store is linked.
   */
  private _refreshSystemPromptPaths(): void {
    this._reloadPromptAndTools();
    this._updateInitialTokenEstimate();
  }

  // ==================================================================
  // Auto-compact
  // ==================================================================

  private _buildCompactCheck(): ((
    inputTokens: number, outputTokens: number, hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "output" | "toolcall" } | null) | undefined {
    if (this._compactInProgress) return undefined;

    // Child sessions do not auto-compact; they receive a 90% warning instead
    // (see _checkAndInjectHint) and are expected to finish or stop.
    if (!this._capabilities.includeSpawnTool) return undefined;

    const mc = this.primaryAgent.modelConfig;
    const provider = (this.primaryAgent as any)._provider;
    const effectiveMax = mc.maxTokens;
    const budget = provider.budgetCalcMode === "full_context"
      ? this._effectiveContextLength(mc)
      : this._effectiveContextLength(mc) - effectiveMax;

    if (budget <= 0) return undefined;

    const compactOutputRatio = this._thresholds.compact_output / 100;
    const compactToolcallRatio = this._thresholds.compact_toolcall / 100;

    return (inputTokens: number, outputTokens: number, hasToolCalls: boolean) => {
      const tokensToCheck = provider.budgetCalcMode === "full_context"
        ? inputTokens              // full_context mode: only check input
        : inputTokens + outputTokens;

      const threshold = hasToolCalls ? compactToolcallRatio : compactOutputRatio;

      if (tokensToCheck > threshold * budget) {
        return { compactNeeded: true, scenario: hasToolCalls ? "toolcall" : "output" };
      }
      return { compactNeeded: false };
    };
  }

  /**
   * Run the compact phase: inject compact prompt, let the Agent produce
   * a continuation prompt (possibly using tools), then return it.
   */
  private async _runCompactPhase(
    scenario: "output" | "toolcall",
    promptOverride?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this._compactInProgress = true;

    // Emit compact_start event
    if (this._progress) {
      this._progress.onCompactStart(this.primaryAgent.name, scenario);
    }

    // Inject compact prompt as user_message entry (compactPhase, invisible in TUI)
    const prompt = promptOverride ?? (scenario === "output" ? COMPACT_PROMPT_OUTPUT : COMPACT_PROMPT_TOOLCALL);
    const compactPromptEntry = createUserMessageEntry(
      this._nextLogId("user_message"),
      this._turnCount,
      "",  // not visible in TUI
      prompt,
      this._allocateContextId(),
    );
    compactPromptEntry.tuiVisible = false;
    (compactPromptEntry.meta as Record<string, unknown>)["compactPhase"] = true;
    this._appendEntry(compactPromptEntry, false);

    let continuationPrompt = "";
    try {
      for (let i = 0; i < MAX_COMPACT_PHASE_ROUNDS; i++) {
        if (signal?.aborted) break;

        const result = await this._runActivation(signal, undefined, undefined, true);
        if (signal?.aborted) break;

        if (result.text) {
          // Agent produced text → this is the continuation prompt
          const compactRound = this._computeNextRoundIndex();
          const compactContextId = this._allocateContextId();
          if (result.reasoningContent) {
            const compactReasoningEntry = createReasoning(
              this._nextLogId("reasoning"),
              this._turnCount,
              compactRound,
              "",
              result.reasoningContent,
              result.reasoningState,
              compactContextId,
            );
            compactReasoningEntry.tuiVisible = false;
            compactReasoningEntry.displayKind = null;
            (compactReasoningEntry.meta as Record<string, unknown>)["compactPhase"] = true;
            this._appendEntry(compactReasoningEntry, false);
          }
          const compactReplyEntry = createAssistantText(
            this._nextLogId("assistant_text"),
            this._turnCount,
            compactRound,
            "",  // not visible in TUI
            result.text,
            compactContextId,
          );
          compactReplyEntry.tuiVisible = false;
          (compactReplyEntry.meta as Record<string, unknown>)["compactPhase"] = true;
          this._appendEntry(compactReplyEntry, false);
          continuationPrompt = result.text;
          break;
        }
      }
      if (!continuationPrompt) {
        continuationPrompt = "[Compact phase did not produce a continuation prompt.]";
      }
    } finally {
      this._compactInProgress = false;
    }

    return continuationPrompt;
  }

  /**
   * Execute auto-compact: run compact phase, then reconstruct conversation
   * with marker + system prompt + continuation prompt.
   */
  private async _doAutoCompact(
    scenario: "output" | "toolcall",
    signal?: AbortSignal,
    promptOverride?: string,
  ): Promise<void> {
    const originalTokens = this._lastTotalTokens;

    // Run compact phase
    const continuationPrompt = await this._runCompactPhase(scenario, promptOverride, signal);

    const contCtxId = this._allocateContextId();
    this._compactCount += 1;

    // v2 log: compact_marker + compact_context entries (source of truth)
    this._appendEntry(
      createCompactMarker(
        this._nextLogId("compact_marker"),
        this._turnCount,
        this._compactCount - 1,
        originalTokens,
        0, // compactedTokens not yet known
      ),
      false,
    );
    const currentMarkerIdx = this._log.length - 1;
    // Append plan snapshot to compact context so plan state survives compaction.
    const planSnapshot = formatPlanSnapshot(this._planState);
    const planSuffix = planSnapshot ? `\n\n${planSnapshot}` : "";
    const contContent = `${continuationPrompt}\n\n[Contexts before this point have been compacted.]${planSuffix}`;
    this._appendEntry(
      createCompactContext(
        this._nextLogId("compact_context"),
        this._turnCount,
        contContent,
        contCtxId,
        this._compactCount - 1,
      ),
      false,
    );

    const sessionDir = this._store?.sessionDir as string | undefined;
    if (sessionDir) {
      let previousMarkerIdx = -1;
      for (let i = currentMarkerIdx - 1; i >= 0; i--) {
        if (this._log[i].type === "compact_marker" && !this._log[i].discarded) {
          previousMarkerIdx = i;
          break;
        }
      }
      const archiveStartIdx = previousMarkerIdx >= 0 ? previousMarkerIdx + 1 : 1;
      const archiveEndIdx = currentMarkerIdx - 1;
      if (archiveEndIdx >= archiveStartIdx) {
        archiveWindow(
          sessionDir,
          this._compactCount - 1,
          this._log,
          archiveStartIdx,
          archiveEndIdx,
        );
      }
    }

    // Emit compact_end event
    if (this._progress) {
      this._progress.onCompactEnd(this.primaryAgent.name, scenario, originalTokens);
    }
  }

  /**
   * Check and inject hint compression prompt if thresholds are met.
   * Two-tier: level 1 and level 2, configurable via settings.json.
   */
  private _checkAndInjectHint(_result: ToolLoopResult): void {
    if (this._compactInProgress) return;

    const mc = this.primaryAgent.modelConfig;
    const provider = (this.primaryAgent as any)._provider;
    const effectiveMax = mc.maxTokens;
    const budget = provider.budgetCalcMode === "full_context"
      ? this._effectiveContextLength(mc) : this._effectiveContextLength(mc) - effectiveMax;
    if (budget <= 0) return;

    const ratio = this._lastInputTokens / budget;
    const pct = `${Math.round(ratio * 100)}%`;

    // Child sessions: single warning at 90%, no summarize guidance
    if (!this._capabilities.includeSpawnTool) {
      if (ratio >= 0.90 && this._hintState === "none") {
        this._deliverMessage({
          type: "system_notice",
          sender: "system",
          content: `[SYSTEM: Context usage has reached ${pct}. You are approaching the context limit and do NOT have context management tools. Finish your current work as quickly as possible — avoid reading large files, reduce tool calls, and focus only on producing your final output. If work progress is not promising, stop now and output what you have so far.]`,
          timestamp: Date.now(),
        });
        this._hintState = "level2_sent";
      }
      return;
    }

    const level2Ratio = this._thresholds.context_hint_level2 / 100;
    const level1Ratio = this._thresholds.context_hint_level1 / 100;

    if (ratio >= level2Ratio && this._hintState !== "level2_sent") {
      this._deliverMessage({ type: "system_notice", sender: "system", content: HINT_LEVEL2_PROMPT(pct), timestamp: Date.now() });
      this._hintState = "level2_sent";
    } else if (ratio >= level1Ratio && this._hintState === "none") {
      this._deliverMessage({ type: "system_notice", sender: "system", content: HINT_LEVEL1_PROMPT(pct), timestamp: Date.now() });
      this._hintState = "level1_sent";
    }
  }

  /**
   * Update hint state based on actual inputTokens from the latest API call.
   * Implements hysteresis to prevent oscillation.
   * Reset thresholds are auto-derived from trigger thresholds.
   */
  private _updateHintStateAfterApiCall(): void {
    const mc = this.primaryAgent.modelConfig;
    const provider = (this.primaryAgent as any)._provider;
    const effectiveMax = mc.maxTokens;
    const budget = provider.budgetCalcMode === "full_context"
      ? this._effectiveContextLength(mc) : this._effectiveContextLength(mc) - effectiveMax;
    if (budget <= 0) return;

    const ratio = this._lastInputTokens / budget;

    if (ratio < this._hintResetNone) {
      this._hintState = "none";
    } else if (ratio < this._hintResetLevel1) {
      this._hintState = "level1_sent";
    }
    // ratio >= HINT_RESET_LEVEL1: keep current state (don't downgrade)
  }

  // ==================================================================
  // Sub-agent spawn / cancel / lifecycle
  // ==================================================================

  private _childSessionDir(childId: string): string {
    return join(this._resolveSessionArtifacts(), "agents", childId, "session");
  }

  private _saveChildSession(handle: ChildSessionHandle): void {
    try {
      const logData = handle.session.getLogForPersistence();
      saveLog(handle.sessionDir, logData.meta, [...logData.entries]);
    } catch (e) {
      console.warn(`Failed to save child session '${handle.id}':`, e);
    }
  }

  private _instantiateChildSession(
    taskId: string,
    templateLabel: string,
    mode: ChildSessionMode,
    agent: Agent,
    opts?: { numericId?: number; order?: number },
  ): ChildSessionHandle {
    const numericId = opts?.numericId ?? (this._subAgentCounter + 1);
    this._subAgentCounter = Math.max(this._subAgentCounter, numericId);
    const sessionDir = this._childSessionDir(taskId);
    const artifactsDir = join(sessionDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    const fullSystemPrompt = this._buildSubAgentSystemPrompt(
      agent.systemPrompt,
      mode === "persistent",
    );
    agent.systemPrompt = fullSystemPrompt;

    const handle: ChildSessionHandle = {
      id: taskId,
      numericId,
      template: templateLabel,
      mode,
      lifecycle: "idle",
      status: "idle",
      phase: "idle",
      session: null as unknown as Session,
      sessionDir,
      artifactsDir,
      resultText: "",
      elapsed: 0,
      startTime: 0,
      turnPromise: null,
      abortController: null,
      recentEvents: [],
      lifetimeToolCallCount: 0,
      lastToolCallSummary: "",
      lastTotalTokens: 0,
      lastOutcome: "none",
      lastActivityAt: Date.now(),
      order: opts?.order ?? numericId,
      suspended: false,
      settlePromise: null,
      settleResolve: null,
    };

    const childSession = new Session({
      primaryAgent: agent,
      config: this.config,
      promptsDirs: this._promptsDirs,
      projectRoot: this._projectRoot,
      sessionArtifactsDir: artifactsDir,
      capabilities: CHILD_SESSION_CAPABILITIES,
      statusSource: () => this.getChildSessionSnapshots(),
      onTurnOutput: (text: string) => this._handleChildTurnOutput(taskId, text),
      toolExecutorOverrides: {},
      deferQueuedMessageInjectionOnTurnExit: true,
      promptCacheKey: taskId,
      permissionMode: this.permissionMode,
      progress: this._progress,
      contextRatio: this._contextRatio,
      permissionRuleStore: this._permissionRuleStore,
      mcpManager: this.config.subAgentInheritMcp ? this._mcpManager : undefined,
      hooks: this.config.subAgentInheritHooks ? this.hookRuntime.hooks : undefined,
    });
    childSession.onSaveRequest = () => this._saveChildSession(handle);
    handle.session = childSession;
    return handle;
  }

  private _createChildSession(
    taskId: string,
    templateLabel: string,
    mode: ChildSessionMode,
    agent: Agent,
  ): ChildSessionHandle {
    const handle = this._instantiateChildSession(taskId, templateLabel, mode, agent);
    this._saveChildSession(handle);
    // Fire SubagentStart hook
    this.hookRuntime.fireAndForget("SubagentStart", {
      event: "SubagentStart",
      timestamp: Date.now(),
      agentId: taskId,
    });
    return handle;
  }

  private _handleChildTurnOutput(childId: string, text: string): void {
    const handle = this._childSessions.get(childId);
    if (!handle) return;
    handle.resultText = text;
    handle.lastActivityAt = Date.now();
  }

  private _startChildTurn(handle: ChildSessionHandle, input: string, options?: { skipUserInput?: boolean }): void {
    handle.startTime = performance.now();
    handle.status = "working";
    handle.lifecycle = "running";
    handle.phase = "thinking";
    handle.lastActivityAt = Date.now();
    handle.suspended = false;
    handle.terminationCause = undefined;
    const abortController = new AbortController();
    handle.abortController = abortController;
    // Create settle promise so close() can wait for this turn to finish
    handle.settlePromise = new Promise<void>((resolve) => {
      handle.settleResolve = resolve;
    });
    handle.turnPromise = handle.session.turn(input, { signal: abortController.signal, skipUserInput: options?.skipUserInput });
    void handle.turnPromise.then(
      () => this._finishChildTurn(handle, undefined),
      (error: unknown) => this._finishChildTurn(handle, error),
    );
  }

  private _resumeChildPendingTurn(handle: ChildSessionHandle): void {
    if (handle.turnPromise) return;
    if (!handle.session.hasPendingTurnToResume()) return;

    handle.startTime = performance.now();
    handle.status = "working";
    handle.lifecycle = "running";
    handle.phase = "waiting";
    handle.lastActivityAt = Date.now();
    handle.suspended = false;
    handle.terminationCause = undefined;
    const abortController = new AbortController();
    handle.abortController = abortController;
    handle.settlePromise = new Promise<void>((resolve) => {
      handle.settleResolve = resolve;
    });
    handle.turnPromise = handle.session.resumePendingTurn({ signal: abortController.signal });
    void handle.turnPromise.then(
      () => this._finishChildTurn(handle, undefined),
      (error: unknown) => this._finishChildTurn(handle, error),
    );
  }

  private _finishChildTurn(handle: ChildSessionHandle, error?: unknown): void {
    // Zombie callback guard: if close/suspend already handled this handle, bail out.
    if (handle.suspended) {
      const resolve = handle.settleResolve;
      handle.settleResolve = null;
      resolve?.();
      return;
    }

    handle.elapsed = handle.startTime > 0 ? (performance.now() - handle.startTime) / 1000 : 0;

    const pendingAsk = !error ? handle.session.getPendingAsk() : null;
    const hasPendingResume = !error ? handle.session.hasPendingTurnToResume() : false;
    if (!error && (pendingAsk || hasPendingResume)) {
      handle.abortController = null;
      handle.turnPromise = null;
      handle.lifecycle = "blocked";
      handle.status = "idle";
      handle.phase = "waiting";
      handle.lastOutcome = "none";
      handle.lastActivityAt = Date.now();
      this._saveChildSession(handle);
      this._notifyLogListeners();
      this.onSaveRequest?.();
      const resolve = handle.settleResolve;
      handle.settleResolve = null;
      resolve?.();
      return;
    }

    handle.abortController = null;
    handle.turnPromise = null;
    handle.lastActivityAt = Date.now();

    // Fire SubagentStop hook
    this.hookRuntime.fireAndForget("SubagentStop", {
      event: "SubagentStop",
      timestamp: Date.now(),
      agentId: handle.id,
    });

    // Determine outcome from error / endStatus
    const endStatus = error ? "error" : handle.session.lastTurnEndStatus;
    if (error || endStatus === "error") {
      handle.lastOutcome = "error";
      handle.status = "error";
    } else if (endStatus === "interrupted") {
      handle.lastOutcome = "interrupted";
      handle.status = handle.mode === "oneshot" ? "interrupted" : "idle";
    } else {
      handle.lastOutcome = "completed";
      handle.status = handle.mode === "oneshot" ? "completed" : "idle";
    }

    const outcome: "completed" | "failed" | "interrupted" =
      handle.lastOutcome === "error"
        ? "failed"
        : handle.lastOutcome === "interrupted"
          ? "interrupted"
          : "completed";
    const cause = handle.terminationCause ?? "natural";
    const trimmedResult = (handle.resultText ?? "").trim();
    const resultLines = trimmedResult ? trimmedResult.split("\n") : [];
    const previewBody = resultLines.slice(0, 3).join("\n");
    const preview = previewBody + (resultLines.length > 3 ? "\n..." : "");
    const agentResult = this._buildAgentResultApiContent(handle, outcome, cause);
    this._appendEntry(createAgentResult(
      this._nextLogId("agent_result"),
      this._turnCount,
      handle.id,
      handle.numericId,
      handle.template,
      outcome,
      cause,
      Math.round((handle.elapsed ?? 0) * 1000),
      agentResult.content,
      preview,
      this._allocateContextId(),
      agentResult.fullOutputPath,
    ), false);
    this._deliverMessage({
      type: "peer_message",
      sender: handle.id,
      content: agentResult.content,
      timestamp: Date.now(),
    });
    handle.terminationCause = undefined;

    // Lifecycle transition: oneshot → archived, persistent → idle
    // NOTE: archived children stay in _childSessions during runtime (Session instance alive,
    // log readable for TUI). Only move to _archivedChildren on close/reset.
    if (handle.mode === "oneshot") {
      handle.lifecycle = "archived";
      this._saveChildSession(handle);
    } else {
      handle.lifecycle = "idle";
      this._saveChildSession(handle);
      // Persistent: only auto-resume queued work after a natural completion.
      // User/parent-triggered kills must leave the agent idle.
      if (cause === "natural") {
        if (handle.session._hasInboxMessages()) {
          // Resolve settle before starting next turn (current turn is done)
          const resolve = handle.settleResolve;
          handle.settleResolve = null;
          resolve?.();
          this._startChildTurn(handle, "", { skipUserInput: true });
          return;
        }
      }
    }

    // Resolve settle promise
    const resolve = handle.settleResolve;
    handle.settleResolve = null;
    resolve?.();
  }

  private _buildAgentResultApiContent(
    handle: ChildSessionHandle,
    outcome: "completed" | "failed" | "interrupted",
    cause: "natural" | "parent_kill" | "user_targeted_kill" | "user_mass_interrupt",
  ): { content: string; fullOutputPath?: string } {
    const causeNote = (cause === "user_mass_interrupt" || cause === "user_targeted_kill")
      ? " by the user"
      : "";
    const header = `[Agent "${handle.id}" ${outcome}${causeNote}]`;
    const text = (handle.resultText ?? "").trim();

    if (!text) {
      return { content: `${header}\n(no output)` };
    }

    if (text.length > SUB_AGENT_OUTPUT_LIMIT) {
      const outputDir = join(this._getArtifactsDir(), "agent-outputs");
      mkdirSync(outputDir, { recursive: true });
      const relativePath = `artifacts/agent-outputs/${handle.id}.md`;
      const outputPath = join(outputDir, `${handle.id}.md`);
      writeFileSync(outputPath, text);
      const truncated = text.slice(0, SUB_AGENT_OUTPUT_LIMIT);
      const truncatedAtLine = truncated.split("\n").length;
      return {
        content:
          `${header}\n` +
          `(Output truncated at ${SUB_AGENT_OUTPUT_LIMIT.toLocaleString()} chars ` +
          `(line ${truncatedAtLine}). Full output: ${relativePath}. ` +
          `Continue reading from line ${truncatedAtLine} with \`read_file(start_line=${truncatedAtLine})\`; ` +
          `do not reread the portion already received.)\n\n` +
          truncated,
        fullOutputPath: relativePath,
      };
    }

    return { content: `${header}\n${text}` };
  }

  /** Move a handle from _childSessions to _archivedChildren, releasing the Session instance. */
  private _archiveHandle(handle: ChildSessionHandle): void {
    this._archivedChildren.set(handle.id, {
      id: handle.id,
      numericId: handle.numericId,
      template: handle.template,
      mode: handle.mode,
      outcome: handle.lastOutcome,
      order: handle.order,
      sessionDir: handle.sessionDir,
      artifactsDir: handle.artifactsDir,
    });
    this._childSessions.delete(handle.id);
  }

  private _sendMessageToChild(childId: string, msg: MessageEnvelope): ToolResult {
    const handle = this._childSessions.get(childId);
    if (!handle) {
      return new ToolResult({ content: `Agent '${childId}' not found.` });
    }
    if (handle.mode !== "persistent") {
      return new ToolResult({ content: `Agent '${childId}' is one-shot and cannot receive messages.` });
    }
    if (handle.lifecycle === "archived") {
      // Persistent archived child still in _childSessions — revive in-place
      if (handle.mode === "persistent") {
        handle.lastActivityAt = Date.now();
        (handle.session as Session)._inbox.push(msg);
        this._startChildTurn(handle, "", { skipUserInput: true });
        return new ToolResult({ content: `Agent '${childId}' revived and message sent.` });
      }
      return new ToolResult({ content: `Agent '${childId}' is a one-shot agent and cannot receive messages.` });
    }

    handle.lastActivityAt = Date.now();
    if (handle.lifecycle === "blocked") {
      return new ToolResult({
        content:
          `ERROR: Agent '${childId}' is waiting for user approval and cannot receive new messages. ` +
          "Resolve the pending approval first.",
      });
    }
    if (handle.lifecycle === "running") {
      handle.session._deliverMessage(msg);
      return new ToolResult({ content: `Message sent to '${childId}'.` });
    }

    // idle — queue message and start turn
    (handle.session as Session)._inbox.push(msg);
    this._startChildTurn(handle, "", { skipUserInput: true });
    return new ToolResult({ content: `Message sent to '${childId}'.` });
  }

  private _interruptBlockedChild(handle: ChildSessionHandle, message: string): void {
    (handle.session as any)._normalizeInterruptedTurnFromLog?.(message);
    handle.session.requestTurnInterrupt();
    handle.lifecycle = handle.mode === "oneshot" ? "archived" : "idle";
    handle.status = handle.mode === "oneshot" ? "interrupted" : "idle";
    handle.phase = "idle";
    handle.lastOutcome = "interrupted";
    handle.lastActivityAt = Date.now();
    this._saveChildSession(handle);
  }

  interruptChildSession(childId: string): { accepted: boolean; reason?: string } {
    const handle = this._childSessions.get(childId);
    if (!handle) return { accepted: false, reason: "not_found" };
    if (!this._isLiveChild(handle)) return { accepted: false, reason: "not_live" };
    handle.terminationCause = "user_targeted_kill";
    if (handle.abortController) {
      handle.abortController.abort();
    } else {
      this._interruptBlockedChild(handle, "Sub-agent was interrupted while waiting for user approval.");
      this._notifyLogListeners();
      this.onSaveRequest?.();
    }
    return { accepted: true };
  }

  interruptAllChildSessions(): { accepted: boolean; interrupted: number; reason?: string } {
    const interrupted = this._cascadeKillRunningChildren("user_mass_interrupt");
    if (interrupted === 0) {
      return { accepted: false, interrupted: 0, reason: "not_live" };
    }
    const message = `User interrupted ${interrupted} sub-agent${interrupted === 1 ? "" : "s"}.`;
    this._appendEntry(createStatus(
      this._nextLogId("status"),
      this._turnCount,
      message,
      "children_interrupted",
    ), false);
    this._deliverMessage({
      type: "system_notice",
      sender: "system",
      content: message,
      timestamp: Date.now(),
    });
    this._notifyLogListeners();
    this.onSaveRequest?.();
    return { accepted: true, interrupted };
  }

  private async _execSpawn(args: Record<string, unknown>): Promise<ToolResult> {
    const idArg = this._argRequiredString("spawn", args, "id", { nonEmpty: true });
    if (idArg instanceof ToolResult) return idArg;
    const taskArg = this._argRequiredString("spawn", args, "task", { nonEmpty: true });
    if (taskArg instanceof ToolResult) return taskArg;
    const modeArg = this._argRequiredString("spawn", args, "mode", { nonEmpty: true });
    if (modeArg instanceof ToolResult) return modeArg;
    const templateArg = this._argOptionalString("spawn", args, "template");
    if (templateArg instanceof ToolResult) return templateArg;
    const templatePathArg = this._argOptionalString("spawn", args, "template_path");
    if (templatePathArg instanceof ToolResult) return templatePathArg;

    const template = (templateArg ?? "").trim();
    const templatePath = (templatePathArg ?? "").trim();

    if (!template && !templatePath) {
      return new ToolResult({ content: "Error: must specify either 'template' or 'template_path'." });
    }
    if (template && templatePath) {
      return new ToolResult({ content: "Error: cannot specify both 'template' and 'template_path'." });
    }

    const spec: Record<string, unknown> = { id: idArg.trim(), task: taskArg.trim(), mode: modeArg.trim() };
    if (template) spec["template"] = template;
    if (templatePath) spec["template_path"] = templatePath;
    if (typeof args["model_level"] === "string") spec["model_level"] = args["model_level"];

    return this._execSpawnFromSpecs([spec]);
  }

  private _execSpawnFromSpecs(
    tasksSpec: Array<Record<string, unknown>>,
  ): ToolResult {
    const spawned: string[] = [];
    const spawnedInfo: Array<{ numericId: number; taskId: string; template: string; task: string }> = [];
    const errors: string[] = [];

    for (const spec of tasksSpec) {
      const taskId = ((spec["id"] as string) ?? "").trim();
      const templateName = ((spec["template"] as string) ?? "").trim();
      const templatePath = ((spec["template_path"] as string) ?? "").trim();
      const taskDesc = ((spec["task"] as string) ?? "").trim();
      const modeRaw = ((spec["mode"] as string) ?? "").trim();
      const modelLevel = typeof spec["model_level"] === "string" ? spec["model_level"].trim() : undefined;

      if (!taskId || !taskDesc) {
        errors.push("Skipped entry: missing 'id' or 'task'.");
        continue;
      }
      if (!templateName && !templatePath) {
        errors.push(`'${taskId}': must specify either 'template' or 'template_path'.`);
        continue;
      }
      if (templateName && templatePath) {
        errors.push(`'${taskId}': cannot specify both 'template' and 'template_path'.`);
        continue;
      }
      if (this._childSessions.has(taskId)) {
        errors.push(`'${taskId}': already running.`);
        continue;
      }

      if (modeRaw !== "oneshot" && modeRaw !== "persistent") {
        errors.push(`'${taskId}': mode must be 'oneshot' or 'persistent'.`);
        continue;
      }
      const mode: ChildSessionMode = modeRaw;

      let agent: Agent;
      let tierThinkingLevel: string | undefined;
      let templateLabel: string;
      try {
        if (templateName) {
          ({ agent, thinkingLevel: tierThinkingLevel } = this._createSubAgentFromPredefined(templateName, taskId, modelLevel));
          templateLabel = templateName;
        } else {
          const resolvedPath = this._resolveTemplatePath(templatePath);
          ({ agent, thinkingLevel: tierThinkingLevel } = this._createSubAgentFromPath(resolvedPath, taskId, modelLevel));
          templateLabel = templatePath;
        }
      } catch (e) {
        errors.push(`'${taskId}': ${e}`);
        continue;
      }

      if (mode === "persistent" && !this.primaryAgent.tools.some((t) => t.name === "send")) {
        this.primaryAgent.tools.push(SEND_TOOL);
      }

      const handle = this._createChildSession(taskId, templateLabel, mode, agent);
      // Tier/pin wins; otherwise inherit parent's preferred level. Setter resolves
      // against the child's model and persists _preferredThinkingLevel into log meta.
      handle.session.thinkingLevel = tierThinkingLevel ?? this._preferredThinkingLevel;
      this._childSessions.set(taskId, handle);
      spawned.push(taskId);
      spawnedInfo.push({ numericId: handle.numericId, taskId, template: templateLabel, task: taskDesc });

      if (this._progress) {
        this._progress.onAgentStart(
          this._turnCount,
          taskId,
          { sub_agent_id: handle.numericId, template: templateLabel },
        );
      }

      this._startChildTurn(handle, taskDesc);
    }

    const parts: string[] = [];
    if (spawned.length) {
      parts.push(
        `Spawned ${spawned.length} sub-session(s): ${spawned.join(", ")}. ` +
        "Results will be delivered as each child session completes a turn.",
      );
    }
    if (errors.length) {
      parts.push("Errors: " + errors.join(" | "));
    }

    // Build TUI preview: list each sub-agent with truncated task
    let previewText: string | undefined;
    if (spawnedInfo.length) {
      const maxTaskLen = 60;
      const lines = spawnedInfo.map((info) => {
        const taskOneLine = info.task.replace(/\s+/g, " ");
        const taskTrunc = taskOneLine.length > maxTaskLen
          ? taskOneLine.slice(0, maxTaskLen - 1) + "…"
          : taskOneLine;
        return `  #${info.numericId} ${info.taskId} [${info.template}] — ${taskTrunc}`;
      });
      previewText = `Spawned ${spawnedInfo.length} sub-agent(s):\n${lines.join("\n")}`;
    }

    return new ToolResult({
      content: parts.join("\n") || "No agents spawned.",
      metadata: previewText ? { tui_preview: { text: previewText, dim: true } } : undefined,
    });
  }

  private _execKillAgent(args: Record<string, unknown>): ToolResult {
    const idsArg = this._argRequiredStringArray("kill_agent", args, "ids");
    if (idsArg instanceof ToolResult) return idsArg;
    const ids = idsArg;

    if (!ids.length) {
      return new ToolResult({ content: "No agent IDs specified." });
    }

    const killed: string[] = [];
    const notFound: string[] = [];
    const alreadyArchived: string[] = [];

    for (const name of ids) {
      const handle = this._childSessions.get(name);
      if (!handle) {
        if (this._archivedChildren.has(name)) {
          alreadyArchived.push(name);
        } else {
          notFound.push(name);
        }
        continue;
      }

      handle.abortController?.abort();
      handle.lifecycle = "archived";
      handle.status = "terminated";
      handle.lastOutcome = "interrupted";
      handle.lastActivityAt = Date.now();
      handle.session._recordSessionEvent("terminated by parent");
      this._saveChildSession(handle);
      killed.push(name);

      if (this._progress) {
        this._progress.emit({
          step: this._turnCount,
          agent: name,
          action: "agent_killed",
          message: `  [#${handle.numericId} ${name}] archived`,
          level: "normal" as ProgressLevel,
          timestamp: Date.now() / 1000,
          usage: {},
          extra: { sub_agent_id: handle.numericId },
        });
      }
    }

    const parts: string[] = [];
    if (killed.length) parts.push(`Killed: ${killed.join(", ")}.`);
    if (alreadyArchived.length) parts.push(`Already archived: ${alreadyArchived.join(", ")}.`);
    if (notFound.length) parts.push(`Not found: ${notFound.join(", ")}.`);
    return new ToolResult({ content: parts.join(" ") });
  }

  // ==================================================================
  // send tool — async message to interactive/team agent
  // ==================================================================

  private async _execSend(args: Record<string, unknown>): Promise<ToolResult> {
    const to = ((args["to"] as string) ?? "").trim();
    const content = ((args["content"] as string) ?? "").trim();
    if (!to || !content) {
      return new ToolResult({ content: "Error: 'to' and 'content' are required." });
    }

    // Direct send — may revive archived persistent agent
    if (!this._childSessions.has(to)) {
      const archived = this._archivedChildren.get(to);
      if (archived) {
        if (archived.mode !== "persistent") {
          return new ToolResult({ content: `Agent '${to}' is a one-shot agent and cannot be revived.` });
        }
        try {
          await this._reviveArchivedChild(archived, content);
          return new ToolResult({ content: `Agent '${to}' revived from archive and message sent.` });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return new ToolResult({ content: `Failed to revive agent '${to}': ${reason}` });
        }
      }
    }

    return this._sendMessageToChild(to, { type: "user_input", sender: "main", content, timestamp: Date.now() });
  }

  /** Revive an archived persistent child: rebuild Session, restore log, start turn. */
  private async _reviveArchivedChild(record: ArchivedChildRecord, messageContent: string): Promise<void> {
    let agent: Agent;
    if (this.agentTemplates[record.template]) {
      ({ agent } = this._createSubAgentFromPredefined(record.template, record.id));
    } else {
      ({ agent } = this._createSubAgentFromPath(this._resolveTemplatePath(record.template), record.id));
    }

    const handle = this._instantiateChildSession(
      record.id,
      record.template,
      record.mode,
      agent,
      { numericId: record.numericId, order: record.order },
    );

    // Restore log from disk
    const loaded = loadLog(record.sessionDir);
    const repaired = validateAndRepairLog(loaded.entries);
    handle.session.restoreFromLog(loaded.meta, repaired.entries, loaded.idAllocator);
    handle.lifecycle = "idle";
    handle.lastOutcome = record.outcome;
    handle.lastActivityAt = Date.now();
    handle.resultText = this._extractLatestAssistantText(handle.session.log);

    // Move from archived to active
    this._childSessions.set(record.id, handle);
    this._archivedChildren.delete(record.id);

    // Deliver message and start turn
    handle.session._inbox.push({ type: "user_input", sender: "main", content: messageContent, timestamp: Date.now() });
    this._startChildTurn(handle, "", { skipUserInput: true });

    // Trigger root save since child references changed
    this.onSaveRequest?.();
  }

  private async _execCheckStatus(_args: Record<string, unknown>): Promise<ToolResult> {
    const sections = [
      "# Sub-Session Status",
      this._buildDetailedChildStatusReport(),
      "",
      "# Pending Root Messages",
      this._buildQueuedRootMessageSummary(),
      "",
      "# Shell",
      this._buildShellReport(),
    ];
    return new ToolResult({ content: sections.join("\n") });
  }

  private _sweepSettledAgents(): void {
    // Child sessions settle themselves via _startChildTurn/_finishChildTurn.
  }

  // ------------------------------------------------------------------
  // await_event — blocking wait for sub-agent completion or new messages
  // ------------------------------------------------------------------

  private async _execAwaitEvent(args: Record<string, unknown>): Promise<ToolResult> {
    const secondsRaw = args["seconds"];
    if (typeof secondsRaw !== "number" || isNaN(secondsRaw)) {
      return new ToolResult({ content: "Error: 'seconds' must be a number." });
    }
    const seconds = Math.max(15, secondsRaw);
    const signal = this._currentTurnSignal;

    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // Pre-check: if inbox already has messages, return immediately.
    // Inbox content is NOT included in tool_result — the activation boundary
    // drain writes them as individual entries after this tool_result.
    if (this._hasInboxMessages()) {
      const brief = this._buildDetailedChildStatusReport();
      const shell = this._buildShellReport();
      const parts = ["Messages pending.", brief, shell].filter(Boolean);
      return new ToolResult({ content: parts.join("\n\n") });
    }

    // 1s polling loop: check inbox every second until timeout or message.
    this._agentState = "waiting";
    this._setSelfPhase("waiting");
    const startMs = Date.now();
    const deadline = startMs + seconds * 1000;

    while (Date.now() < deadline) {
      if (this._hasInboxMessages()) break;
      if (signal?.aborted) {
        this._agentState = "working";
        this._setSelfPhase("idle");
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const sleepMs = Math.min(1000, deadline - Date.now());
      if (sleepMs <= 0) break;
      await new Promise<void>((r) => setTimeout(r, sleepMs));
    }

    this._agentState = "working";
    this._setSelfPhase("idle");

    // Build tool_result: header + status report only (no inbox content).
    const elapsed = Math.round((Date.now() - startMs) / 1000);
    const hasMessages = this._hasInboxMessages();
    const header = hasMessages
      ? `Waited for ${elapsed}s — new message arrived.`
      : `Waited for ${elapsed}s — no new events.`;
    const brief = this._buildDetailedChildStatusReport();
    const shell = this._buildShellReport();
    const parts = [header, brief, shell].filter(Boolean);
    return new ToolResult({ content: parts.join("\n\n") });
  }

  // ------------------------------------------------------------------
  // Elapsed helpers
  // ------------------------------------------------------------------

  private _getElapsed(entry: ChildSessionHandle): number {
    return (performance.now() - entry.startTime) / 1000;
  }

  private _buildQueuedRootMessageSummary(): string {
    if (this._inbox.length === 0) return "No pending root messages.";
    const counts = new Map<string, number>();
    for (const msg of this._inbox) {
      counts.set(msg.sender, (counts.get(msg.sender) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([sender, count]) => `- ${sender}: ${count} queued`)
      .join("\n");
  }

  private _hasActiveAgents(): boolean {
    return this._getWorkingChildHandles().length > 0;
  }

  private _getWorkingChildHandles(): ChildSessionHandle[] {
    return [...this._childSessions.values()].filter((handle) => {
      return handle.lifecycle === "running" && handle.turnPromise !== null;
    });
  }

  private _getWorkingChildRacers(): Array<Promise<{ name: string }>> {
    return this._getWorkingChildHandles()
      .map((handle) =>
        handle.turnPromise!.then(
          () => ({ name: handle.id }),
          () => ({ name: handle.id }),
        ),
      );
  }

  private _cascadeKillRunningChildren(
    cause: "user_mass_interrupt" | "parent_kill",
  ): number {
    let interrupted = 0;
    for (const handle of this._childSessions.values()) {
      if (!this._isLiveChild(handle)) continue;
      handle.terminationCause = cause;
      if (handle.abortController) {
        handle.abortController.abort();
      } else {
        this._interruptBlockedChild(handle, "Sub-agent was interrupted while waiting for user approval.");
      }
      handle.session._recordSessionEvent(cause === "user_mass_interrupt" ? "interrupted by user" : "interrupted by parent");
      interrupted += 1;
    }
    return interrupted;
  }

  /**
   * Suspend all child sessions for close(). Preserves lifecycle semantics:
   * - running persistent → normalize + idle
   * - running oneshot → normalize + archived
   * - idle persistent → stays idle
   * Saves log + inbox for all non-archived children.
   */
  private _suspendAllChildSessions(): void {
    const toArchive: string[] = [];
    for (const [name, handle] of this._childSessions) {
      handle.suspended = true;
      if (this._isLiveChild(handle)) {
        handle.abortController?.abort();
        // Normalize the child's log before persisting
        (handle.session as any)._normalizeInterruptedTurnFromLog(
          "Parent session was interrupted by the user.",
        );
        handle.lastOutcome = "interrupted";
        if (handle.mode === "oneshot") {
          handle.lifecycle = "archived";
          handle.status = "interrupted";
          toArchive.push(name);
        } else {
          handle.lifecycle = "idle";
          handle.status = "idle";
        }
        handle.lastActivityAt = Date.now();
        if (this._progress) {
          this._progress.emit({
            step: this._turnCount,
            agent: name,
            action: "agent_suspended",
            message: `  [#${handle.numericId} ${name}] suspended (${handle.lifecycle})`,
            level: "normal" as ProgressLevel,
            timestamp: Date.now() / 1000,
            usage: {},
            extra: { sub_agent_id: handle.numericId },
          });
        }
      }
      this._saveChildSession(handle);
    }
    // Move oneshot-archived handles out of _childSessions after iteration
    for (const id of toArchive) {
      const handle = this._childSessions.get(id);
      if (handle) this._archiveHandle(handle);
    }
  }

  /**
   * Archive all child sessions unconditionally. Used by _resetTransientState() for /new.
   * All children → archived regardless of mode or current lifecycle.
   */
  private _archiveAllChildSessions(): void {
    for (const [name, handle] of this._childSessions) {
      handle.suspended = true;
      if (this._isLiveChild(handle)) {
        handle.abortController?.abort();
        (handle.session as any)._normalizeInterruptedTurnFromLog(
          "Session was reset by user.",
        );
        handle.lastOutcome = handle.lastOutcome === "none" ? "interrupted" : handle.lastOutcome;
      }
      handle.lifecycle = "archived";
      handle.status = "terminated";
      handle.lastActivityAt = Date.now();
      this._saveChildSession(handle);
    }
    // Move all to archived map
    for (const [_name, handle] of this._childSessions) {
      this._archivedChildren.set(handle.id, {
        id: handle.id,
        numericId: handle.numericId,
        template: handle.template,
        mode: handle.mode,
        outcome: handle.lastOutcome,
        order: handle.order,
        sessionDir: handle.sessionDir,
        artifactsDir: handle.artifactsDir,
      });
    }
    this._childSessions.clear();
  }

  /** Wait for all running child turns to settle, with timeout. */
  private async _waitForAllChildTurnsSettled(): Promise<void> {
    const SETTLE_TIMEOUT_MS = 3000;
    const settlePromises = [...this._childSessions.values()]
      .filter((h) => h.settlePromise)
      .map((h) => h.settlePromise!);
    if (settlePromises.length === 0) return;
    await Promise.race([
      Promise.all(settlePromises),
      new Promise<void>((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS)),
    ]);
  }

  private _forceKillAllShells(): void {
    this._shellManager.forceKillAll();
  }

  private _createSubAgentFromPredefined(templateName: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string } {
    // Try exact match first, then case-insensitive fallback
    let templateAgent = this.agentTemplates[templateName];
    if (!templateAgent) {
      const lower = templateName.toLowerCase();
      for (const [key, agent] of Object.entries(this.agentTemplates)) {
        if (key.toLowerCase() === lower) {
          templateAgent = agent;
          break;
        }
      }
    }
    if (!templateAgent) {
      const available = Object.keys(this.agentTemplates).sort();
      throw new Error(
        `Unknown template '${templateName}'. Available: ${available.join(", ") || "(none)"}`,
      );
    }

    const { modelConfig, thinkingLevel } = this._resolveSubAgentModel(templateName, modelLevel);
    const tools = [...templateAgent.tools]; // Use template's tools, not primary agent's

    const agent = new Agent({
      name: taskId,
      modelConfig,
      systemPrompt: this._renderSystemPrompt(templateAgent.systemPrompt),
      tools,
      maxToolRounds: templateAgent.maxToolRounds,
      description: `Sub-agent '${taskId}' (${templateName})`,
    });
    this._applySubAgentConstraints(agent);
    return { agent, thinkingLevel };
  }

  private _createSubAgentFromPath(templateDir: string, taskId: string, modelLevel?: string): { agent: Agent; thinkingLevel?: string } {
    const templateAgent = loadTemplate(templateDir, this.config, taskId, this._mcpManager, this._promptsDirs);
    const { modelConfig, thinkingLevel } = this._getSubAgentModelConfig(modelLevel);

    const agent = new Agent({
      name: taskId,
      modelConfig,
      systemPrompt: this._renderSystemPrompt(templateAgent.systemPrompt),
      tools: [...templateAgent.tools],
      maxToolRounds: templateAgent.maxToolRounds,
      description: `Sub-agent '${taskId}' (custom)`,
    });
    this._applySubAgentConstraints(agent);
    return { agent, thinkingLevel };
  }

  private _resolveTemplatePath(relPath: string): string {
    const artifactsDir = this._resolveSessionArtifacts();
    let absPath: string;
    try {
      absPath = safePath({
        baseDir: artifactsDir,
        requestedPath: relPath,
        cwd: artifactsDir,
        mustExist: true,
        expectDirectory: true,
        accessKind: "template",
      }).safePath!;
    } catch (e) {
      if (e instanceof SafePathError) {
        if (e.code === "PATH_OUTSIDE_SCOPE") {
          throw new Error("Template path must be within SESSION_ARTIFACTS");
        }
        if (e.code === "PATH_SYMLINK_ESCAPES_SCOPE") {
          throw new Error("Template path escapes SESSION_ARTIFACTS via a symbolic link");
        }
        throw new Error(e.message);
      }
      throw e;
    }

    const validationError = validateTemplate(absPath);
    if (validationError) {
      throw new Error(`Template validation failed: ${validationError}`);
    }

    return absPath;
  }

  private _applySubAgentConstraints(agent: Agent): void {
    // Strip comm tools — send is re-added later for interactive/team agents
    agent.tools = agent.tools.filter((t) => !COMM_TOOL_NAMES.has(t.name));
    // Strip MCP tools when sub-agent inheritance is disabled. Parent's _ensureMcp
    // attached MCP tool defs to template agents; without an executor in the child
    // session the model would see them and fail on call.
    if (!this.config.subAgentInheritMcp) {
      agent.tools = agent.tools.filter((t) => !t.name.startsWith("mcp__"));
    }
    // Lifecycle-specific constraints are injected via _buildSubAgentSystemPrompt,
    // not here — to avoid one-shot language leaking into interactive agents.
  }

  /**
   * Resolve model for a predefined sub-agent template.
   * Priority: agent_models pin > model_level tier > parent model.
   */
  private _resolveSubAgentModel(templateName: string, modelLevel?: string): { modelConfig: ModelConfig; thinkingLevel?: string } {
    // Priority 1: agent_models[templateName] — silently ignores model_level
    try {
      const pinnedEntry = this.config.agentModels[templateName];
      if (pinnedEntry) {
        const resolved = resolveAgentModelEntry(this, pinnedEntry);
        return { modelConfig: resolved.modelConfig, thinkingLevel: resolved.thinkingLevel };
      }
    } catch (err) {
      // Pinned model configured but unavailable — fallback to parent model
      const msg = `Pinned model for '${templateName}' unavailable: ${err instanceof Error ? err.message : String(err)}. Using parent model.`;
      this._appendEntry(createStatus(this._nextLogId("status"), this._turnCount, msg, "agent_model_fallback"));
      return { modelConfig: this.primaryAgent.modelConfig };
    }

    // Priority 2+3: tier or parent model
    return this._getSubAgentModelConfig(modelLevel);
  }

  private _getSubAgentModelConfig(modelLevel?: string): { modelConfig: ModelConfig; thinkingLevel?: string } {
    if (modelLevel && (modelLevel === "high" || modelLevel === "medium" || modelLevel === "low")) {
      try {
        const tier = this.config.modelTiers[modelLevel];
        if (!tier) {
          throw new Error(`Model tier '${modelLevel}' is not configured.`);
        }
        const resolved = resolveModelTierEntry(this, tier);
        return { modelConfig: resolved.modelConfig, thinkingLevel: resolved.thinkingLevel };
      } catch (err) {
        const msg = `Sub-agent requested model tier '${modelLevel}' but it failed: ${err instanceof Error ? err.message : String(err)}. Falling back to current model.`;
        this._appendEntry(createStatus(this._nextLogId("status"), this._turnCount, msg, "tier_fallback"));
        return { modelConfig: this.primaryAgent.modelConfig };
      }
    }
    return { modelConfig: this.primaryAgent.modelConfig };
  }

  /**
   * Build a child session's full system prompt by layering:
   * 1. Template system prompt
   * 2. Mode-specific prompt
   */
  private _buildSubAgentSystemPrompt(
    basePrompt: string,
    persistent: boolean,
  ): string {
    const parts = [basePrompt];

    try {
      const modeFile = persistent ? "persistent.md" : "oneshot.md";
      const modePrompt = this._readPromptFile(`sub-agent/${modeFile}`);
      if (modePrompt) parts.push(modePrompt);
    } catch { /* optional */ }

    return parts.join("\n\n");
  }

  private _readPromptFile(relativePath: string): string {
    if (this._promptsDirs) {
      for (const dir of this._promptsDirs) {
        const fullPath = join(dir, relativePath);
        try {
          return readFileSync(fullPath, "utf-8").trim();
        } catch { /* try next */ }
      }
    }
    return "";
  }

  // _waitForAnyAgent removed — await_event uses 1s polling now, and the
  // activation loop no longer does implicit waits. Model should call
  // await_event explicitly to wait for sub-agent completion.

  // ==================================================================
  // Image file storage (v2 — image_ref)
  // ==================================================================

  private _imageCounter = 0;

  /**
   * If content is a multimodal array, save inline base64 images to disk
   * and replace them with image_ref blocks for the log.
   * Returns the original content if no images, or if session dir is unavailable.
   */
  private _extractAndSaveImages(
    content: string | Array<Record<string, unknown>>,
  ): string | Array<Record<string, unknown>> {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return content;

    let hasImage = false;
    for (const block of content) {
      if (block["type"] === "image" && block["data"]) {
        hasImage = true;
        break;
      }
    }
    if (!hasImage) return content;

    const sessionDir = this._store?.sessionDir;
    if (!sessionDir) return content; // Can't save without session dir

    const imagesDir = join(sessionDir, "images");
    try {
      mkdirSync(imagesDir, { recursive: true });
    } catch {
      return content; // Can't create images dir, keep inline
    }

    return content.map((block) => {
      if (block["type"] !== "image" || !block["data"]) return block;

      const mediaType = (block["media_type"] as string) || "image/png";
      const ext = mediaType.split("/")[1]?.replace("jpeg", "jpg") || "png";
      let filename = "";
      let filePath = "";
      do {
        this._imageCounter += 1;
        filename = `img-${String(this._imageCounter).padStart(3, "0")}.${ext}`;
        filePath = join(imagesDir, filename);
      } while (existsSync(filePath));

      try {
        writeFileSync(filePath, Buffer.from(block["data"] as string, "base64"));
      } catch {
        return block; // Write failed, keep inline
      }

      return {
        type: "image_ref",
        path: `images/${filename}`,
        media_type: mediaType,
      };
    });
  }

  /**
   * Resolve an image_ref path to base64 data for API consumption.
   * Used by projectToApiMessages to restore image data from files.
   */
  private _resolveImageRef(refPath: string): { data: string; media_type: string } | null {
    const sessionDir = this._store?.sessionDir;
    if (!sessionDir) return null;
    const fullPath = join(sessionDir, refPath);
    try {
      const data = readFileSync(fullPath);
      const ext = refPath.split(".").pop() || "png";
      const mediaTypeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
      };
      return {
        data: data.toString("base64"),
        media_type: mediaTypeMap[ext] || "image/png",
      };
    } catch {
      return null;
    }
  }

  // ==================================================================
  // @file attachment processing
  // ==================================================================

  private async _processFileAttachments(userInput: string): Promise<string | Array<Record<string, unknown>>> {
    const supportsMultimodal = this.primaryAgent.modelConfig.supportsMultimodal;
    const [, refs] = parseReferences(userInput);
    const explicitAttachmentRoots = new Set<string>();
    for (const raw of refs) {
      if (!raw || typeof raw !== "string") continue;
      try {
        safePath({
          baseDir: this._projectRoot,
          requestedPath: raw,
          cwd: this._projectRoot,
          accessKind: "attach",
          allowCreate: true,
        });
      } catch (e) {
        if (!(e instanceof SafePathError)) continue;
        if (e.code !== "PATH_OUTSIDE_SCOPE" && e.code !== "PATH_SYMLINK_ESCAPES_SCOPE") continue;
        const lexicalTarget = e.details.resolvedPath || resolve(this._projectRoot, raw);
        explicitAttachmentRoots.add(resolve(lexicalTarget));
      }
    }
    const externalRoots = [...explicitAttachmentRoots];
    const attachmentArtifactsDir =
      this._sessionArtifactsOverride ?? this._getArtifactsDirIfAvailable?.();
    try {
      const result = await processFileAttachments(
        userInput,
        undefined,
        supportsMultimodal,
        this._projectRoot,
        externalRoots,
        attachmentArtifactsDir,
      );

      if (!fileAttachHasFiles(result)) return userInput;

      if (fileAttachHasImages(result) && supportsMultimodal) {
        const contentParts: Array<Record<string, unknown>> = [];
        const cleaned = result.cleanedText.trim();
        if (cleaned) {
          contentParts.push({ type: "text", text: cleaned });
        }
        for (const f of result.files) {
          if (f.isImage && f.imageData) {
            contentParts.push({
              type: "image",
              media_type: f.imageMediaType,
              data: f.imageData,
            });
          }
        }
        if (result.contextStr) {
          contentParts.push({ type: "text", text: result.contextStr });
        }
        return contentParts;
      }

      let userContent = result.cleanedText;
      if (result.contextStr) {
        userContent += "\n\n" + result.contextStr;
      }
      return userContent;
    } catch (e) {
      console.warn(
        `File attachment processing failed; continuing without attachments: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return userInput;
    }
  }

  // ==================================================================
  // MCP integration
  // ==================================================================

  private async _ensureMcp(): Promise<void> {
    if (!this._mcpManager) return;
    const agents = [this.primaryAgent, ...Object.values(this.agentTemplates)];
    this._mcpConnected = await registerMcpTools(
      this._mcpManager,
      this._toolExecutors,
      agents,
    );
  }

  // ==================================================================
  // Persistence
  // ==================================================================

  // getStateForPersistence() and restoreFromPersistence() removed.
  // All persistence is now via getLogForPersistence() / restoreFromLog().

  private _generateSummary(): string {
    if (this._cachedSummary !== undefined) return this._cachedSummary;
    for (const entry of this._log) {
      if (entry.type !== "user_message") continue;
      if (entry.discarded) continue;
      const display = entry.display;
      if (!display) continue;
      if (SYSTEM_PREFIXES.some((prefix) => display.startsWith(prefix))) continue;
      this._cachedSummary = stripContextTags(display).slice(0, 100).trim();
      return this._cachedSummary;
    }
    return "New session";
  }

  // ==================================================================
  // Resource cleanup
  // ==================================================================

  async close(): Promise<void> {
    // 1. Freeze inboxes before interrupt (interrupt clears _inbox)
    const frozenRootInbox = [...this._inbox];
    const frozenChildInboxes = new Map<string, MessageEnvelope[]>();
    for (const [id, handle] of this._childSessions) {
      frozenChildInboxes.set(id, [...(handle.session as Session)._inbox]);
    }

    // 2-3. Interrupt root turn and wait for it to complete
    this.requestTurnInterrupt();
    await this.waitForTurnComplete();

    // 4-5. Abort running child turns and wait for them to settle
    this._cascadeKillRunningChildren("parent_kill");
    await this._waitForAllChildTurnsSettled();

    // 6. Suspend all child sessions (preserves lifecycle)
    this._suspendAllChildSessions();

    // 7. Persist root session (inbox is frozen)
    // The frozen inbox will be included via getLogForPersistence if caller saves
    this._inbox = frozenRootInbox;

    // 8. Kill all shells
    this._forceKillAllShells();

    // 9. Fire Stop hooks (fire-and-forget)
    this.hookRuntime.fireAndForget("Stop", { event: "Stop", timestamp: Date.now() });
    this.hookRuntime.fireAndForget("SessionEnd", { event: "SessionEnd", timestamp: Date.now() });

    // 10. Close MCP connections
    if (this._mcpManager) {
      try {
        await this._mcpManager.closeAll();
      } catch (e) {
        console.warn("Error closing MCP connections:", e);
      }
    }
  }
}
