/**
 * Multi-turn conversation session with context management.
 *
 * Provides the Session class — the core runtime orchestrator.
 * Manages the Primary Agent's conversation, important log,
 * auto-compact, and sub-agent lifecycle.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { getLongerAgentHomeDir } from "./home-path.js";
import { join, dirname, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as yaml from "js-yaml";
import { countTokens as gptCountTokens, encode as gptEncode } from "gpt-tokenizer/model/gpt-5";


import { loadTemplate, validateTemplate } from "./templates/loader.js";

import { Agent, isNoReply, NO_REPLY_MARKER } from "./agents/agent.js";
import type {
  ToolLoopResult,
  ToolExecutor,
  ToolPreflightContext,
  ToolPreflightDecision,
} from "./agents/tool-loop.js";
import { createEphemeralLogState } from "./ephemeral-log.js";
import { isCompactMarker, allocateContextId, stripContextTags, ContextTagStripBuffer } from "./context-rendering.js";
import { generateShowContext } from "./show-context.js";
import { getThinkingLevels, getModelMaxOutputTokens, type Config, type ModelConfig } from "./config.js";
import type { MCPClientManager } from "./mcp-client.js";
import { ProgressEvent, type ProgressLevel, type ProgressReporter } from "./progress.js";
import { ToolResult } from "./providers/base.js";
import type { ToolDef } from "./providers/base.js";
import {
  SPAWN_AGENT_TOOL,
  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  WAIT_TOOL,
  SHOW_CONTEXT_TOOL,
  SUMMARIZE_CONTEXT_TOOL,
  ASK_TOOL,
  PLAN_TOOL,
  SEND_TOOL,
} from "./tools/comm.js";
import {
  BASH_BACKGROUND_TOOL,
  BASH_OUTPUT_TOOL,
  KILL_SHELL_TOOL,
  buildBashEnv,
  executeTool,
} from "./tools/basic.js";
import { execSummarizeContextOnLog } from "./summarize-context.js";
import { resolveSkillContent, loadSkillsMulti, type SkillMeta } from "./skills/loader.js";
import { toolBuiltinWebSearchPassthrough } from "./tools/web-search.js";
import {
  processFileAttachments,
  hasFiles as fileAttachHasFiles,
  hasImages as fileAttachHasImages,
  parseReferences,
} from "./file-attach.js";
import { SafePathError, safePath } from "./security/path.js";
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
  createUserMessage as createUserMessageEntry,
  createAssistantText,
  createReasoning,
  createToolCall,
  createToolResult as createToolResultEntry,
  createNoReply,
  createCompactMarker,
  createCompactContext,
  createSummary,
  createSubAgentStart,
  createSubAgentToolCall,
  createSubAgentEnd,
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
  type GlobalTuiPreferences,
  type LogSessionMeta,
} from "./persistence.js";
import {
  resolvePersistedModelSelection,
  type PersistedModelSelection,
} from "./model-selection.js";
import {
  type ContextThresholds,
  DEFAULT_THRESHOLDS,
  computeHysteresisThresholds,
} from "./settings.js";
// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const MAX_ACTIVATIONS_PER_TURN = 30;
const SUB_AGENT_OUTPUT_LIMIT = 12_000;
const SUB_AGENT_TIMEOUT = 600_000; // milliseconds
const MAX_COMPACT_PHASE_ROUNDS = 10;       // max activations during compact phase

// -- Compact Prompt: Output scenario --
const COMPACT_PROMPT_OUTPUT = `Distill this conversation into a continuation prompt — imagine you're writing a briefing for a fresh instance of yourself who must seamlessly pick up where we left off, with zero access to the original conversation.

**Before writing the continuation prompt**, update your important log with any key discoveries, decisions, or insights from this session that aren't already recorded there. The important log survives compaction and will be visible to the new instance — this is your last chance to persist valuable knowledge.

**What the new instance will already have:** your system prompt, the important log, AGENTS.md persistent memory, and the active plan (if any) are automatically re-injected after compact. Do not duplicate their contents in the continuation prompt — focus on what they don't cover: current progress, session-specific context, and in-flight work state. If you've discovered stable, long-term knowledge during this session, consider persisting it to the project AGENTS.md before compaction.

Your summary should capture everything that matters and nothing that doesn't. Use whatever structure best fits the actual content — there is no fixed template. But as you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's intent, goals, and any constraints or preferences they've expressed — stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and *why*. (Skip anything already in your important log.)
- **Where exactly are we?** What's done, what's in progress, what's next. Be specific enough that work won't be repeated or skipped. (Skip anything already tracked in your plan.)
- **What artifacts exist?** Files read, created, or modified — with enough context about each to be actionable (not just a path list).
- **What tone/style/working relationship has been established?** If the user has shown preferences for how they like to collaborate, note them.
- **What explicit rules has the user stated?** Direct instructions about how to work, what not to do, approval requirements, or behavioral constraints the user has explicitly communicated (e.g., "don't modify code until I approve", "always run tests before committing"). Preserve these verbatim — they are binding rules, not suggestions.

**Err on the side of preserving more, not less.** The continuation prompt is the sole bridge between this conversation and the next — anything omitted is permanently lost to the new instance. Include all information that could plausibly be useful for subsequent work: partial findings, open questions, code snippets you'll need to reference, relevant file paths with context. A longer, thorough continuation prompt that preserves useful context is far better than a terse one that forces the new instance to re-discover things.

Write in natural prose. Use structure where it aids clarity, not for its own sake.`;

// -- Compact Prompt: Tool Call scenario --
const COMPACT_PROMPT_TOOLCALL = `[SYSTEM: COMPACT REQUIRED] The conversation has exceeded the context limit. Do NOT continue the task. Instead, produce a **continuation prompt** — a briefing that will allow a fresh instance of you (with no access to this conversation) to seamlessly resume the work.

You just made a tool call and received its result above. That result is real and should be reflected in your summary, but do not act on it — your only job right now is to write the continuation prompt.

**Before writing the continuation prompt**, update your important log with any key discoveries, decisions, or insights from this session that aren't already recorded there. The important log survives compaction and will be visible to the new instance — this is your last chance to persist valuable knowledge.

**What the new instance will already have:** your system prompt, the important log, AGENTS.md persistent memory, and the active plan (if any) are automatically re-injected after compact. Do not duplicate their contents in the continuation prompt — focus on what they don't cover: current progress, session-specific context, and in-flight work state. If you've discovered stable, long-term knowledge during this session, consider persisting it to the project AGENTS.md before compaction.

Write in natural prose. Use structure where it aids clarity, not for its own sake. As you write, pressure-test yourself against these questions:

- **What are we trying to do?** The user's intent, goals, constraints, and preferences — stated or implied.
- **What do we know now that we didn't at the start?** Key discoveries, failed approaches, edge cases encountered, decisions made and why. (Skip anything already in your important log.)
- **Where exactly did we stop?** Be precise: what was the last tool call, what did it return, and what was supposed to happen next? The new instance must be able to pick up mid-step without repeating or skipping anything.
- **What's done, what's in progress, what remains?** Give a clear picture of overall progress, not just the interrupted step. (Skip anything already tracked in your plan.)
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

const MANUAL_SUMMARIZE_PROMPT = [
  "Review the current active context and use `summarize_context` to compress older groups that are no longer needed in full.",
  "Preserve the latest working context and anything you still need verbatim.",
  "Do not continue the main task beyond this summarize request.",
  "After summarizing, reply briefly with what you compressed and stop.",
].join(" ");

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
  return `[SYSTEM: Context usage has reached ${pct}. Consider reviewing your context to free up space. You can call \`show_context\` to see the current context distribution, then use \`summarize_context\` to compress older groups that are no longer needed in full. Prioritize: completed subtasks, large tool results you've already extracted key info from, and exploratory steps that led to a conclusion. After summarizing, continue your work normally.]`;
}

function HINT_LEVEL2_PROMPT(pct: string): string {
  return `[SYSTEM: Context usage has reached ${pct} — auto-compact will trigger soon. Strongly recommended: call \`show_context\` now to see context distribution, then immediately use \`summarize_context\` to compress older groups. Prioritize: completed subtasks, large tool results, and exploratory steps. After summarizing, continue your work.]`;
}

const SYSTEM_PREFIXES = [
  "[IMPORTANT LOG]",
  "[AUTO-COMPACT]",
  "[Context After Auto-Compact]",
  "[MASTER PLAN:",
  "[PHASE PLAN:",
  "[SUB-AGENT UPDATE]",
  "[SESSION INTERRUPTED]",
  "[SKILL:",
];

const COMM_TOOL_NAMES = new Set([
  "spawn_agent", "kill_agent", "check_status", "wait", "show_context", "summarize_context", "ask", "skill", "reload_skills",
  "bash_background", "bash_output", "kill_shell", "plan", "send",
]);

// ------------------------------------------------------------------
// AgentMessage — message envelope for push delivery & future routing
// ------------------------------------------------------------------

interface AgentMessage {
  from: string;        // "user" | "system" | agent name
  to: string;          // "primary" (future: agent name for team routing)
  content: string;
  timestamp: number;
}

// ------------------------------------------------------------------
// AgentEntry — tracked sub-agent state
// ------------------------------------------------------------------

interface AgentEntry {
  promise: Promise<SubAgentResult>;
  abortController: AbortController;
  numericId: number;
  template: string;
  startTime: number;
  status: "working" | "finished" | "error" | "killed";
  resultText: string;
  elapsed: number;
  delivered: boolean;
  // Live activity tracking
  phase: "thinking" | "generating" | "tool_calling" | "idle";
  recentActivity: string[];   // ring buffer, max 3, human-readable summaries
  toolCallCount: number;

  // --- Persistent agent fields (Phase 2+) ---
  interactive: boolean;          // one-shot (false) vs multi-turn (true)
  teamId: string | null;         // team membership (Phase 4)
  log: LogEntry[];               // persistent conversation log
  idAllocator: LogIdAllocator;   // persistent ID allocator
  persistDir: string;            // artifacts/agents/<id>/
  agent: Agent;                  // Agent instance (provider + tools)
  systemPrompt: string;          // initial system prompt (for team roster)
  task: string;                  // initial task description
  inbox: AgentMessage[];         // per-agent inbox (Phase 3)
  agentState: "idle" | "working"; // per-agent state machine (Phase 3)
  turnBudget: number;            // auto-activation turn budget (Phase 3)
  turnBudgetRemaining: number;   // remaining auto-activation budget
}

interface AgentTeam {
  id: string;
  members: Set<string>;
}

interface SubAgentResult {
  name: string;
  status: string;
  text: string;
  usage: Record<string, number>;
  elapsed: number;
}

interface BackgroundShellEntry {
  id: string;
  process: ChildProcess;
  command: string;
  cwd: string;
  logPath: string;
  startTime: number;
  status: "running" | "exited" | "failed" | "killed";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  readOffset: number;
  recentOutput: string[];
  explicitKill: boolean;
}

interface InterruptSnapshot {
  turnIndex: number;
  hadActiveAgents: boolean;
  hadActiveShells: boolean;
  hadUnconsumed: boolean;
  deliveryContent: string;
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

  private _progress?: ProgressReporter;
  private _mcpManager?: MCPClientManager;
  private _mcpConnected = false;

  private _createdAt: string;
  private _title: string | undefined;
  private _cachedSummary: string | undefined;

  // Structured log (v2 architecture — dual-array transition)
  private _log: LogEntry[] = [];
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
  private _hintResetNone = DEFAULT_THRESHOLDS.summarize_hint_level1 / 100 - 0.20;
  private _hintResetLevel1 = (DEFAULT_THRESHOLDS.summarize_hint_level1 + DEFAULT_THRESHOLDS.summarize_hint_level2) / 200;

  // Context window multiplier (0.0–1.0). Effective context = contextLength × _contextRatio.
  private _contextRatio = 1.0;

  // Hint compression (two-tier state machine)
  private _hintState: "none" | "level1_sent" | "level2_sent" = "none";

  // show_context: number of remaining rounds where annotations are active
  private _showContextRoundsRemaining = 0;
  private _showContextAnnotations: Map<string, string> | null = null;

  // Plan tracking (inline-only, no plan file)
  private _activePlanCheckpoints: string[] = [];
  private _activePlanChecked: boolean[] = [];

  // Skills
  private _skills = new Map<string, SkillMeta>();
  private _skillRoots: string[] = [];
  private _disabledSkills = new Set<string>();

  // Artifacts / persistence
  private _store: any;

  // Path variables
  private _projectRoot: string;
  private _sessionArtifactsOverride: string;
  private _systemData: string;

  // Sub-agents
  private _activeAgents = new Map<string, AgentEntry>();
  private _teams = new Map<string, AgentTeam>();
  private _subAgentCounter = 0;
  private _activeShells = new Map<string, BackgroundShellEntry>();
  private _shellCounter = 0;

  // Thinking level + cache hit + accent
  private _persistedModelSelection: PersistedModelSelection = {};
  private _preferredThinkingLevel = "default";
  private _preferredCacheHitEnabled = true;
  private _preferredAccentColor?: string;
  private _thinkingLevel = "default";
  private _cacheHitEnabled = true;

  // Agent runtime state (for message delivery mode selection)
  private _agentState: "working" | "idle" | "waiting" = "idle";

  // Inbox: holds messages for push delivery into tool results.
  // AgentMessage envelope includes from/to for future agent-to-agent routing.
  private _inbox: AgentMessage[] = [];
  private _currentTurnSignal: AbortSignal | null = null;
  private _currentTurnAbortController: AbortController | null = null;
  private _interruptSnapshot: InterruptSnapshot | null = null;

  // Turn serialization — prevents concurrent turn() calls from corrupting state
  private _turnInFlight: Promise<string | void> | null = null;
  private _turnRelease: (() => void) | null = null;

  /** Callback for incremental persistence — called at save-worthy checkpoints. */
  onSaveRequest?: () => void;

  // Counters
  private _turnCount = 0;
  private _compactCount = 0;
  private _usedContextIds = new Set<string>();

  // Tool executors
  private _toolExecutors: Record<string, ToolExecutor>;

  // Ask state
  private _activeAsk: AskRequest | null = null;
  private _askHistory: AskAuditRecord[] = [];
  private _pendingTurnState: PendingTurnState | null = null;

  /** Allocate a unique random hex context ID. */
  private _allocateContextId(): string {
    return allocateContextId(this._usedContextIds);
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
  }) {
    this.primaryAgent = opts.primaryAgent;
    this.config = opts.config;
    this.agentTemplates = opts.agentTemplates ?? {};
    this._skills = opts.skills ?? new Map();
    this._skillRoots = opts.skillRoots ?? [];
    this._progress = opts.progress;
    this._mcpManager = opts.mcpManager;
    this._promptsDirs = opts.promptsDirs;

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
    this._sessionArtifactsOverride = "";
    this._systemData = "";

    this._createdAt = new Date().toISOString();
    this._initConversation();
    this._toolExecutors = this._buildToolExecutors();
    this._ensureCommTools();
    this._ensureSkillTool();
    this._persistedModelSelection = this._buildPersistedModelSelection();
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

  private _initConversation(): void {
    this._createdAt = new Date().toISOString();
    this._title = undefined;
    this._cachedSummary = undefined;
    const systemPrompt = this._renderSystemPrompt(this.primaryAgent.systemPrompt);
    this._log = [];
    this._idAllocator = new LogIdAllocator();
    this._appendEntry(
      createSystemPrompt(this._nextLogId("system_prompt"), systemPrompt),
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
    this._notifyLogListeners();
    if (save) this.onSaveRequest?.();
  }

  private _touchLog(): void {
    this._notifyLogListeners();
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
      if (entry.discarded || entry.summarized) continue;
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
      if (entry.type === "tool_call") return true;
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
   * Routes based on _agentState:
   *   idle    → direct injection into _log
   *   working → inbox (delivered via tool_result push or activation boundary drain)
   *   waiting → inbox + wake wait
   */
  private _deliverMessage(msg: AgentMessage): void {
    if (this._agentState === "idle") {
      this._injectMessageDirect(msg);
      return;
    }
    // working / waiting → enqueue
    this._inbox.push(msg);
    if (this._agentState === "waiting") {
      this._wakeWait();
    }
  }

  /**
   * Public wrapper for TUI / GUI to deliver messages.
   * Preserves the original (source, content) signature for external callers.
   */
  deliverMessage(source: "user" | "system" | "sub-agent", content: string): void {
    this._deliverMessage({ from: source, to: "primary", content, timestamp: Date.now() });
  }

  /**
   * Direct injection (idle-state safety net).
   */
  private _injectMessageDirect(msg: AgentMessage): void {
    const ctxId = this._allocateContextId();
    const formatted = `[Message from ${msg.from}]\n${msg.content}`;
    // v2 log (source of truth)
    this._appendEntry(
      createUserMessageEntry(
        this._nextLogId("user_message"),
        this._turnCount,
        formatted,
        formatted,
        ctxId,
      ),
      false,
    );
  }

  /**
   * Check whether the inbox has pending messages.
   */
  private _hasInboxMessages(): boolean {
    return this._inbox.length > 0;
  }

  /**
   * Check whether any agent has finished/errored but not yet delivered.
   */
  private _hasUndeliveredAgentResults(): boolean {
    for (const entry of this._activeAgents.values()) {
      if ((entry.status === "finished" || entry.status === "error") && !entry.delivered) {
        return true;
      }
    }
    return false;
  }

  private _hasTrackedShells(): boolean {
    return this._activeShells.size > 0;
  }

  private _hasRunningShells(): boolean {
    for (const entry of this._activeShells.values()) {
      if (entry.status === "running") return true;
    }
    return false;
  }

  private _getShellsDir(): string {
    const dir = join(this._resolveSessionArtifacts(), "shells");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private _normalizeShellId(id: string): string | null {
    const trimmed = id.trim();
    if (!trimmed) return null;
    return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
  }

  private _recordShellChunk(entry: BackgroundShellEntry, chunk: string): void {
    if (!chunk) return;
    appendFileSync(entry.logPath, chunk, "utf-8");
    const lines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      entry.recentOutput.push(line);
      if (entry.recentOutput.length > 3) entry.recentOutput.shift();
    }
  }

  private _buildShellReport(): string {
    if (this._activeShells.size === 0) {
      return "No shells tracked.";
    }

    const lines: string[] = [];
    for (const [id, entry] of this._activeShells) {
      const elapsedSec = ((performance.now() - entry.startTime) / 1000).toFixed(1);
      let line = `- [${id}] ${entry.status} (${elapsedSec}s)`;
      if (entry.status === "exited" || entry.status === "failed") {
        line += ` | exit=${entry.exitCode ?? "?"}`;
      } else if (entry.status === "killed") {
        line += ` | signal=${entry.signal ?? "TERM"}`;
      }
      line += ` | log: ${entry.logPath}`;
      if (entry.recentOutput.length > 0) {
        line += `\n    recent: ${entry.recentOutput.join(" → ")}`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  /**
   * Build unified delivery content: drain queue + build agent report.
   * Used by check_status, wait, and activation boundary injection.
   */
  private _buildDeliveryContent(opts?: { drainQueue?: boolean }): string {
    const drainQueue = opts?.drainQueue ?? true;
    const queued = drainQueue ? this._inbox : [...this._inbox];
    // 1. Drain inbox, group by sender
    const byFrom: Record<string, string[]> = {};
    for (const msg of queued) {
      if (!byFrom[msg.from]) byFrom[msg.from] = [];
      byFrom[msg.from].push(msg.content);
    }
    if (drainQueue) {
      this._inbox = [];
    }

    // 2. Build three-section format
    const sections: string[] = [];

    sections.push("# User");
    sections.push(byFrom["user"]?.join("\n\n") ?? "No new message.");

    sections.push("# System");
    sections.push(byFrom["system"]?.join("\n\n") ?? "No new message.");

    // 3. Sub-Agent section: always use live report when agents exist
    sections.push("# Sub-Agent");
    if (this._activeAgents.size > 0) {
      sections.push(this._buildAgentReport());
    } else {
      sections.push("No agents tracked.");
    }

    sections.push("# Shell");
    sections.push(this._buildShellReport());

    return sections.join("\n");
  }

  /**
   * Inject all pending messages at activation boundary.
   * Drains queue + builds agent report → pushes as user message.
   */
  private _injectPendingMessages(): void {
    const content = this._buildDeliveryContent();
    const ctxId = this._allocateContextId();
    const formatted = `[New Messages]\n\n${content}`;
    // v2 log (source of truth)
    this._appendEntry(
      createUserMessageEntry(
        this._nextLogId("user_message"),
        this._turnCount,
        formatted,
        formatted,
        ctxId,
      ),
      false,
    );
  }

  /**
   * Build notification content for push delivery into tool results.
   * Drains the inbox and marks agent results as delivered.
   * Returns null if nothing pending.
   */
  private _buildNotificationContent(): string | null {
    const hasMsgs = this._inbox.length > 0;
    const hasAgentResults = this._hasUndeliveredAgentResults();
    if (!hasMsgs && !hasAgentResults) return null;

    const sections: string[] = [];

    // 1. Drain inbox, group by sender
    if (this._inbox.length > 0) {
      const byFrom: Record<string, string[]> = {};
      for (const msg of this._inbox) {
        (byFrom[msg.from] ??= []).push(msg.content);
      }
      this._inbox = [];
      for (const [from, msgs] of Object.entries(byFrom)) {
        sections.push(`[Message from ${from}]\n${msgs.join("\n\n")}`);
      }
    }

    // 2. Consume agent results (sweep + mark delivered)
    if (hasAgentResults) {
      this._sweepSettledAgents();
      for (const [name, entry] of this._activeAgents) {
        if ((entry.status === "finished" || entry.status === "error") && !entry.delivered) {
          sections.push(this._formatAgentOutput({
            name, status: entry.status, text: entry.resultText, elapsed: entry.elapsed,
          }));
          entry.delivered = true;
        }
      }
    }

    return `\n\n[Incoming Messages]\n${sections.join("\n\n---\n\n")}`;
  }

  // Wait wake-up signal
  private _waitResolver: (() => void) | null = null;

  private _wakeWait(): void {
    if (this._waitResolver) {
      this._waitResolver();
      this._waitResolver = null;
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

    this._currentTurnAbortController?.abort();

    let hadActiveAgents = false;
    for (const entry of this._activeAgents.values()) {
      if (entry.status === "working") {
        hadActiveAgents = true;
        break;
      }
    }
    const hadActiveShells = this._hasRunningShells();
    const hadUnconsumed = this._hasInboxMessages() || this._hasUndeliveredAgentResults();

    this._interruptSnapshot = {
      turnIndex: this._turnCount,
      hadActiveAgents,
      hadActiveShells,
      hadUnconsumed,
      deliveryContent:
        hadActiveAgents || hadActiveShells || hadUnconsumed
          ? this._buildDeliveryContent({ drainQueue: false })
          : "",
    };

    this._activeAsk = null;
    this._pendingTurnState = null;
    this._inbox = [];
    this._wakeWait();
    if (this._activeAgents.size > 0) {
      this._forceKillAllAgents();
    }
    if (this._activeShells.size > 0) {
      this._forceKillAllShells();
    }
    return { accepted: true };
  }

  /**
   * Backward-compatible alias.
   */
  cancelCurrentTurn(): void {
    this.requestTurnInterrupt();
  }

  private _resetTransientState(): void {
    this._lastInputTokens = 0;
    this._lastTotalTokens = 0;
    this._lastCacheReadTokens = 0;
    this._compactInProgress = false;
    this._hintState = "none";
    this._agentState = "idle";
    this._inbox = [];
    this._waitResolver = null;
    this._interruptSnapshot = null;
    this._activeAsk = null;
    this._askHistory = [];
    this._pendingTurnState = null;
    if (this._activeAgents.size > 0) {
      this._forceKillAllAgents();
    }
    if (this._activeShells.size > 0) {
      this._forceKillAllShells();
    }
    this._subAgentCounter = 0;
    this._shellCounter = 0;
    this._showContextRoundsRemaining = 0;
    this._showContextAnnotations = null;
    this._activePlanCheckpoints = [];
    this._activePlanChecked = [];
  }

  // ------------------------------------------------------------------
  // Log accessors (v2)
  // ------------------------------------------------------------------

  /** Read-only snapshot of the structured log. */
  get log(): readonly LogEntry[] {
    return this._log;
  }

  /** Subscribe to log changes. Returns an unsubscribe function. */
  subscribeLog(listener: () => void): () => void {
    this._logListeners.add(listener);
    return () => { this._logListeners.delete(listener); };
  }

  /**
   * Restore session from a loaded log.
   */
  restoreFromLog(
    meta: LogSessionMeta,
    entries: LogEntry[],
    idAllocator: LogIdAllocator,
  ): void {
    const restoredSelection = resolvePersistedModelSelection(this, {
      modelConfigName: meta.modelConfigName || undefined,
      modelProvider: meta.modelProvider,
      modelSelectionKey: meta.modelSelectionKey,
      modelId: meta.modelId,
    });
    const restoredModelConfig = this.config.getModel(restoredSelection.selectedConfigName);
    const restoredThinkingPreference = meta.thinkingLevel ?? "default";
    const restoredCachePreference = meta.cacheHitEnabled ?? true;

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
    this._idAllocator = idAllocator;

    // Counters from meta
    this._turnCount = meta.turnCount;
    this._compactCount = meta.compactCount;
    this._preferredThinkingLevel = restoredThinkingPreference;
    this._preferredCacheHitEnabled = restoredCachePreference;
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      restoredModelConfig.model,
      restoredThinkingPreference,
    );
    this._cacheHitEnabled = restoredCachePreference;
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

    // Restore ask state from log: find unclosed ask_request
    this._restoreAskStateFromLog(entries);

    // Restore active plan from meta
    if (meta.activePlanCheckpoints && meta.activePlanCheckpoints.length > 0) {
      this._activePlanCheckpoints = meta.activePlanCheckpoints;
      this._activePlanChecked = meta.activePlanChecked ?? meta.activePlanCheckpoints.map(() => false);
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

    this._notifyLogListeners();
  }

  /**
   * Get log data for persistence (v2).
   * Returns meta + entries suitable for saveLog().
   */
  getLogForPersistence(): { meta: LogSessionMeta; entries: readonly LogEntry[] } {
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
        cacheHitEnabled: this._cacheHitEnabled,
        title: this._title,
        summary: this._generateSummary(),
        activePlanCheckpoints: this._activePlanCheckpoints.length > 0 ? this._activePlanCheckpoints : undefined,
        activePlanChecked: this._activePlanChecked.length > 0 ? this._activePlanChecked : undefined,
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

    // 4. Reset thinking/cache state
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      this._preferredThinkingLevel,
    );
    this._cacheHitEnabled = this._preferredCacheHitEnabled;

    // 5. Reset MCP connection flag (will reconnect on next turn)
    this._mcpConnected = false;

    // 6. Re-init conversation LAST (fresh session state, storage may still be lazy)
    // _initConversation also resets _log and _idAllocator
    this._initConversation();
  }

  private _buildToolExecutors(): Record<string, ToolExecutor> {
    const scopedBuiltin = (toolName: string): ToolExecutor =>
      (args) => executeTool(toolName, args, {
        projectRoot: this._projectRoot,
        externalPathAllowlist: [this._resolveSessionArtifacts()],
        sessionArtifactsDir: this._resolveSessionArtifacts(),
        supportsMultimodal: this.primaryAgent.modelConfig.supportsMultimodal,
      });

    return {
      read_file: scopedBuiltin("read_file"),
      list_dir: scopedBuiltin("list_dir"),
      glob: scopedBuiltin("glob"),
      grep: scopedBuiltin("grep"),
      edit_file: scopedBuiltin("edit_file"),
      write_file: scopedBuiltin("write_file"),
      apply_patch: scopedBuiltin("apply_patch"),
      diff: scopedBuiltin("diff"),
      web_fetch: (args) => executeTool("web_fetch", args),
      bash: (args) => executeTool("bash", args, {
        projectRoot: this._projectRoot,
        externalPathAllowlist: [this._resolveSessionArtifacts()],
      }),
      test: (args) => executeTool("test", args, { projectRoot: this._projectRoot }),
      bash_background: (args) => this._execBashBackground(args),
      bash_output: (args) => this._execBashOutput(args),
      kill_shell: (args) => this._execKillShell(args),
      spawn_agent: (args) => this._execSpawnAgents(args),
      kill_agent: (args) => this._execKillAgent(args),
      check_status: (args) => this._execCheckStatus(args),
      wait: (args) => this._execWait(args),
      show_context: (args) => this._execShowContext(args),
      summarize_context: (args) => this._execSummarizeContext(args),
      ask: (args) => this._execAsk(args),
      plan: (args) => this._execPlan(args),
      skill: (args) => this._execSkill(args),
      reload_skills: () => this._execReloadSkills(),
      send: (args) => this._execSend(args),
      $web_search: (args) => toolBuiltinWebSearchPassthrough(args as Record<string, unknown>),
    };
  }

  private _ensureCommTools(): void {
    const existing = new Set(this.primaryAgent.tools.map((t) => t.name));
    for (const toolDef of [
      SPAWN_AGENT_TOOL, KILL_AGENT_TOOL, CHECK_STATUS_TOOL, WAIT_TOOL,
      SHOW_CONTEXT_TOOL, SUMMARIZE_CONTEXT_TOOL,
      ASK_TOOL, PLAN_TOOL,
      // SEND_TOOL is injected dynamically when interactive agents exist
    ]) {
      if (!existing.has(toolDef.name)) {
        this.primaryAgent.tools.push(toolDef);
      }
    }
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
    const entry = this._activeAgents.get(agentId);
    return entry ? entry.log : null;
  }

  getActiveAgentIds(): Array<{ id: string; status: string; interactive: boolean; teamId: string | null }> {
    const result: Array<{ id: string; status: string; interactive: boolean; teamId: string | null }> = [];
    for (const [id, entry] of this._activeAgents) {
      result.push({ id, status: entry.agentState === "working" ? "working" : entry.status, interactive: entry.interactive, teamId: entry.teamId });
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
   * the skill tool definition + re-register slash commands.
   */
  reloadSkills(): { added: string[]; removed: string[]; total: number } {
    const oldNames = new Set(this._skills.keys());
    const freshAll = loadSkillsMulti(this._skillRoots);

    // Apply disabled filter
    const filtered = new Map<string, SkillMeta>();
    for (const [name, skill] of freshAll) {
      if (!this._disabledSkills.has(name)) {
        filtered.set(name, skill);
      }
    }

    const newNames = new Set(filtered.keys());
    const added = [...newNames].filter((n) => !oldNames.has(n));
    const removed = [...oldNames].filter((n) => !newNames.has(n));

    this._skills = filtered;
    this._ensureSkillTool();

    return { added, removed, total: filtered.size };
  }

  /**
   * Build the `skill` tool definition dynamically from loaded skills.
   * Returns null if no skills are available for the agent.
   */
  private _buildSkillToolDef(): ToolDef | null {
    const available = [...this._skills.values()].filter(
      (s) => !s.disableModelInvocation,
    );
    if (available.length === 0) return null;

    const listing = available
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");

    return {
      name: "skill",
      description:
        "Invoke a skill by name. The skill's full instructions are returned for you to follow.\n\n" +
        "Available skills:\n" +
        listing,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The skill name to invoke.",
          },
          arguments: {
            type: "string",
            description:
              "Arguments to pass to the skill (e.g. file path, module name). " +
              "Referenced via $ARGUMENTS in the skill instructions.",
          },
        },
        required: ["name"],
      },
      summaryTemplate: "{agent} is invoking skill {name}",
    };
  }

  private _buildReloadSkillsToolDef(): ToolDef {
    return {
      name: "reload_skills",
      description:
        "Rescan skill directories, update the in-memory skills map, and rebuild the skill tool definition. " +
        "Use after installing, removing, or modifying skills on disk.",
      parameters: { type: "object", properties: {} },
      summaryTemplate: "{agent} is reloading skills",
    };
  }

  /** Add the skill + reload_skills tools to the primary agent. */
  private _ensureSkillTool(): void {
    // Remove old skill-related tools
    this.primaryAgent.tools = this.primaryAgent.tools.filter(
      (t) => t.name !== "skill" && t.name !== "reload_skills",
    );

    const skillDef = this._buildSkillToolDef();
    if (skillDef) {
      this.primaryAgent.tools.push(skillDef);
    }

    // Always add reload_skills if there are skill roots configured
    if (this._skillRoots.length > 0) {
      this.primaryAgent.tools.push(this._buildReloadSkillsToolDef());
    }
  }

  /** Execute the `reload_skills` tool. */
  private _execReloadSkills(): ToolResult {
    const result = this.reloadSkills();
    const lines = [`Skills reloaded. Total active: ${result.total}`];
    if (result.added.length) lines.push(`Added: ${result.added.join(", ")}`);
    if (result.removed.length) lines.push(`Removed: ${result.removed.join(", ")}`);
    const current = [...this._skills.keys()];
    lines.push(`\nCurrently available: ${current.join(", ") || "(none)"}`);
    return new ToolResult({ content: lines.join("\n") });
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

  get cacheHitEnabled(): boolean {
    return this._cacheHitEnabled;
  }

  set cacheHitEnabled(value: boolean) {
    this._preferredCacheHitEnabled = value;
    this._cacheHitEnabled = value;
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
    this._cacheHitEnabled = this._preferredCacheHitEnabled;
    if (this._turnCount === 0) {
      this._updateInitialTokenEstimate();
      this._notifyLogListeners();
    }
  }

  applyGlobalPreferences(preferences: GlobalTuiPreferences): void {
    const prefs = createGlobalTuiPreferences(preferences);
    this._preferredThinkingLevel = prefs.thinkingLevel;
    this._preferredCacheHitEnabled = prefs.cacheHitEnabled;
    this._preferredAccentColor = prefs.accentColor;
    this._thinkingLevel = this._resolveThinkingLevelForModel(
      this.primaryAgent.modelConfig.model,
      prefs.thinkingLevel,
    );
    this._cacheHitEnabled = prefs.cacheHitEnabled;

    // Restore disabled skills
    if (prefs.disabledSkills && prefs.disabledSkills.length > 0) {
      this._disabledSkills = new Set(prefs.disabledSkills);
      this.reloadSkills();
    }
  }

  getGlobalPreferences(): GlobalTuiPreferences {
    return createGlobalTuiPreferences({
      modelConfigName: this._persistedModelSelection.modelConfigName ?? undefined,
      modelProvider: this._persistedModelSelection.modelProvider ?? undefined,
      modelSelectionKey: this._persistedModelSelection.modelSelectionKey ?? undefined,
      modelId: this._persistedModelSelection.modelId ?? undefined,
      thinkingLevel: this._preferredThinkingLevel,
      cacheHitEnabled: this._preferredCacheHitEnabled,
      accentColor: this._preferredAccentColor,
      disabledSkills: this._disabledSkills.size > 0
        ? [...this._disabledSkills]
        : undefined,
    });
  }

  private _resolveThinkingLevelForModel(modelName: string, preferredLevel: string): string {
    if (!preferredLevel || preferredLevel === "default") return "default";
    const levels = getThinkingLevels(modelName);
    if (levels.length === 0) return "default";
    return levels.includes(preferredLevel) ? preferredLevel : "default";
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

  appendStatusMessage(text: string, statusType = "status"): void {
    this._appendEntry(
      createStatus(this._nextLogId("status"), this._turnCount, text, statusType),
      true,
    );
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
    if (this._hasUndeliveredAgentResults()) {
      return `Cannot run ${command} while sub-agent results are waiting to be delivered.`;
    }
    return null;
  }

  private _armShowContextAnnotations(): void {
    const mc = this.primaryAgent.modelConfig;
    const provider = (this.primaryAgent as any)._provider;
    const effectiveMax = mc.maxTokens;
    const budget = provider.budgetCalcMode === "full_context"
      ? this._effectiveContextLength(mc)
      : this._effectiveContextLength(mc) - effectiveMax;
    const result = generateShowContext(this._log, this._lastInputTokens, budget);
    this._showContextRoundsRemaining = 1;
    this._showContextAnnotations = result.annotations;
  }

  private async _runInjectedTurn(
    displayText: string,
    content: string,
    opts?: { signal?: AbortSignal; armShowContext?: boolean },
  ): Promise<string> {
    if (opts?.armShowContext) {
      this._armShowContextAnnotations();
    }

    const userCtxId = this._allocateContextId();
    this._turnCount += 1;
    this._appendEntry(
      createTurnStart(this._nextLogId("turn_start"), this._turnCount),
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

  async runManualSummarize(instruction?: string, options?: { signal?: AbortSignal }): Promise<string> {
    return this._withTurnLock(async () => {
      this._ensureSessionStorageReady();
      await this._ensureMcp();

      const blocker = this._getManualContextCommandBlocker("/summarize");
      if (blocker) throw new Error(blocker);

      const prompt = appendManualInstruction(
        MANUAL_SUMMARIZE_PROMPT,
        instruction,
        "summarize",
      );
      return this._runInjectedTurn(
        "[Manual summarize request]",
        prompt,
        { signal: options?.signal, armShowContext: true },
      );
    });
  }

  async runManualCompact(instruction?: string, options?: { signal?: AbortSignal }): Promise<void> {
    return this._withTurnLock(async () => {
      this._ensureSessionStorageReady();

      const blocker = this._getManualContextCommandBlocker("/compact");
      if (blocker) throw new Error(blocker);

      this._turnCount += 1;
      this._appendEntry(
        createTurnStart(this._nextLogId("turn_start"), this._turnCount),
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
  private _restoreAskStateFromLog(entries: LogEntry[]): void {
    // Build set of resolved ask IDs
    const resolvedAskIds = new Set<string>();
    for (const e of entries) {
      if (e.type === "ask_resolution" && !e.discarded) {
        resolvedAskIds.add(String((e.meta as Record<string, unknown>)["askId"] ?? ""));
      }
    }

    // Find unclosed ask_request (has no matching ask_resolution)
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type !== "ask_request" || e.discarded) continue;
      const askId = String((e.meta as Record<string, unknown>)["askId"] ?? "");
      if (resolvedAskIds.has(askId)) continue;

      // Found an unclosed ask — restore it as active
      const payload = e.content as Record<string, unknown>;
      const askKind = String((e.meta as Record<string, unknown>)["askKind"] ?? "agent_question");
      if (askKind === "agent_question") {
        const meta = e.meta as Record<string, unknown>;
        this._activeAsk = {
          id: askId,
          kind: "agent_question",
          createdAt: new Date(e.timestamp).toISOString(),
          source: { agentId: this.primaryAgent.name, agentName: this.primaryAgent.name },
          roundIndex: typeof meta["roundIndex"] === "number" ? (meta["roundIndex"] as number) : undefined,
          summary: `Restored ask`,
          payload: payload as any,
          options: [],
        };
      }
      break;
    }
  }

  getPendingAsk(): PendingAskUi | null {
    return toPendingAskUi(this._activeAsk);
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

  private _beforeToolExecute = (
    _ctx: ToolPreflightContext,
  ): ToolPreflightDecision | void => {
    return;
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

      const textAccumulator = { text: "" };
      const reasoningAccumulator = { text: "" };
      return this._runTurnActivationLoop(options?.signal, textAccumulator, reasoningAccumulator);
    });
  }

  private async _runTurnActivationLoop(
    signal: AbortSignal | undefined,
    textAccumulator: { text: string },
    reasoningAccumulator: { text: string },
  ): Promise<string> {
    let finalText = "";
    const turnSignalState = this._installCurrentTurnSignal(signal);
    const activeSignal = turnSignalState.signal;
    try {
      let reachedLimit = true;
      for (let activationIdx = 0; activationIdx < MAX_ACTIVATIONS_PER_TURN; activationIdx++) {
        if (activeSignal.aborted) break;

        const t0 = performance.now();
        const logLenBeforeActivation = this._log.length;
        textAccumulator.text = "";
        reasoningAccumulator.text = "";
        this._agentState = "working";

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
        const _hasNoReply = isNoReply(result.text) || _trimmedText.endsWith(NO_REPLY_MARKER);

        if (_hasNoReply) {
          const _precedingText = _trimmedText
            .slice(0, _trimmedText.length - NO_REPLY_MARKER.length)
            .trim();

          if (this._progress) {
            this._progress.onNoReplyClear(this.primaryAgent.name);
          }
          emitAgentEndOnce();
          if (this._progress) {
            this._progress.onAgentNoReply(this.primaryAgent.name);
          }

          if (!this._hasActiveAgents()) {
            // Silently ignore <NO_REPLY> when no sub-agents are running
            continue;
          }

          const noReplyContent = _precedingText || "<NO_REPLY>";
          const noReplyRound = result.reasoningHandledInLog
            ? Math.max(0, this._computeNextRoundIndex() - 1)
            : this._computeNextRoundIndex();
          const noReplyContextId = this._resolveOutputRoundContextId(this._turnCount, noReplyRound);
          if (result.textHandledInLog || result.reasoningHandledInLog) {
            this._retagRoundEntries(this._turnCount, noReplyRound, noReplyContextId);
          }

          // v2 log: create no_reply entry (+ reasoning if present)
          {
            if (result.reasoningContent && !result.reasoningHandledInLog) {
              this._appendEntry(createReasoning(
                this._nextLogId("reasoning"),
                this._turnCount,
                noReplyRound,
                result.reasoningContent,
                result.reasoningContent,
                result.reasoningState,
                noReplyContextId,
              ), false);
            }
            this._appendEntry(createNoReply(
              this._nextLogId("no_reply"),
              this._turnCount,
              noReplyRound,
              noReplyContent,
              noReplyContextId,
            ), false);
          }
          this.onSaveRequest?.();

          await this._waitForAnyAgent(activeSignal);
          if (activeSignal.aborted) {
            this._handleInterruption(logLenBeforeActivation, textAccumulator.text, {
              activationCompleted: true,
            });
            this.onSaveRequest?.();
            finalText = textAccumulator.text.trim() || "";
            break;
          }

          this.onSaveRequest?.();
          // Fall through to activation boundary drain (★) below
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
          if (this._hasInboxMessages() || this._hasUndeliveredAgentResults() || this._hasActiveAgents()) {
            this._injectPendingMessages();
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
              break;
            }
            throw compactErr;
          }
          this.onSaveRequest?.();

          if (result.compactScenario === "output") {
            reachedLimit = false;
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

        // Wait for active agents (if any and no queued messages yet)
        if (this._hasActiveAgents() && !this._hasInboxMessages() && !this._hasUndeliveredAgentResults()) {
          await this._waitForAnyAgent(activeSignal);
          if (activeSignal.aborted) {
            this._handleInterruption(logLenBeforeActivation, textAccumulator.text, {
              activationCompleted: true,
            });
            this.onSaveRequest?.();
            finalText = textAccumulator.text.trim() || "";
            break;
          }

          this.onSaveRequest?.();
        }

        // ★ ACTIVATION BOUNDARY DRAIN — unified exit point ★
        if (this._hasInboxMessages() || this._hasUndeliveredAgentResults()) {
          this._injectPendingMessages();
          continue;  // new activation to process injected messages
        }

        // Still have active agents but nothing pending yet — wait more
        if (this._hasActiveAgents()) {
          await this._waitForAnyAgent(activeSignal);
          if (activeSignal.aborted) {
            this._handleInterruption(logLenBeforeActivation, textAccumulator.text, {
              activationCompleted: true,
            });
            this.onSaveRequest?.();
            finalText = textAccumulator.text.trim() || "";
            break;
          }

          this.onSaveRequest?.();
          continue;  // loop back to drain check
        }

        // Nothing pending, no active agents → turn ends
        reachedLimit = false;
        this._agentState = "idle";
        break;
      }

      if (reachedLimit && !activeSignal.aborted) {
        console.warn(`Turn reached activation limit (${MAX_ACTIVATIONS_PER_TURN})`);
        if (!finalText) {
          finalText =
            "[Turn terminated: reached maximum activation limit " +
            "without producing output. This may indicate a stuck loop.]";
        }
      }
    } finally {
      this._restoreCurrentTurnSignal(turnSignalState);
      // Drain any messages that arrived after the last activation boundary check.
      // Without this, messages queued during the final activation would be orphaned.
      if (this._hasInboxMessages() || this._hasUndeliveredAgentResults()) {
        this._injectPendingMessages();
      }
      this._agentState = "idle";
      if (!this._activeAsk && this._hasActiveAgents()) {
        this._cleanupNonInteractiveAgents();
      }
    }

    return finalText;
  }

  async turn(userInput: string, options?: { signal?: AbortSignal }): Promise<string> {
    return this._withTurnLock(() => this._turnInner(userInput, options));
  }

  /** Inner turn logic, called from within the turn lock. */
  private async _turnInner(userInput: string, options?: { signal?: AbortSignal }): Promise<string> {
    this._ensureSessionStorageReady();
    await this._ensureMcp();

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
      return this._runTurnActivationLoop(options?.signal, ta, ra);
    }

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
    // Assign context_id to user message (metadata only, no visible §{id}§ tag in content)
    const userCtxId = this._allocateContextId();
    this._turnCount += 1;

    // v2 log: turn_start + user_message
    this._appendEntry(
      createTurnStart(this._nextLogId("turn_start"), this._turnCount),
      false,
    );
    const displayText = typeof userContent === "string"
      ? userContent
      : "[multimodal input]";
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
    this.onSaveRequest?.();

    // Track streamed content for abort recovery
    const textAccumulator = { text: "" };
    const reasoningAccumulator = { text: "" };
    return this._runTurnActivationLoop(signal, textAccumulator, reasoningAccumulator);
  }

  /**
   * Handle interruption using structured log (v2).
   *
   * Rules:
   * - Keep completed reasoning, drop incomplete reasoning of the currently interrupted round
   * - Keep partial text and append " [Interrupted here.]" when interruption happens mid-activation
   * - For each complete tool_call lacking result, append interrupted tool_result
   * - Append synthetic interruption user message (with optional snapshot)
   */
  private _handleInterruption(
    logLenBefore: number,
    accumulatedText: string,
    opts?: { activationCompleted?: boolean },
  ): void {
    const activationCompleted = opts?.activationCompleted ?? false;
    const interruptedSuffix = " [Interrupted here.]";
    const interruptedMarker = "[Interrupted here.]";

    // Clear ask runtime state for interrupted turn.
    this._activeAsk = null;
    this._pendingTurnState = null;

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
        if (e.type === "tool_call") latestRoundHasToolCall = true;
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

    // Mid-activation interruption keeps partial text and marks it explicitly.
    if (!activationCompleted) {
      if (latestAssistantEntry) {
        const currentDisplay = String(latestAssistantEntry.display ?? "");
        const currentContent = String(latestAssistantEntry.content ?? "");
        if (!currentDisplay.trimEnd().endsWith(interruptedSuffix)) {
          latestAssistantEntry.display = `${currentDisplay.trimEnd()}${interruptedSuffix}`;
        }
        if (!currentContent.trimEnd().endsWith(interruptedSuffix)) {
          latestAssistantEntry.content = `${currentContent.trimEnd()}${interruptedSuffix}`;
        }
      } else {
        const partialText = stripContextTags(accumulatedText).trim();
        if (partialText) {
          const partialContextId = this._findPrecedingUserSideContextId() ?? this._allocateContextId();
          this._appendEntry(createAssistantText(
            this._nextLogId("assistant_text"),
            this._turnCount,
            this._computeNextRoundIndex(),
            `${partialText}${interruptedSuffix}`,
            `${partialText}${interruptedSuffix}`,
            partialContextId,
          ), false);
          hasAssistantInActivation = true;
        }
      }
    }

    // Complete all materialized tool calls that have no results yet.
    this._completeMissingToolResultsFromLog(logLenBefore, interruptedMarker);

    // If protocol-side currently ends at user-side, add a synthetic assistant marker.
    const lastRole = this._getLastSendableRole();
    if (this._isUserSideProtocolRole(lastRole) && !hasAssistantInActivation) {
      const ctxId = this._findPrecedingUserSideContextId() ?? this._allocateContextId();
      this._appendEntry(createAssistantText(
        this._nextLogId("assistant_text"),
        this._turnCount,
        this._computeNextRoundIndex(),
        interruptedMarker,
        interruptedMarker,
        ctxId,
      ), false);
    }

    const snapshot =
      this._interruptSnapshot && this._interruptSnapshot.turnIndex === this._turnCount
        ? this._interruptSnapshot
        : null;
    this._interruptSnapshot = null;

    const lines: string[] = ["Last turn was interrupted by the user."];
    if (snapshot && (snapshot.hadActiveAgents || snapshot.hadActiveShells || snapshot.hadUnconsumed)) {
      const killedKinds: string[] = [];
      if (snapshot.hadActiveAgents) killedKinds.push("sub-agents");
      if (snapshot.hadActiveShells) killedKinds.push("shells");
      if (killedKinds.length > 0) {
        lines.push(`Active ${killedKinds.join(" and ")} were killed.`);
      }
      if (snapshot.hadUnconsumed) {
        lines.push("Unconsumed queued information was discarded.");
      }
      if (snapshot.deliveryContent.trim()) {
        lines.push("");
        lines.push("[Snapshot]");
        lines.push(snapshot.deliveryContent);
      }
    }
    const interruptionMessage = lines.join("\n");
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
   * Scan log entries from `fromIdx` onwards: for each tool_call entry,
   * check if a tool_result exists for it. Create missing tool_results.
   */
  private _completeMissingToolResultsFromLog(fromIdx: number, interruptedContent: string): void {
    const pendingToolCalls: Array<{ id: string; name: string; roundIndex?: number; contextId?: string }> = [];
    const resolvedToolCallIds = new Set<string>();

    for (let i = fromIdx; i < this._log.length; i++) {
      const e = this._log[i];
      if (e.type === "tool_call") {
        const meta = e.meta as Record<string, unknown>;
        pendingToolCalls.push({
          id: (meta["toolCallId"] as string) ?? "",
          name: (meta["toolName"] as string) ?? "",
          roundIndex: e.roundIndex,
          contextId: typeof meta["contextId"] === "string" ? meta["contextId"] as string : undefined,
        });
      } else if (e.type === "tool_result") {
        resolvedToolCallIds.add((e.meta as Record<string, unknown>)["toolCallId"] as string);
      }
    }

    for (const tc of pendingToolCalls) {
      if (resolvedToolCallIds.has(tc.id)) continue;
      if (!tc.id) continue;
      this._appendEntry(createToolResultEntry(
        this._nextLogId("tool_result"),
        this._turnCount,
        tc.roundIndex ?? this._computeNextRoundIndex(),
        {
          toolCallId: tc.id,
          toolName: tc.name,
          content: interruptedContent,
          toolSummary: interruptedContent,
        },
        { isError: false, contextId: tc.contextId },
      ), false);
    }
  }

  private _getLastSendableRole(): string | null {
    let importantLog = "";
    try {
      importantLog = this._readImportantLog();
    } catch {
      importantLog = "";
    }
    const agentsMd = this._readAgentsMd();
    const messages = projectToApiMessages(this._log, {
      resolveImageRef: (refPath) => this._resolveImageRef(refPath),
      importantLog,
      agentsMd,
      requiresAlternatingRoles: (this.primaryAgent as any)._provider.requiresAlternatingRoles,
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

      onTextChunk = (roundIndex: number, chunk: string) => {
        let roundBuffer = textBuffers.get(roundIndex);
        if (!roundBuffer) {
          const stripBuf = new ContextTagStripBuffer((cleanChunk: string) => {
            if (textAccumulator) textAccumulator.text += cleanChunk;
            if (progress) progress.onTextChunk(agentName, cleanChunk);

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
            } else {
              entry.display += cleanChunk;
              entry.content = String(entry.content ?? "") + cleanChunk;
              this._touchLog();
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
        } else {
          entry.display += chunk;
          entry.content = String(entry.content ?? "") + chunk;
          this._touchLog();
        }
        return true;
      };
    }

    let onToolCall: ((name: string, tool: string, args: Record<string, unknown>, summary: string) => void) | undefined;
    if (this._progress) {
      const step = this._turnCount;
      const progress = this._progress;

      onToolCall = (name: string, tool: string, args: Record<string, unknown>, summary: string) => {
        progress.onToolCall(step, name, tool, args, summary);
      };
    }

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
      let importantLog = this._readImportantLog();
      // Inject active plan alongside important log
      if (this._activePlanCheckpoints.length > 0) {
        const lines = this._activePlanCheckpoints.map((text, i) =>
          `- [${this._activePlanChecked[i] ? "x" : " "}] ${text}`
        );
        importantLog += `\n\n---\n## Active Plan\n${lines.join("\n")}`;
      }
      const agentsMd = this._readAgentsMd();
      return projectToApiMessages(this._log, {
        resolveImageRef: (refPath) => this._resolveImageRef(refPath),
        importantLog,
        agentsMd,
        requiresAlternatingRoles: (this.primaryAgent as any)._provider.requiresAlternatingRoles,
        showContextAnnotations: showAnnotations ?? undefined,
      });
    };

    const appendEntry = (entry: LogEntry): void => {
      if (this._compactInProgress) {
        entry.tuiVisible = false;
        entry.displayKind = null;
        (entry.meta as Record<string, unknown>)["compactPhase"] = true;
      }
      this._appendEntry(entry, false);
    };

    const allocId = (type: LogEntry["type"]): string => {
      return this._nextLogId(type);
    };

    return this.primaryAgent.asyncRunWithMessages(
      getMessages,
      appendEntry,
      allocId,
      this._turnCount,
      baseRoundIndex,
      this._toolExecutors,
      onToolCall,
      onTextChunk,
      onReasoningChunk,
      signal,
      (roundIndex) => getRoundContextId(roundIndex),
      this._buildCompactCheck(),
      onTokenUpdate,
      this._thinkingLevel === "default" ? undefined : this._thinkingLevel,
      this._cacheHitEnabled,
      this._compactInProgress ? undefined : (() => this.onSaveRequest?.()),
      this._beforeToolExecute,
      () => this._buildNotificationContent(),
      !suppressStreaming,
      emitRetryAttempt,
      emitRetrySuccess,
      emitRetryExhausted,
    );
  }

  // ==================================================================
  // Tool argument helpers
  // ==================================================================

  private _toolArgError(toolName: string, message: string): ToolResult {
    return new ToolResult({ content: `Error: invalid arguments for ${toolName}: ${message}` });
  }

  private _argOptionalString(
    toolName: string,
    args: Record<string, unknown>,
    key: string,
  ): string | undefined | ToolResult {
    const value = args[key];
    if (value == null) return undefined;
    if (typeof value !== "string") {
      return this._toolArgError(toolName, `'${key}' must be a string.`);
    }
    return value;
  }

  private _argRequiredString(
    toolName: string,
    args: Record<string, unknown>,
    key: string,
    opts?: { nonEmpty?: boolean },
  ): string | ToolResult {
    const value = args[key];
    if (typeof value !== "string") {
      return this._toolArgError(toolName, `'${key}' must be a string.`);
    }
    if (opts?.nonEmpty && !value.trim()) {
      return this._toolArgError(toolName, `'${key}' must be a non-empty string.`);
    }
    return value;
  }

  private _argRequiredStringArray(
    toolName: string,
    args: Record<string, unknown>,
    key: string,
  ): string[] | ToolResult {
    const value = args[key];
    if (!Array.isArray(value)) {
      return this._toolArgError(toolName, `'${key}' must be an array of strings.`);
    }
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== "string") {
        return this._toolArgError(toolName, `'${key}[${i}]' must be a string.`);
      }
    }
    return value as string[];
  }

  private _argOptionalInteger(
    toolName: string,
    args: Record<string, unknown>,
    key: string,
  ): number | undefined | ToolResult {
    const value = args[key];
    if (value == null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
      return this._toolArgError(toolName, `'${key}' must be an integer.`);
    }
    return value;
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
    const ask = this._activeAsk;
    if (!ask) {
      throw new Error("No active ask to resolve.");
    }
    if (ask.id !== askId) {
      throw new Error(`Ask id mismatch (active=${ask.id}, got=${askId}).`);
    }
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

  private _execSummarizeContext(args: Record<string, unknown>): ToolResult {
    const fileMode = typeof args.file === "string";
    let effectiveArgs = args;

    if (fileMode) {
      const fileRel = (args.file as string).trim();
      if (!fileRel) {
        return new ToolResult({ content: "Error: 'file' parameter must be a non-empty string." });
      }
      const artifactsDir = this._resolveSessionArtifacts();
      let filePath: string;
      try {
        filePath = safePath({
          baseDir: artifactsDir,
          requestedPath: fileRel,
          cwd: artifactsDir,
          mustExist: true,
          expectFile: true,
          accessKind: "read",
        }).safePath!;
      } catch (e) {
        if (e instanceof SafePathError) {
          const candidatePath = (e as SafePathError).details?.resolvedPath || join(artifactsDir, fileRel);
          return new ToolResult({
            content:
              `Error: summary file not found or not accessible at ${candidatePath}\n` +
              `The 'file' parameter is resolved relative to SESSION_ARTIFACTS (${artifactsDir}).`,
          });
        }
        throw e;
      }
      let parsed: unknown;
      try {
        parsed = yaml.load(readFileSync(filePath, "utf-8"));
      } catch (e) {
        return new ToolResult({ content: `Error: failed to parse summary file: ${e}` });
      }
      if (!parsed || typeof parsed !== "object") {
        return new ToolResult({ content: "Error: summary file must be a YAML mapping." });
      }
      const operations = (parsed as Record<string, unknown>)["operations"];
      if (!Array.isArray(operations)) {
        return new ToolResult({ content: "Error: summary file must contain an 'operations' array." });
      }
      effectiveArgs = { operations };
    }

    const result = execSummarizeContextOnLog(
      effectiveArgs,
      this._log,
      () => this._allocateContextId(),
      () => this._nextLogId("summary"),
      this._turnCount,
    );

    if (result.results.some((r) => r.success)) {
      // Don't reset hint state here — wait for next API call's actual inputTokens
      // to determine the real state (via _updateHintStateAfterApiCall)
    }

    this._annotateLatestSummarizeToolCall(result.results);

    // In file mode, compress intermediate decision-process entries
    if (fileMode && result.results.some((r) => r.success)) {
      this._compressFileModeSummarizeSteps(args.file as string);
    }

    this._touchLog();

    // Auto-dismiss show_context annotations after a successful summarize
    if (result.results.some((r) => r.success)) {
      this._showContextRoundsRemaining = 0;
      this._showContextAnnotations = null;
    }

    return new ToolResult({ content: result.output });
  }

  // ==================================================================
  // Plan tool
  // ==================================================================

  private _execPlan(args: Record<string, unknown>): ToolResult {
    const action = args["action"];
    if (typeof action !== "string" || !["submit", "check", "dismiss"].includes(action)) {
      return this._toolArgError("plan", "'action' must be one of: submit, check, dismiss.");
    }

    if (action === "submit") {
      const raw = args["checkpoints"];
      if (!Array.isArray(raw) || raw.length === 0) {
        return this._toolArgError(
          "plan",
          "'checkpoints' must be a non-empty array of strings.",
        );
      }
      const checkpoints = raw.map((c) => String(c).trim()).filter(Boolean);
      if (checkpoints.length === 0) {
        return this._toolArgError("plan", "'checkpoints' items must not be empty.");
      }

      this._activePlanCheckpoints = checkpoints;
      this._activePlanChecked = checkpoints.map(() => false);
      this._emitPlanProgress("plan_submit");

      return new ToolResult({
        content: `Plan submitted with ${checkpoints.length} checkpoints.`,
      });
    }

    if (action === "check") {
      if (this._activePlanCheckpoints.length === 0) {
        return new ToolResult({ content: "Error: no active plan. Use action='submit' first." });
      }
      const item = args["item"];
      if (typeof item !== "number" || !Number.isInteger(item)) {
        return this._toolArgError("plan", "'item' must be an integer index (1-based).");
      }

      // Convert 1-based user index to 0-based internal index
      const idx = item - 1;

      if (idx < 0 || idx >= this._activePlanCheckpoints.length) {
        return new ToolResult({
          content: `Error: 'item' ${item} is out of range (1..${this._activePlanCheckpoints.length}).`,
        });
      }

      const checkpointText = this._activePlanCheckpoints[idx];
      this._activePlanChecked[idx] = true;

      // Check if all checkpoints are now complete → auto-finish
      const allDone = this._activePlanChecked.every(Boolean);

      if (allDone) {
        // Clear state immediately (so persistence sees no plan on interrupt)
        // but delay TUI panel dismissal so the user sees the all-checked state
        this._emitPlanProgress("plan_update");
        this._activePlanCheckpoints = [];
        this._activePlanChecked = [];
        setTimeout(() => {
          this._emitPlanProgress("plan_finish");
        }, 5000);

        return new ToolResult({
          content:
            `✓ Checkpoint ${item} done: ${checkpointText}\n` +
            `All checkpoints complete. Plan closed.`,
        });
      }

      this._emitPlanProgress("plan_update");

      return new ToolResult({
        content: `✓ Checkpoint ${item} done: ${checkpointText}`,
      });
    }

    // action === "dismiss"
    this._activePlanCheckpoints = [];
    this._activePlanChecked = [];
    this._emitPlanProgress("plan_finish");
    return new ToolResult({ content: "Plan dismissed." });
  }

  private _emitPlanProgress(action: "plan_submit" | "plan_update" | "plan_finish"): void {
    if (!this._progress) return;
    const checkpoints = this._activePlanCheckpoints.map((text, i) => ({
      text,
      checked: this._activePlanChecked[i] ?? false,
    }));
    this._progress.emit({
      step: this._turnCount,
      agent: this.primaryAgent.name,
      action,
      message: "",
      level: "normal" as ProgressLevel,
      timestamp: Date.now() / 1000,
      usage: {},
      extra: { checkpoints },
    });
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
      if ((entry.meta as Record<string, unknown>)["toolName"] !== "summarize_context") continue;
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

  /**
   * Compress intermediate tool calls (read_file, write_file, edit_file) between the
   * last show_context and the current summarize_context when file mode was used.
   * These entries represent the "decision process" of building the summary file.
   */
  private _compressFileModeSummarizeSteps(filePath: string): void {
    // Resolve the full file path for matching against tool call arguments
    const artifactsDir = this._resolveSessionArtifacts();
    const resolvedFilePath = resolve(artifactsDir, filePath.trim());

    // Find the current summarize_context tool_call (most recent unresolved one)
    let summarizeIdx = -1;
    const resolvedToolCallIds = new Set<string>();
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
      if ((entry.meta as Record<string, unknown>)["toolName"] !== "summarize_context") continue;
      summarizeIdx = i;
      break;
    }
    if (summarizeIdx < 0) return;

    // Find the most recent show_context tool_call before the summarize_context
    let showContextIdx = -1;
    for (let i = summarizeIdx - 1; i >= 0; i--) {
      const entry = this._log[i];
      if (entry.discarded || entry.summarized) continue;
      if (entry.type !== "tool_call") continue;
      if ((entry.meta as Record<string, unknown>)["toolName"] === "show_context") {
        showContextIdx = i;
        break;
      }
    }
    if (showContextIdx < 0) return;

    // Collect all entries between show_context and summarize_context (exclusive on both ends)
    const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);
    const candidateIndices: number[] = [];
    let allQualify = true;

    for (let i = showContextIdx + 1; i < summarizeIdx; i++) {
      const entry = this._log[i];
      if (entry.discarded || entry.summarized) continue;

      if (entry.type === "tool_call") {
        const toolName = (entry.meta as Record<string, unknown>)["toolName"];
        if (!FILE_TOOLS.has(String(toolName))) {
          allQualify = false;
          break;
        }
        // Check that the tool operates on the summary file
        const content = entry.content as Record<string, unknown>;
        const toolArgs = (content["arguments"] as Record<string, unknown>) ?? {};
        const toolPath = String(toolArgs["path"] ?? "");
        const resolvedToolPath = resolve(artifactsDir, toolPath);
        if (resolvedToolPath !== resolvedFilePath) {
          allQualify = false;
          break;
        }
        candidateIndices.push(i);
      } else if (entry.type === "tool_result" || entry.type === "assistant_text" || entry.type === "reasoning") {
        candidateIndices.push(i);
      } else {
        // Other entry types (e.g. user_message) — don't compress
        allQualify = false;
        break;
      }
    }

    if (!allQualify || candidateIndices.length === 0) return;

    // Mark all intermediate entries as summarized
    const summarizedEntryIds: string[] = [];
    for (const idx of candidateIndices) {
      this._log[idx].summarized = true;
      summarizedEntryIds.push(this._log[idx].id);
    }

    // Insert a synthetic summary entry right before the summarize_context tool_call
    const newCtxId = this._allocateContextId();
    const summaryContent =
      "[Summary (decision process)] summarize_context decision process between show_context and import — omitted.";
    const summaryEntry = createSummary(
      this._nextLogId("summary"),
      this._turnCount,
      summaryContent,
      summaryContent,
      newCtxId,
      summarizedEntryIds,
      1,
    );
    this._log.splice(summarizeIdx, 0, summaryEntry);
  }

  /**
   * After execSummarizeContext mutates the projected messages array,
   * mirror changes back to _log: mark entries as summarized and create summary LogEntries.
   */
  private _syncSummarizeToLog(messages: Array<Record<string, unknown>>): void {
    // 1. Build set of contextIds marked as summarized
    const summarizedCtxIds = new Set<string>();
    const summarizedByMap = new Map<string, string>();

    for (const msg of messages) {
      if (msg["_is_summarized"] !== true) continue;
      const ctxId = msg["_context_id"];
      if (ctxId === undefined || ctxId === null) continue;
      summarizedCtxIds.add(String(ctxId));
      const by = msg["_summarized_by"];
      if (by !== undefined && by !== null) {
        summarizedByMap.set(String(ctxId), String(by));
      }
    }

    // 2. Mark corresponding _log entries
    for (const entry of this._log) {
      if (entry.summarized) continue;
      const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
      if (ctxId && summarizedCtxIds.has(String(ctxId))) {
        entry.summarized = true;
        const by = summarizedByMap.get(String(ctxId));
        if (by) entry.summarizedBy = by;
      }
    }

    // 3. Find new summary messages and create LogEntries
    const existingSummaryCtxIds = new Set<string>();
    for (const entry of this._log) {
      if (entry.type === "summary") {
        const ctxId = (entry.meta as Record<string, unknown>)["contextId"];
        if (ctxId) existingSummaryCtxIds.add(String(ctxId));
      }
    }

    for (const msg of messages) {
      if (msg["_is_summary"] !== true) continue;
      const ctxId = msg["_context_id"];
      if (!ctxId || existingSummaryCtxIds.has(String(ctxId))) continue;

      const summarizedIds = (msg["_summarized_ids"] as Array<number | string>) ?? [];
      const depth = (msg["_summary_depth"] as number) ?? 1;
      const content = typeof msg["content"] === "string" ? msg["content"] : "";

      // Find splice position: before the first log entry summarized by this summary
      let spliceIdx = this._log.length;
      for (let i = 0; i < this._log.length; i++) {
        if (this._log[i].summarizedBy === String(ctxId)) {
          spliceIdx = i;
          break;
        }
      }

      const summaryEntry = createSummary(
        this._nextLogId("summary"),
        this._turnCount,
        content,
        content,
        String(ctxId),
        summarizedIds.map(String),
        depth,
      );

      this._log.splice(spliceIdx, 0, summaryEntry);
      existingSummaryCtxIds.add(String(ctxId));
    }

    this._notifyLogListeners();
  }

  // ==================================================================
  // Important log
  // ==================================================================

  private _readImportantLog(): string {
    const path = this._getImportantLogPath();
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8").trim();
      return content || "(empty file)";
    }
    return "(empty file)";
  }

  private _getImportantLogPath(): string {
    return join(this._getArtifactsDir(), "important-log.md");
  }

  // ==================================================================
  // AGENTS.md persistent memory
  // ==================================================================

  /**
   * Read AGENTS.md from user home (~/) and project root, concatenating both.
   * Global file comes first, project file second.
   */
  private _readAgentsMd(): string {
    const parts: string[] = [];

    // 1. Global: ~/.longeragent/AGENTS.md
    const globalPath = join(getLongerAgentHomeDir(), "AGENTS.md");
    if (existsSync(globalPath)) {
      try {
        const content = readFileSync(globalPath, "utf-8").trim();
        parts.push(
          content
            ? `## Global Memory\n\n${content}`
            : `## Global Memory\n\n(empty file)`,
        );
      } catch {
        // Ignore read errors
      }
    }

    // 2. Project: {PROJECT_ROOT}/AGENTS.md
    const projectPath = join(this._projectRoot, "AGENTS.md");
    if (existsSync(projectPath)) {
      try {
        const content = readFileSync(projectPath, "utf-8").trim();
        parts.push(
          content
            ? `## Project Memory\n\n${content}`
            : `## Project Memory\n\n(empty file)`,
        );
      } catch {
        // Ignore read errors
      }
    }

    return parts.join("\n\n---\n\n");
  }

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
    let importantLog = "(empty file)";
    try {
      importantLog = this._readImportantLog();
    } catch {
      importantLog = "(empty file)";
    }

    if (this._activePlanCheckpoints.length > 0) {
      const lines = this._activePlanCheckpoints.map((text, i) =>
        `- [${this._activePlanChecked[i] ? "x" : " "}] ${text}`
      );
      importantLog += `\n\n---\n## Active Plan\n${lines.join("\n")}`;
    }

    const agentsMd = this._readAgentsMd();
    const messages = projectToApiMessages(this._log, {
      resolveImageRef: (refPath) => this._resolveImageRef(refPath),
      importantLog,
      agentsMd,
      requiresAlternatingRoles: (this.primaryAgent as any)._provider.requiresAlternatingRoles,
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
        "Possible causes: (1) ~/.longeragent/ is not writable, (2) disk is full, " +
        "(3) permission issues creating the artifacts directory.",
      );
    }
    this._refreshSystemPromptPaths();

    // Auto-create important-log.md if it doesn't exist (starts empty)
    const logPath = this._getImportantLogPath();
    if (!existsSync(logPath)) writeFileSync(logPath, "");
  }

  private _getArtifactsDir(): string {
    if (this._sessionArtifactsOverride) return this._sessionArtifactsOverride;
    const d = this._getArtifactsDirIfAvailable();
    if (d) return d;
    throw new Error(
      "Session artifacts directory is unavailable. " +
      "This usually means no active session directory exists yet, or session " +
      "persistence failed to initialize. " +
      "Possible causes: (1) ~/.longeragent/ is not writable, (2) disk is full, " +
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
   * Update the system message in the conversation with re-rendered paths.
   * Called by setStore() to fix paths after the store is linked.
   */
  private _refreshSystemPromptPaths(): void {
    const rendered = this._renderSystemPrompt(this.primaryAgent.systemPrompt);
    // Update the system_prompt entry in _log
    for (const e of this._log) {
      if (e.type === "system_prompt" && !e.discarded) {
        e.content = rendered;
        break;
      }
    }
    this._updateInitialTokenEstimate();
  }

  // ==================================================================
  // Auto-compact
  // ==================================================================

  private _buildCompactCheck(): ((
    inputTokens: number, outputTokens: number, hasToolCalls: boolean,
  ) => { compactNeeded: boolean; scenario?: "output" | "toolcall" } | null) | undefined {
    if (this._compactInProgress) return undefined;

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
    const contContent = `${continuationPrompt}\n\n[Contexts before this point have been compacted.]`;
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

    const level2Ratio = this._thresholds.summarize_hint_level2 / 100;
    const level1Ratio = this._thresholds.summarize_hint_level1 / 100;

    if (ratio >= level2Ratio && this._hintState !== "level2_sent") {
      this._deliverMessage({ from: "system", to: "primary", content: HINT_LEVEL2_PROMPT(pct), timestamp: Date.now() });
      this._hintState = "level2_sent";
    } else if (ratio >= level1Ratio && this._hintState === "none") {
      this._deliverMessage({ from: "system", to: "primary", content: HINT_LEVEL1_PROMPT(pct), timestamp: Date.now() });
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
  // Background shell tools
  // ==================================================================

  private _resolveShellCwd(toolName: string, requested?: string): string | ToolResult {
    const trimmed = (requested ?? "").trim();
    if (!trimmed) {
      return this._projectRoot;
    }

    try {
      return safePath({
        baseDir: this._projectRoot,
        requestedPath: trimmed,
        cwd: this._projectRoot,
        mustExist: true,
        expectDirectory: true,
        accessKind: "list",
      }).safePath!;
    } catch (err) {
      if (!(err instanceof SafePathError)) throw err;
      try {
        return safePath({
          baseDir: this._resolveSessionArtifacts(),
          requestedPath: trimmed,
          cwd: this._resolveSessionArtifacts(),
          mustExist: true,
          expectDirectory: true,
          accessKind: "list",
        }).safePath!;
      } catch (inner) {
        if (inner instanceof SafePathError) {
          return new ToolResult({
            content: `Error: invalid arguments for ${toolName}: cwd must stay within the project root or SESSION_ARTIFACTS.`,
          });
        }
        throw inner;
      }
    }
  }

  private _execBashBackground(args: Record<string, unknown>): ToolResult {
    const commandArg = this._argRequiredString("bash_background", args, "command", { nonEmpty: true });
    if (commandArg instanceof ToolResult) return commandArg;
    const cwdArg = this._argOptionalString("bash_background", args, "cwd");
    if (cwdArg instanceof ToolResult) return cwdArg;
    const idArg = this._argOptionalString("bash_background", args, "id");
    if (idArg instanceof ToolResult) return idArg;

    const shellId = idArg
      ? this._normalizeShellId(idArg)
      : `shell-${++this._shellCounter}`;
    if (!shellId) {
      return this._toolArgError("bash_background", "'id' must contain only letters, numbers, '.', '_' or '-'.");
    }
    if (this._activeShells.has(shellId)) {
      return new ToolResult({ content: `Error: shell '${shellId}' is already tracked.` });
    }

    const cwd = this._resolveShellCwd("bash_background", cwdArg);
    if (cwd instanceof ToolResult) return cwd;

    const logPath = join(this._getShellsDir(), `${shellId}.log`);
    writeFileSync(logPath, "", "utf-8");

    let child: ChildProcess;
    try {
      child = spawn("sh", ["-lc", commandArg], {
        cwd,
        env: buildBashEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return new ToolResult({ content: `Error: failed to start background shell: ${e}` });
    }

    const entry: BackgroundShellEntry = {
      id: shellId,
      process: child,
      command: commandArg,
      cwd,
      logPath,
      startTime: performance.now(),
      status: "running",
      exitCode: null,
      signal: null,
      readOffset: 0,
      recentOutput: [],
      explicitKill: false,
    };
    this._activeShells.set(shellId, entry);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      this._recordShellChunk(entry, text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      this._recordShellChunk(entry, text);
    });
    child.on("error", (error) => {
      entry.status = "failed";
      entry.exitCode = 1;
      entry.signal = null;
      this._deliverMessage({
        from: "system", to: "primary", timestamp: Date.now(),
        content: `Background shell '${shellId}' failed to start: ${error}. Use \`bash_output(id="${shellId}")\` to inspect ${logPath}.`,
      });
    });
    child.on("close", (code, signal) => {
      entry.exitCode = code;
      entry.signal = signal;
      if (entry.explicitKill) {
        entry.status = "killed";
      } else if (code === 0) {
        entry.status = "exited";
      } else {
        entry.status = "failed";
      }
      const statusText = entry.status === "killed"
        ? `was killed (${signal ?? "TERM"})`
        : entry.status === "exited"
          ? "completed successfully"
          : `failed (exit ${code ?? 1})`;
      this._deliverMessage({
        from: "system", to: "primary", timestamp: Date.now(),
        content: `Background shell '${shellId}' ${statusText}. Use \`bash_output(id="${shellId}")\` to inspect logs at ${logPath}.`,
      });
    });

    return new ToolResult({
      content:
        `Started background shell '${shellId}'.\n` +
        `cwd: ${cwd}\n` +
        `log: ${logPath}\n` +
        `Use \`bash_output(id="${shellId}")\` to inspect logs and \`wait(shell="${shellId}", seconds=60)\` to wait for exit.`,
    });
  }

  private _execBashOutput(args: Record<string, unknown>): ToolResult {
    const idArg = this._argRequiredString("bash_output", args, "id", { nonEmpty: true });
    if (idArg instanceof ToolResult) return idArg;
    const tailLinesArg = this._argOptionalInteger("bash_output", args, "tail_lines");
    if (tailLinesArg instanceof ToolResult) return tailLinesArg;
    const maxCharsArg = this._argOptionalInteger("bash_output", args, "max_chars");
    if (maxCharsArg instanceof ToolResult) return maxCharsArg;

    const entry = this._activeShells.get(idArg);
    if (!entry) {
      return new ToolResult({ content: `Error: shell '${idArg}' not found.` });
    }

    const maxChars = Math.max(500, Math.min(50_000, maxCharsArg ?? 8_000));
    const fullText = existsSync(entry.logPath) ? readFileSync(entry.logPath, "utf-8") : "";
    let body = "";

    if (tailLinesArg !== undefined) {
      const lines = fullText.split("\n");
      body = lines.slice(-Math.max(1, tailLinesArg)).join("\n").trimEnd();
    } else {
      const fullBuffer = Buffer.from(fullText, "utf-8");
      const unread = fullBuffer.subarray(entry.readOffset).toString("utf-8");
      entry.readOffset = fullBuffer.length;
      if (!unread.trim()) {
        body = "(No new output since the last read.)";
      } else if (unread.length > maxChars) {
        const visible = unread.slice(0, maxChars);
        const omittedChars = unread.length - visible.length;
        const omittedLines = unread.slice(visible.length).split("\n").filter(Boolean).length;
        body =
          `${visible.trimEnd()}\n\n` +
          `[Truncated here because unread output exceeded ${maxChars} chars; skipped ${omittedChars.toLocaleString()} chars` +
          (omittedLines > 0 ? ` / ${omittedLines.toLocaleString()} lines` : "") +
          `. Full log: ${entry.logPath}]`;
      } else {
        body = unread.trimEnd();
      }
    }

    return new ToolResult({
      content:
        `# Shell Output\n` +
        `id: ${entry.id}\n` +
        `status: ${entry.status}\n` +
        `log: ${entry.logPath}\n\n` +
        `${body || "(No output yet.)"}`,
    });
  }

  private _execKillShell(args: Record<string, unknown>): ToolResult {
    const idsArg = this._argRequiredStringArray("kill_shell", args, "ids");
    if (idsArg instanceof ToolResult) return idsArg;
    const signalArg = this._argOptionalString("kill_shell", args, "signal");
    if (signalArg instanceof ToolResult) return signalArg;
    const rawSignal = (signalArg?.trim() || "SIGTERM").toUpperCase();
    const signal = (rawSignal.startsWith("SIG") ? rawSignal : `SIG${rawSignal}`) as NodeJS.Signals;

    const parts: string[] = [];
    for (const id of idsArg) {
      const entry = this._activeShells.get(id);
      if (!entry) {
        parts.push(`'${id}': not found.`);
        continue;
      }
      if (entry.status !== "running") {
        parts.push(`'${id}': already ${entry.status}.`);
        continue;
      }
      entry.explicitKill = true;
      try {
        entry.process.kill(signal);
        parts.push(`'${id}': sent ${signal}.`);
      } catch (e) {
        parts.push(`'${id}': failed to send ${signal} (${e}).`);
      }
    }
    return new ToolResult({ content: parts.join(" ") || "No shells specified." });
  }

  // ==================================================================
  // Sub-agent spawn / cancel / lifecycle
  // ==================================================================

  private async _execSpawnAgents(args: Record<string, unknown>): Promise<ToolResult> {
    const fileArg = this._argRequiredString("spawn_agent", args, "file", { nonEmpty: true });
    if (fileArg instanceof ToolResult) return fileArg;
    const fileRel = fileArg.trim();
    if (!fileRel) {
      return new ToolResult({ content: "Error: 'file' parameter is required." });
    }

    const artifactsDir = this._resolveSessionArtifacts();
    let filePath: string;
    try {
      filePath = safePath({
        baseDir: artifactsDir,
        requestedPath: fileRel,
        cwd: artifactsDir,
        mustExist: true,
        expectFile: true,
        accessKind: "spawn_call_file",
      }).safePath!;
    } catch (e) {
      if (e instanceof SafePathError) {
        if (e.code === "PATH_OUTSIDE_SCOPE") {
          return new ToolResult({
            content:
              "Error: call file path must be within SESSION_ARTIFACTS.\n" +
              `The 'file' parameter is resolved relative to SESSION_ARTIFACTS (${artifactsDir}).`,
          });
        }
        if (e.code === "PATH_SYMLINK_ESCAPES_SCOPE") {
          return new ToolResult({
            content:
              "Error: call file path escapes SESSION_ARTIFACTS via a symbolic link.\n" +
              `The 'file' parameter is resolved relative to SESSION_ARTIFACTS (${artifactsDir}).`,
          });
        }
        if (e.code === "PATH_NOT_FOUND" || e.code === "PATH_NOT_FILE") {
          const candidatePath = e.details.resolvedPath || join(artifactsDir, fileRel);
          return new ToolResult({
            content:
              `Error: call file not found at ${candidatePath}\n` +
              `The 'file' parameter is resolved relative to SESSION_ARTIFACTS (${artifactsDir}).\n` +
              `Make sure you wrote the call file to this directory using write_file(path="${join(artifactsDir, fileRel)}").`,
          });
        }
        return new ToolResult({ content: `Error: invalid call file path: ${e.message}` });
      }
      throw e;
    }

    let callFile: Record<string, unknown>;
    try {
      callFile = yaml.load(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      return new ToolResult({ content: `Error: failed to parse call file: ${e}` });
    }

    if (!callFile || typeof callFile !== "object") {
      return new ToolResult({ content: "Error: call file must be a YAML mapping." });
    }

    // Warn about deprecated inline templates section
    if (callFile["templates"]) {
      console.warn(
        "spawn_agent: 'templates:' section in call files is deprecated. " +
        "Use 'template:' (pre-defined) or 'template_path:' (custom) per task instead.",
      );
    }

    // Team support: `team:` field makes all agents interactive
    const teamName = ((callFile["team"] as string) ?? "").trim() || null;

    const tasksSpec = (callFile["agents"] ?? callFile["tasks"]) as Array<Record<string, unknown>> ?? [];
    if (!tasksSpec.length) {
      return new ToolResult({ content: "Error: call file has no 'tasks' (or 'agents') section." });
    }

    const spawned: string[] = [];
    const spawnedInfo: Array<{ numericId: number; taskId: string; template: string; task: string }> = [];
    const errors: string[] = [];

    // Create or look up team
    if (teamName && !this._teams.has(teamName)) {
      this._teams.set(teamName, { id: teamName, members: new Set() });
    }

    for (const spec of tasksSpec) {
      const taskId = ((spec["id"] as string) ?? "").trim();
      const templateName = ((spec["template"] as string) ?? "").trim();
      const templatePath = ((spec["template_path"] as string) ?? "").trim();
      const taskDesc = ((spec["task"] as string) ?? "").trim();
      const includeLog = spec["include_important_log"] !== false;
      const isInteractive = teamName ? true : (spec["interactive"] === true);

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
      if (this._activeAgents.has(taskId)) {
        errors.push(`'${taskId}': already running.`);
        continue;
      }

      let agent: Agent;
      let templateLabel: string;
      try {
        if (templateName) {
          agent = this._createSubAgentFromPredefined(templateName, taskId);
          templateLabel = templateName;
        } else {
          const resolvedPath = this._resolveTemplatePath(templatePath);
          agent = this._createSubAgentFromPath(resolvedPath, taskId);
          templateLabel = templatePath;
        }
      } catch (e) {
        errors.push(`'${taskId}': ${e}`);
        continue;
      }

      // Inject SEND_TOOL ToolDef for team agents so the LLM can see it.
      // Team agents get send tool for cross-agent communication.
      // Non-team interactive agents don't get send — their turn output
      // auto-delivers to primary, and they don't need cross-agent communication.
      if (teamName && !agent.tools.some((t) => t.name === "send")) {
        agent.tools.push(SEND_TOOL);
      }

      // Give primary agent the send tool when interactive agents exist
      // (so primary can send follow-up messages to interactive agents)
      if (isInteractive && !this.primaryAgent.tools.some((t) => t.name === "send")) {
        this.primaryAgent.tools.push(SEND_TOOL);
      }

      const extraMessages = this._buildSubAgentContext(includeLog);
      this._subAgentCounter += 1;
      const numericId = this._subAgentCounter;

      // Persistent agent storage
      const persistDir = join(this._resolveSessionArtifacts(), "agents", taskId);
      mkdirSync(persistDir, { recursive: true });

      // Team membership: add send tool for team members, inject team roster
      if (teamName) {
        const team = this._teams.get(teamName)!;
        // Broadcast new member to existing team members
        for (const memberId of team.members) {
          const memberEntry = this._activeAgents.get(memberId);
          if (memberEntry) {
            const broadcastMsg: AgentMessage = {
              from: "system", to: memberId, timestamp: Date.now(),
              content: `[Team Update] New member joined: ${taskId} (${templateLabel}) — "${taskDesc.slice(0, 120)}"`,
            };
            if (memberEntry.agentState === "idle") {
              // Don't auto-activate for broadcasts — just queue
              memberEntry.inbox.push(broadcastMsg);
            } else {
              memberEntry.inbox.push(broadcastMsg);
            }
          }
        }
        team.members.add(taskId);
      }

      const agentLog: LogEntry[] = [];
      const agentIdAllocator = new LogIdAllocator();
      const abortController = new AbortController();
      const promise = this._runSubAgent(
        taskId, agent, taskDesc, numericId, extraMessages, abortController.signal,
        agentLog, agentIdAllocator, isInteractive, teamName,
      );

      this._activeAgents.set(taskId, {
        promise,
        abortController,
        numericId,
        template: templateLabel,
        startTime: performance.now(),
        status: "working",
        resultText: "",
        elapsed: 0,
        delivered: false,
        phase: "idle",
        recentActivity: [],
        toolCallCount: 0,
        // Persistent fields
        interactive: isInteractive,
        teamId: teamName,
        log: agentLog,
        idAllocator: agentIdAllocator,
        persistDir,
        agent,
        systemPrompt: agent.systemPrompt,
        task: taskDesc,
        inbox: [],
        agentState: "working",
        turnBudget: 20,
        turnBudgetRemaining: 20,
      });
      spawned.push(taskId);
      spawnedInfo.push({ numericId, taskId, template: templateLabel, task: taskDesc });

      if (this._progress) {
        this._progress.onAgentStart(
          this._turnCount, taskId, { sub_agent_id: numericId, template: templateLabel },
        );
      }

      // v2 log: sub_agent_start
      this._appendEntry(
        createSubAgentStart(
          this._nextLogId("sub_agent_start"),
          this._turnCount,
          `Sub-agent #${numericId} (${taskId}) started`,
          numericId,
          taskId,
          taskDesc,
        ),
        false,
      );
    }

    const parts: string[] = [];
    if (spawned.length) {
      parts.push(
        `Spawned ${spawned.length} sub-agent(s): ${spawned.join(", ")}. ` +
        "Results will be delivered as each agent completes.",
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
    let ids = idsArg;

    // Support team: if first id matches a team name, expand to all members
    const teamArg = ((args["team"] as string) ?? "").trim();
    if (teamArg) {
      const team = this._teams.get(teamArg);
      if (team) {
        ids = [...team.members];
      } else {
        return new ToolResult({ content: `Team '${teamArg}' not found.` });
      }
    }

    if (!ids.length) {
      return new ToolResult({ content: "No agent IDs specified." });
    }

    const killed: string[] = [];
    const notFound: string[] = [];

    for (const name of ids) {
      const entry = this._activeAgents.get(name);
      if (!entry) {
        notFound.push(name);
        continue;
      }
      this._persistAgentLog(entry);
      entry.abortController.abort();
      entry.status = "killed";
      this._activeAgents.delete(name);
      // Remove from team
      if (entry.teamId) {
        const team = this._teams.get(entry.teamId);
        if (team) {
          team.members.delete(name);
          if (team.members.size === 0) this._teams.delete(entry.teamId);
        }
      }
      killed.push(name);

      if (this._progress) {
        this._progress.emit({
          step: this._turnCount,
          agent: name,
          action: "agent_killed",
          message: `  [#${entry.numericId} ${name}] killed`,
          level: "normal" as ProgressLevel,
          timestamp: Date.now() / 1000,
          usage: {},
          extra: { sub_agent_id: entry.numericId },
        });
      }
    }

    const parts: string[] = [];
    if (killed.length) parts.push(`Killed: ${killed.join(", ")}.`);
    if (notFound.length) parts.push(`Not found (may have already completed): ${notFound.join(", ")}.`);
    return new ToolResult({ content: parts.join(" ") });
  }

  // ==================================================================
  // send tool — async message to interactive/team agent
  // ==================================================================

  private _execSend(args: Record<string, unknown>): ToolResult {
    const to = ((args["to"] as string) ?? "").trim();
    const content = ((args["content"] as string) ?? "").trim();
    if (!to || !content) {
      return new ToolResult({ content: "Error: 'to' and 'content' are required." });
    }

    const entry = this._activeAgents.get(to);
    if (!entry) {
      return new ToolResult({ content: `Agent '${to}' not found.` });
    }
    if (!entry.interactive) {
      return new ToolResult({ content: `Agent '${to}' is one-shot and cannot receive messages.` });
    }
    if (entry.status === "killed") {
      return new ToolResult({ content: `Agent '${to}' has been terminated.` });
    }

    // Reset turn budget on explicit primary send
    entry.turnBudgetRemaining = entry.turnBudget;

    this._deliverToAgent(to, { from: "primary", to, content, timestamp: Date.now() });
    return new ToolResult({ content: `Message sent to '${to}'.` });
  }

  /**
   * Deliver a message to an interactive agent's inbox.
   * If the agent is idle, auto-activates it.
   */
  private _deliverToAgent(agentName: string, msg: AgentMessage): void {
    const entry = this._activeAgents.get(agentName);
    if (!entry || !entry.interactive) return;

    if (entry.agentState === "idle" && entry.turnBudgetRemaining > 0) {
      // Inject message into agent log as user_message, then activate
      const ctxId = allocateContextId(new Set<string>());
      const formatted = `[Message from ${msg.from}]\n${msg.content}`;
      entry.log.push(createUserMessageEntry(
        entry.idAllocator.next("user_message"),
        0,
        formatted,
        formatted,
        ctxId,
      ));
      entry.turnBudgetRemaining--;
      this._activateInteractiveAgent(agentName, entry);
    } else {
      // Working or budget exhausted → queue in agent inbox (push model will inject)
      entry.inbox.push(msg);
    }
  }

  /**
   * Auto-activate an interactive agent for a new turn.
   */
  private _activateInteractiveAgent(agentName: string, entry: AgentEntry): void {
    entry.agentState = "working";
    entry.status = "working";
    entry.startTime = performance.now();
    entry.delivered = false;
    entry.resultText = "";
    entry.phase = "idle";
    entry.recentActivity = [];

    const abortController = new AbortController();
    entry.abortController = abortController;

    // Build sub-agent notification callback for its inbox push
    const getAgentNotification = (): string | null => {
      if (entry.inbox.length === 0) return null;
      const sections: string[] = [];
      const byFrom: Record<string, string[]> = {};
      for (const m of entry.inbox) {
        (byFrom[m.from] ??= []).push(m.content);
      }
      entry.inbox = [];
      for (const [from, msgs] of Object.entries(byFrom)) {
        sections.push(`[Message from ${from}]\n${msgs.join("\n\n")}`);
      }
      return `\n\n[Incoming Messages]\n${sections.join("\n\n---\n\n")}`;
    };

    // Build executors — same as one-shot but with send for team members
    const subExecutors: Record<string, ToolExecutor> = {};
    for (const toolName of [
      "$web_search", "read_file", "list_dir", "glob", "grep",
      "edit_file", "write_file", "diff", "web_fetch",
    ]) {
      if (this._toolExecutors[toolName]) {
        subExecutors[toolName] = this._toolExecutors[toolName];
      }
    }
    // Team members get send tool
    if (entry.teamId) {
      subExecutors["send"] = (args: Record<string, unknown>) => {
        const sendTo = ((args["to"] as string) ?? "").trim();
        const sendContent = ((args["content"] as string) ?? "").trim();
        if (!sendTo || !sendContent) {
          return new ToolResult({ content: "Error: 'to' and 'content' are required." });
        }
        if (sendTo === "primary") {
          return new ToolResult({ content: "Cannot send to primary — your turn output is automatically delivered. Use send only for teammates." });
        }
        const team = this._teams.get(entry.teamId!);
        if (!team || !team.members.has(sendTo)) {
          return new ToolResult({ content: `Agent '${sendTo}' is not in your team.` });
        }
        this._deliverToAgent(sendTo, { from: agentName, to: sendTo, content: sendContent, timestamp: Date.now() });
        return new ToolResult({ content: `Message sent to '${sendTo}'.` });
      };
    }

    const runtime = createEphemeralLogState([], {
      requiresAlternatingRoles: (entry.agent as any)._provider?.requiresAlternatingRoles,
      externalEntries: entry.log,
      externalIdAllocator: entry.idAllocator,
    });

    const MAX_SUB_AGENT_ACTIVATIONS = 15;
    const compactCheck = this._buildSubAgentCompactCheck(entry.agent);

    entry.promise = (async () => {
      const t0 = performance.now();
      try {
        let finalText = "";
        for (let i = 0; i < MAX_SUB_AGENT_ACTIVATIONS; i++) {
          if (abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");

          const result = await entry.agent.asyncRunWithMessages(
            runtime.getMessages,
            runtime.appendEntry,
            runtime.allocId,
            0,
            runtime.computeNextRoundIndex(),
            subExecutors, undefined,
            undefined, undefined, abortController.signal,
            undefined, compactCheck,
            undefined, undefined, undefined, undefined, undefined,
            getAgentNotification,
            false,
          );

          if (!result.compactNeeded) {
            if (result.text) finalText = stripContextTags(result.text);
            break;
          }
          // Compact: simplified — just run compact phase
          const continuation = await this._runSubAgentCompactPhase(
            entry.agent, runtime, subExecutors,
            (ri: number) => runtime.allocateContextId(),
            result.compactScenario ?? "output",
            undefined, abortController.signal,
          );
          runtime.appendEntry(createCompactMarker(runtime.allocId("compact_marker"), 0, 0, result.lastTotalTokens ?? 0, 0));
          runtime.appendEntry(createCompactContext(runtime.allocId("compact_context"), 0,
            continuation + "\n\nContinue from where you left off.", runtime.allocateContextId(), 0));
        }

        // Deliver final output to primary
        if (finalText) {
          this._deliverMessage({ from: agentName, to: "primary", content: finalText, timestamp: Date.now() });
        }

        entry.elapsed = (performance.now() - t0) / 1000;
        entry.status = "finished";
        entry.resultText = finalText;
        entry.agentState = "idle";
        this._persistAgentLog(entry);

        // Check if more messages arrived during execution
        if (entry.inbox.length > 0 && entry.turnBudgetRemaining > 0) {
          // Drain inbox into log and re-activate
          const nextMsg = entry.inbox.shift()!;
          const ctxId = allocateContextId(new Set<string>());
          const formatted = `[Message from ${nextMsg.from}]\n${nextMsg.content}`;
          entry.log.push(createUserMessageEntry(
            entry.idAllocator.next("user_message"), 0, formatted, formatted, ctxId,
          ));
          entry.turnBudgetRemaining--;
          this._activateInteractiveAgent(agentName, entry);
        }

        return { name: agentName, status: "completed", text: finalText, usage: {}, elapsed: entry.elapsed };
      } catch (e: any) {
        entry.elapsed = (performance.now() - t0) / 1000;
        if (e?.name === "AbortError" || abortController.signal.aborted) {
          entry.status = "killed";
          entry.agentState = "idle";
          return { name: agentName, status: "killed", text: "(killed)", usage: {}, elapsed: entry.elapsed };
        }
        entry.status = "error";
        entry.agentState = "idle";
        entry.resultText = `Sub-agent error: ${e}`;
        return { name: agentName, status: "error", text: entry.resultText, usage: {}, elapsed: entry.elapsed };
      }
    })();
  }

  private async _execCheckStatus(_args: Record<string, unknown>): Promise<ToolResult> {
    // Non-blocking sweep: check if any working agents have settled
    this._sweepSettledAgents();

    // Unified delivery: drain queue + build agent report (marks delivered)
    const content = this._buildDeliveryContent();
    return new ToolResult({ content });
  }

  /**
   * Non-blocking sweep: check if any working agents have settled.
   */
  /**
   * Unified settle: update status, agentState, and persist log.
   * Called from _sweepSettledAgents, settleEntry (in wait), and _execWait tail sweep.
   */
  private _settleAgentEntry(name: string, entry: AgentEntry, result?: SubAgentResult, error?: unknown): void {
    entry.elapsed = this._getElapsed(entry);
    if (result) {
      entry.status = result.status === "completed" ? "finished" : (result.status as "finished" | "error");
      entry.resultText = result.text;
    } else {
      entry.status = "error";
      entry.resultText = `Sub-agent error: ${error}`;
    }
    // Sync agentState for interactive agents so _deliverToAgent can re-activate
    if (entry.interactive) {
      entry.agentState = "idle";
      this._persistAgentLog(entry);
      // If messages accumulated in inbox during the run, auto-activate
      if (entry.inbox.length > 0 && entry.turnBudgetRemaining > 0) {
        const nextMsg = entry.inbox.shift()!;
        const ctxId = allocateContextId(new Set<string>());
        const formatted = `[Message from ${nextMsg.from}]\n${nextMsg.content}`;
        entry.log.push(createUserMessageEntry(
          entry.idAllocator.next("user_message"), 0, formatted, formatted, ctxId,
        ));
        entry.turnBudgetRemaining--;
        this._activateInteractiveAgent(name, entry);
      }
    }
  }

  private _sweepSettledAgents(): void {
    for (const [name, entry] of this._activeAgents) {
      if (entry.status !== "working") continue;
      // Zero-delay race to check if promise has settled
      const settled = Promise.race([
        entry.promise.then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        ),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
      ]);
      void settled.then((r) => {
        if (r === "pending") return;
        const res = r as { result?: SubAgentResult; error?: unknown };
        this._settleAgentEntry(name, entry, res.result, res.error);
      });
    }
  }

  // ------------------------------------------------------------------
  // wait — blocking wait for sub-agent completion or new messages
  // ------------------------------------------------------------------

  private async _execWait(args: Record<string, unknown>): Promise<ToolResult> {
    const secondsRaw = args["seconds"];
    if (typeof secondsRaw !== "number" || isNaN(secondsRaw)) {
      return new ToolResult({ content: "Error: 'seconds' must be a number." });
    }
    const seconds = Math.max(15, secondsRaw);
    const agentFilter = typeof args["agent"] === "string" ? (args["agent"] as string).trim() : null;
    const shellFilter = typeof args["shell"] === "string" ? (args["shell"] as string).trim() : null;

    if (agentFilter && shellFilter) {
      return new ToolResult({ content: "Error: wait accepts either 'agent' or 'shell', not both." });
    }

    this._agentState = "waiting";
    const abortPromise = this._makeAbortPromise(this._currentTurnSignal);

    const throwIfTurnAborted = (): never => {
      this._waitResolver = null;
      this._agentState = "working";
      throw new DOMException("The operation was aborted.", "AbortError");
    };

    if (this._currentTurnSignal?.aborted) {
      throwIfTurnAborted();
    }

    if (this._activeAgents.size === 0 && !this._hasTrackedShells() && !this._hasInboxMessages()) {
      this._agentState = "working";
      return new ToolResult({ content: "No tracked workers and no messages queued." });
    }

    // Validate agent filter if specified
    if (agentFilter) {
      const targetEntry = this._activeAgents.get(agentFilter);
      if (!targetEntry) {
        this._agentState = "working";
        return new ToolResult({
          content: `Error: agent '${agentFilter}' not found. Use check_status to see current agents.`,
        });
      }
      if (targetEntry.status !== "working") {
        // Agent already done — return status immediately
        this._agentState = "working";
        const content = this._buildDeliveryContent();
        return new ToolResult({ content });
      }
    }

    if (shellFilter) {
      const targetShell = this._activeShells.get(shellFilter);
      if (!targetShell) {
        this._agentState = "working";
        return new ToolResult({
          content: `Error: shell '${shellFilter}' not found. Use check_status to see current shells.`,
        });
      }
      if (targetShell.status !== "running") {
        this._agentState = "working";
        const content = this._buildDeliveryContent();
        return new ToolResult({ content });
      }
    }

    // Collect working agents
    const working: Array<{ name: string; entry: AgentEntry }> = [];
    for (const [n, entry] of this._activeAgents) {
      if (entry.status === "working") {
        working.push({ name: n, entry });
      }
    }

    const hasRunningShells = this._hasRunningShells();
    if (!working.length && !hasRunningShells) {
      this._agentState = "working";
      const content = this._buildDeliveryContent();
      return new ToolResult({ content });
    }

    // Helper: settle one entry from its promise result
    const settleEntry = (entryName: string, result?: SubAgentResult, error?: unknown) => {
      const entry = this._activeAgents.get(entryName);
      if (!entry) return;
      this._settleAgentEntry(entryName, entry, result, error);

      // v2 log: sub_agent_end
      const elapsedSec = entry.elapsed;
      const statusStr = entry.status === "finished" ? "completed" : "errored";
      this._appendEntry(
        createSubAgentEnd(
          this._nextLogId("sub_agent_end"),
          this._turnCount,
          `Sub-agent #${entry.numericId} (${entryName}) ${statusStr} (${elapsedSec.toFixed(1)}s, ${entry.toolCallCount} tool calls)`,
          entry.numericId,
          entryName,
          elapsedSec,
          entry.toolCallCount,
        ),
        false,
      );
    };

    // Create message wake-up promise
    const messageWake = new Promise<"message">((resolve) => {
      this._waitResolver = () => resolve("message");
    });

    let wakeReason: "timeout" | "message" | "agent" | "shell" = "timeout";

    const activeAgentRacers = () => working
      .filter((w) => {
        const e = this._activeAgents.get(w.name);
        return e && e.status === "working";
      })
      .map(({ name: n, entry: ent }) =>
        ent.promise.then(
          (result) => ({ name: n, result, error: undefined as unknown }),
          (error: unknown) => ({ name: n, result: undefined as SubAgentResult | undefined, error }),
        ),
      );

    if (agentFilter) {
      // Work-time mode: poll until target agent accumulates enough wall time
      const POLL_INTERVAL = 1000;
      const timeoutMs = seconds * 1000;

      while (true) {
        const currentEntry = this._activeAgents.get(agentFilter);
        if (!currentEntry || currentEntry.status !== "working") {
          wakeReason = "agent";
          break;
        }

        const workMs = (performance.now() - currentEntry.startTime);
        if (workMs >= timeoutMs) {
          break; // Reached target work time
        }

        // Race all working promises against a short poll interval + message wake
        const racers = activeAgentRacers();

        if (!racers.length) break;

        const poll = new Promise<"poll">((resolve) =>
          setTimeout(() => resolve("poll"), POLL_INTERVAL),
        );

        const winner = await Promise.race([
          ...racers,
          poll,
          messageWake,
          ...(abortPromise ? [abortPromise] : []),
        ]);
        if (winner === "aborted") {
          throwIfTurnAborted();
        }
        if (winner === "message") {
          wakeReason = "message";
          break;
        }
        if (winner !== "poll") {
          const settled = winner as { name: string; result?: SubAgentResult; error?: unknown };
          settleEntry(settled.name, settled.result, settled.error);
          wakeReason = "agent";
          break;
        }
      }
    } else if (shellFilter) {
      const POLL_INTERVAL = 1000;
      const timeoutMs = seconds * 1000;
      const started = performance.now();

      while (true) {
        const currentShell = this._activeShells.get(shellFilter);
        if (!currentShell || currentShell.status !== "running") {
          wakeReason = "shell";
          break;
        }

        if ((performance.now() - started) >= timeoutMs) {
          break;
        }

        const poll = new Promise<"poll">((resolve) =>
          setTimeout(() => resolve("poll"), POLL_INTERVAL),
        );

        const winner = await Promise.race([
          ...activeAgentRacers(),
          poll,
          messageWake,
          ...(abortPromise ? [abortPromise] : []),
        ]);
        if (winner === "aborted") {
          throwIfTurnAborted();
        }
        if (winner === "message") {
          const currentShell = this._activeShells.get(shellFilter);
          wakeReason = !currentShell || currentShell.status !== "running" ? "shell" : "message";
          break;
        }
        if (winner !== "poll") {
          const settled = winner as { name: string; result?: SubAgentResult; error?: unknown };
          settleEntry(settled.name, settled.result, settled.error);
          wakeReason = "agent";
          break;
        }
      }
    } else {
      // Wall-clock mode: simple race with sleep + message wake
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), seconds * 1000),
      );

      const racers = activeAgentRacers();

      const winner = await Promise.race([
        ...racers,
        timeout,
        messageWake,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      if (winner === "aborted") {
        throwIfTurnAborted();
      }
      if (winner === "message") {
        wakeReason = "message";
      } else if (winner !== "timeout") {
        const settled = winner as { name: string; result?: SubAgentResult; error?: unknown };
        settleEntry(settled.name, settled.result, settled.error);
        wakeReason = "agent";
      }
    }

    // Cleanup wait resolver
    this._waitResolver = null;

    // Non-blocking sweep: check if other working agents have also settled
    for (const [name, entry] of this._activeAgents) {
      if (entry.status !== "working") continue;
      const zeroTimeout = new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 0),
      );
      const check = entry.promise.then(
        (result) => ({ result, error: undefined as unknown }),
        (error: unknown) => ({ result: undefined as SubAgentResult | undefined, error }),
      );
      const r = await Promise.race([check, zeroTimeout]);
      if (r !== "pending") {
        const res = r as { result?: SubAgentResult; error?: unknown };
        this._settleAgentEntry(name, entry, res.result, res.error);
      }
    }

    this._agentState = "working";

    // Build return value with unified delivery content
    const hasNewContent = this._hasInboxMessages() || this._hasUndeliveredAgentResults();
    let header: string;
    if (wakeReason === "message") {
      header = `Waited — new message arrived.`;
    } else if (wakeReason === "agent") {
      header = `Waited — agent completed.`;
    } else if (wakeReason === "shell") {
      header = `Waited — shell exited.`;
    } else if (hasNewContent) {
      header = `Waited ${seconds}s. New event arrived during wait.`;
    } else {
      header = `Waited ${seconds}s. No new event arrived during this period.`;
    }

    const deliveryContent = this._buildDeliveryContent();
    return new ToolResult({ content: header + "\n\n" + deliveryContent });
  }

  // ------------------------------------------------------------------
  // Elapsed helpers
  // ------------------------------------------------------------------

  private _getElapsed(entry: AgentEntry): number {
    return (performance.now() - entry.startTime) / 1000;
  }

  // ------------------------------------------------------------------
  // Agent report — built at consumption time (check_status, wait,
  // activation boundary injection). Sets delivered=true only here.
  // ------------------------------------------------------------------

  private _buildAgentReport(): string {
    const statusLines: string[] = [];
    const newResultParts: string[] = [];

    for (const [name, entry] of this._activeAgents) {
      if (entry.status === "working") {
        const workSec = this._getElapsed(entry);
        let line = `- [#${entry.numericId} ${name}] (${entry.template}): working (${workSec.toFixed(1)}s)`;
        line += ` | ${entry.toolCallCount} tools called`;

        if (entry.recentActivity.length > 0) {
          line += "\n    recent: " + entry.recentActivity.join(" → ");
        }
        statusLines.push(line);
      } else if (
        (entry.status === "finished" || entry.status === "error") &&
        !entry.delivered
      ) {
        statusLines.push(
          `- [#${entry.numericId} ${name}] (${entry.template}): ${entry.status} (took ${entry.elapsed.toFixed(1)}s) [result below]`,
        );
        const resultDict = {
          name,
          status: entry.status,
          text: entry.resultText,
          elapsed: entry.elapsed,
        };
        newResultParts.push(this._formatAgentOutput(resultDict));
        entry.delivered = true;  // ★ marked at consumption time
      } else if (entry.delivered) {
        statusLines.push(
          `- [#${entry.numericId} ${name}] (${entry.template}): ${entry.status} (took ${entry.elapsed.toFixed(1)}s) [result already consumed]`,
        );
      } else if (entry.status === "killed") {
        statusLines.push(
          `- [#${entry.numericId} ${name}] (${entry.template}): killed`,
        );
      }
    }

    let output = "## Agent Status\n" + statusLines.join("\n");

    if (newResultParts.length > 0) {
      output += "\n\n## New Results (" + newResultParts.length + ")\n\n" + newResultParts.join("\n\n---\n\n");
    }

    // Hint about still-working agents
    let workingCount = 0;
    for (const entry of this._activeAgents.values()) {
      if (entry.status === "working") workingCount++;
    }
    if (workingCount > 0) {
      output +=
        `\n\n(${workingCount} agent(s) still working. ` +
        "Use wait to wait efficiently, or continue working with tools.)";
    }

    return output;
  }

  private _hasActiveAgents(): boolean {
    for (const entry of this._activeAgents.values()) {
      if (entry.status === "working") return true;
    }
    return false;
  }


  private _forceKillAllAgents(): void {
    for (const [name, entry] of this._activeAgents) {
      if (entry.status === "working") {
        entry.abortController.abort();
        if (this._progress) {
          this._progress.emit({
            step: this._turnCount,
            agent: name,
            action: "agent_killed",
            message: `  [#${entry.numericId} ${name}] killed`,
            level: "normal" as ProgressLevel,
            timestamp: Date.now() / 1000,
            usage: {},
            extra: { sub_agent_id: entry.numericId },
          });
        }
      }
      // Persist agent log before clearing
      this._persistAgentLog(entry);
    }
    this._activeAgents.clear();
    this._teams.clear();
  }

  /**
   * At turn end: kill one-shot agents, preserve interactive/team agents as idle.
   */
  private _cleanupNonInteractiveAgents(): void {
    const toRemove: string[] = [];
    for (const [name, entry] of this._activeAgents) {
      if (entry.interactive) {
        // Interactive agents survive — if working, let them finish
        // (their promise will settle and result will be delivered via push)
        if (entry.status !== "working") {
          entry.agentState = "idle";
        }
        continue;
      }
      // One-shot: abort if still working, remove
      if (entry.status === "working") {
        entry.abortController.abort();
        if (this._progress) {
          this._progress.emit({
            step: this._turnCount, agent: name, action: "agent_killed",
            message: `  [#${entry.numericId} ${name}] killed`,
            level: "normal" as ProgressLevel,
            timestamp: Date.now() / 1000,
            usage: {}, extra: { sub_agent_id: entry.numericId },
          });
        }
      }
      this._persistAgentLog(entry);
      toRemove.push(name);
    }
    for (const name of toRemove) {
      this._activeAgents.delete(name);
    }
  }

  /**
   * Persist a sub-agent's log to disk.
   */
  private _persistAgentLog(entry: AgentEntry): void {
    if (!entry.log?.length || !entry.persistDir) return;
    try {
      mkdirSync(entry.persistDir, { recursive: true });
      const metaPath = join(entry.persistDir, "meta.json");
      const logPath = join(entry.persistDir, "log.json");
      writeFileSync(metaPath, JSON.stringify({
        template: entry.template,
        interactive: entry.interactive,
        teamId: entry.teamId,
        status: entry.status,
        task: entry.task,
        numericId: entry.numericId,
        createdAt: new Date().toISOString(),
      }));
      writeFileSync(logPath, JSON.stringify(entry.log));
    } catch (e) {
      console.warn(`Failed to persist agent log for ${entry.persistDir}:`, e);
    }
  }

  private _forceKillAllShells(): void {
    for (const entry of this._activeShells.values()) {
      if (entry.status === "running") {
        entry.explicitKill = true;
        try {
          entry.process.kill("SIGTERM");
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    this._activeShells.clear();
  }

  private _createSubAgentFromPredefined(templateName: string, taskId: string): Agent {
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

    const modelConfig = this._getSubAgentModelConfig();
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
    return agent;
  }

  private _createSubAgentFromPath(templateDir: string, taskId: string): Agent {
    const templateAgent = loadTemplate(templateDir, this.config, taskId, this._mcpManager, this._promptsDirs);
    const modelConfig = this._getSubAgentModelConfig();

    const agent = new Agent({
      name: taskId,
      modelConfig,
      systemPrompt: this._renderSystemPrompt(templateAgent.systemPrompt),
      tools: [...templateAgent.tools],
      maxToolRounds: templateAgent.maxToolRounds,
      description: `Sub-agent '${taskId}' (custom)`,
    });
    this._applySubAgentConstraints(agent);
    return agent;
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
    // Lifecycle-specific constraints are injected via _buildSubAgentSystemPrompt,
    // not here — to avoid one-shot language leaking into interactive agents.
  }

  private _getSubAgentModelConfig(): ModelConfig {
    return this.primaryAgent.modelConfig;
  }

  private _buildSubAgentContext(includeImportantLog: boolean): Array<Record<string, unknown>> {
    const extra: Array<Record<string, unknown>> = [];
    if (includeImportantLog) {
      const logContent = this._readImportantLog();
      if (logContent.trim()) {
        extra.push({
          role: "user",
          content:
            "[IMPORTANT LOG]\n" +
            "The following is the primary agent's engineering notebook. " +
            "Use it as background context for your task:\n\n" +
            logContent,
        });
      }
    }
    // Always inject AGENTS.md for sub-agents (persistent memory is always relevant)
    const agentsMdContent = this._readAgentsMd();
    if (agentsMdContent.trim()) {
      extra.push({
        role: "user",
        content:
          "[AGENTS.MD — PERSISTENT MEMORY]\n" +
          "The following is persistent memory across sessions. " +
          "Use it as background context for your task:\n\n" +
          agentsMdContent,
      });
    }
    return extra;
  }

  /**
   * Build a sub-agent's full system prompt by layering:
   * 1. Template system_prompt.md (role/capabilities)
   * 2. Mode-specific prompt (oneshot / interactive)
   * 3. Team prompt (if in a team)
   */
  private _buildSubAgentSystemPrompt(
    basePrompt: string,
    interactive: boolean,
    teamId: string | null,
  ): string {
    const parts = [basePrompt];

    // Mode-specific layer
    try {
      const modeFile = interactive ? "interactive.md" : "oneshot.md";
      const modePrompt = this._readPromptFile(`sub-agent/${modeFile}`);
      if (modePrompt) parts.push(modePrompt);
    } catch { /* optional */ }

    // Team layer
    if (teamId) {
      try {
        let teamPrompt = this._readPromptFile("sub-agent/team.md");
        if (teamPrompt) {
          const team = this._teams.get(teamId);
          const roster = team
            ? [...team.members].map((memberId) => {
                const entry = this._activeAgents.get(memberId);
                return entry
                  ? `- **${memberId}** (${entry.template}): ${entry.task.slice(0, 100)}`
                  : `- **${memberId}**`;
              }).join("\n")
            : "(team roster unavailable)";
          teamPrompt = teamPrompt
            .replace("{TEAM_ID}", teamId)
            .replace("{TEAM_ROSTER}", roster);
          parts.push(teamPrompt);
        }
      } catch { /* optional */ }
    }

    return parts.join("\n\n");
  }

  /**
   * Read a prompt file from the prompts directories.
   */
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

  private async _runSubAgent(
    name: string,
    agent: Agent,
    task: string,
    agentId: number,
    extraMessages?: Array<Record<string, unknown>>,
    signal?: AbortSignal,
    persistentLog?: LogEntry[],
    persistentIdAllocator?: LogIdAllocator,
    interactive?: boolean,
    teamId?: string | null,
  ): Promise<SubAgentResult> {
    const subExtra = { sub_agent_id: agentId };
    const MAX_SUB_AGENT_ACTIVATIONS = 15;

    let onToolCall: ((agentName: string, tool: string, args: Record<string, unknown>, summary: string) => void) | undefined;
    let onSubTextChunk: ((roundIndex: number, chunk: string) => boolean | void) | undefined;
    let onSubReasoningChunk: ((roundIndex: number, chunk: string) => boolean | void) | undefined;

    // Track whether phase-signal has been emitted this activation.
    // Reset on tool_call so subsequent thinking/generating is detected.
    let reasoningSignalEmitted = false;
    let textSignalEmitted = false;

    if (this._progress) {
      const progress = this._progress;
      const step = this._turnCount;

      let subToolCallCount = 0;
      onToolCall = (agentName: string, tool: string, args: Record<string, unknown>, summary: string) => {
        progress.onToolCall(step, agentName, tool, args, summary, { sub_agent_id: agentId });
        // Reset phase-signal flags so next thinking/generating is detected
        reasoningSignalEmitted = false;
        textSignalEmitted = false;

        // v2 log: sub_agent_tool_call
        subToolCallCount++;
        this._appendEntry(
          createSubAgentToolCall(
            this._nextLogId("sub_agent_tool_call"),
            this._turnCount,
            `[#${agentId} ${name}] (${subToolCallCount} tool called) -> ${summary}`,
            agentId,
            name,
            tool,
            subToolCallCount,
          ),
          false,
        );
      };

      // Lightweight signal-only callbacks (empty chunk, once per phase)
      onSubReasoningChunk = (_roundIndex: number, _chunk: string) => {
        if (!reasoningSignalEmitted) {
          reasoningSignalEmitted = true;
          textSignalEmitted = false;
          progress.emit({
            step, agent: name, action: "reasoning_chunk",
            message: "", level: "quiet" as ProgressLevel,
            timestamp: Date.now() / 1000,
            usage: {}, extra: { chunk: "", sub_agent_id: agentId },
          });
        }
        return false;
      };

      onSubTextChunk = (_roundIndex: number, _chunk: string) => {
        if (!textSignalEmitted) {
          textSignalEmitted = true;
          reasoningSignalEmitted = false;
          progress.emit({
            step, agent: name, action: "text_chunk",
            message: "", level: "quiet" as ProgressLevel,
            timestamp: Date.now() / 1000,
            usage: {}, extra: { chunk: "", sub_agent_id: agentId },
          });
        }
        return false;
      };
    }

    // Wrap callbacks to write back live state to AgentEntry unconditionally
    // (works even when this._progress is null)
    const getEntry = (): AgentEntry | undefined => this._activeAgents.get(name);

    const origOnToolCall = onToolCall;
    onToolCall = (ag: string, tool: string, args: Record<string, unknown>, summary: string) => {
      origOnToolCall?.(ag, tool, args, summary);
      const e = getEntry();
      if (e) {
        e.phase = "tool_calling";
        e.recentActivity.push(summary);
        if (e.recentActivity.length > 3) e.recentActivity.shift();
        e.toolCallCount++;
      }
    };

    const origOnReasoningChunk = onSubReasoningChunk;
    onSubReasoningChunk = (roundIndex: number, c: string) => {
      origOnReasoningChunk?.(roundIndex, c);
      const e = getEntry();
      if (e) e.phase = "thinking";
      return false;
    };

    const origOnTextChunk = onSubTextChunk;
    onSubTextChunk = (roundIndex: number, c: string) => {
      origOnTextChunk?.(roundIndex, c);
      const e = getEntry();
      if (e) e.phase = "generating";
      return false;
    };

    const t0 = performance.now();
    try {
      // Check abort before starting
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      // Build sub-agent system prompt with mode-specific layers
      const fullSystemPrompt = this._buildSubAgentSystemPrompt(
        agent.systemPrompt, interactive ?? false, teamId ?? null,
      );
      // Build sub-agent log state (persistent-backed when available)
      const initialMessages: Array<Record<string, unknown>> = [
        { role: "system", content: fullSystemPrompt },
      ];
      if (extraMessages) {
        initialMessages.push(...extraMessages);
      }
      initialMessages.push({ role: "user", content: task });
      const runtime = createEphemeralLogState(initialMessages, {
        requiresAlternatingRoles: (agent as any)._provider.requiresAlternatingRoles,
        externalEntries: persistentLog,
        externalIdAllocator: persistentIdAllocator,
      });
      const roundContextIds = new Map<number, string>();
      const getSubAgentRoundContextId = (roundIndex: number): string => {
        let contextId = roundContextIds.get(roundIndex);
        if (!contextId) {
          contextId = runtime.allocateContextId();
          roundContextIds.set(roundIndex, contextId);
        }
        return contextId;
      };

      // Build sub-agent compact check
      const compactCheck = this._buildSubAgentCompactCheck(agent);

      // Pass a small, explicit subset of Session-scoped executors to sub-agents.
      // This preserves project-root path enforcement for file tools while keeping
      // comm tools unavailable.
      const subExecutors: Record<string, ToolExecutor> = {};
      for (const toolName of [
        "$web_search",
        "read_file",
        "list_dir",
        "glob",
        "grep",
        "edit_file",
        "write_file",
        "diff",
        "web_fetch",
      ]) {
        if (this._toolExecutors[toolName]) {
          subExecutors[toolName] = this._toolExecutors[toolName];
        }
      }

      // Team members get send executor for cross-agent communication
      if (teamId) {
        subExecutors["send"] = (args: Record<string, unknown>) => {
          const sendTo = ((args["to"] as string) ?? "").trim();
          const sendContent = ((args["content"] as string) ?? "").trim();
          if (!sendTo || !sendContent) {
            return new ToolResult({ content: "Error: 'to' and 'content' are required." });
          }
          if (sendTo === "primary") {
            return new ToolResult({ content: "Cannot send to primary — your turn output is automatically delivered. Use send only for teammates." });
          }
          const team = this._teams.get(teamId);
          if (!team || !team.members.has(sendTo)) {
            return new ToolResult({ content: `Agent '${sendTo}' is not in your team.` });
          }
          this._deliverToAgent(sendTo, { from: name, to: sendTo, content: sendContent, timestamp: Date.now() });
          return new ToolResult({ content: `Message sent to '${sendTo}'.` });
        };
      }

      let totalUsage = { inputTokens: 0, outputTokens: 0 };
      let finalText = "";
      let compactCount = 0;

      // Activation loop with compact support
      for (let i = 0; i < MAX_SUB_AGENT_ACTIVATIONS; i++) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        // Reset phase-signal flags at the start of each activation
        reasoningSignalEmitted = false;
        textSignalEmitted = false;

        const subAgentName = agent.name;
        const result = await agent.asyncRunWithMessages(
          runtime.getMessages,
          runtime.appendEntry,
          runtime.allocId,
          0,
          runtime.computeNextRoundIndex(),
          subExecutors, onToolCall,
          onSubTextChunk, onSubReasoningChunk, signal,
          getSubAgentRoundContextId, compactCheck,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          (attempt, max, delaySec, errMsg) => this._progress?.onRetryAttempt(subAgentName, attempt, max, delaySec, errMsg),
          (attempt) => this._progress?.onRetrySuccess(subAgentName, attempt),
          (max, errMsg) => this._progress?.onRetryExhausted(subAgentName, max, errMsg),
        );

        totalUsage.inputTokens += result.totalUsage.inputTokens;
        totalUsage.outputTokens += result.totalUsage.outputTokens;

        if (!result.compactNeeded) {
          // Normal completion
          this._appendEphemeralAgentOutput(runtime, result, getSubAgentRoundContextId);
          if (result.text) finalText = stripContextTags(result.text);
          break;
        }

        // Compact triggered — run compact phase for sub-agent
        if (result.compactScenario === "output") {
          this._appendEphemeralAgentOutput(runtime, result, getSubAgentRoundContextId);
        }

        const continuation = await this._runSubAgentCompactPhase(
          agent,
          runtime,
          subExecutors,
          getSubAgentRoundContextId,
          result.compactScenario ?? "output",
          onToolCall,
          signal,
        );

        // Insert compact marker and reconstruct context
        compactCount += 1;
        runtime.appendEntry(createCompactMarker(
          runtime.allocId("compact_marker"),
          0,
          compactCount - 1,
          result.lastTotalTokens ?? 0,
          0,
        ));
        runtime.appendEntry(createCompactContext(
          runtime.allocId("compact_context"),
          0,
          continuation + "\n\nContinue from where you left off.",
          runtime.allocateContextId(),
          compactCount - 1,
        ));
      }

      const elapsed = (performance.now() - t0) / 1000;

      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (this._progress) {
        this._progress.onAgentEnd(
          this._turnCount, name, elapsed,
          totalUsage as Record<string, number>,
          subExtra,
        );
      }

      return { name, status: "completed", text: finalText, usage: totalUsage as Record<string, number>, elapsed };
    } catch (e: any) {
      const elapsed = (performance.now() - t0) / 1000;

      if (e?.name === "AbortError" || signal?.aborted) {
        if (this._progress) {
          this._progress.emit({
            step: this._turnCount,
            agent: name,
            action: "agent_killed",
            message: `  [#${agentId} ${name}] killed`,
            level: "normal" as ProgressLevel,
            timestamp: Date.now() / 1000,
            usage: {},
            extra: subExtra,
          });
        }
        return { name, status: "killed", text: "(killed)", usage: {}, elapsed };
      }

      console.error(`Sub-agent '${name}' failed:`, e);
      if (this._progress) {
        this._progress.emit({
          step: this._turnCount,
          agent: name,
          action: "agent_error",
          message: `  [#${agentId} ${name}] error: ${e}`,
          level: "normal" as ProgressLevel,
          timestamp: Date.now() / 1000,
          usage: {},
          extra: subExtra,
        });
      }
      return { name, status: "error", text: `Sub-agent error: ${e}`, usage: {}, elapsed };
    }
  }

  private _appendEphemeralAgentOutput(
    runtime: ReturnType<typeof createEphemeralLogState>,
    result: Pick<ToolLoopResult, "text" | "reasoningContent" | "reasoningState" | "textHandledInLog" | "reasoningHandledInLog">,
    getRoundContextId: (roundIndex: number) => string,
  ): void {
    if (!result.text && !result.reasoningContent) return;

    const roundIndex = (result.textHandledInLog || result.reasoningHandledInLog)
      ? Math.max(0, runtime.computeNextRoundIndex() - 1)
      : runtime.computeNextRoundIndex();

    // Check if this round has tool_call entries (i.e., is NOT text-only).
    // Text-only final rounds inherit the preceding user-side contextId.
    const hasToolCallsInRound = runtime.entries.some(
      (e) => e.roundIndex === roundIndex && e.type === "tool_call" && !e.discarded,
    );
    let contextId: string;
    if (hasToolCallsInRound) {
      contextId = getRoundContextId(roundIndex);
    } else {
      // Inherit: find the most recent user-side contextId in the ephemeral log
      let inherited: string | undefined;
      for (let i = runtime.entries.length - 1; i >= 0; i--) {
        const e = runtime.entries[i];
        if (e.discarded || e.summarized) continue;
        if (e.apiRole === "user" || e.apiRole === "tool_result") {
          const cid = (e.meta as Record<string, unknown>)["contextId"];
          if (typeof cid === "string" && cid.trim()) { inherited = cid; break; }
        }
      }
      contextId = inherited ?? getRoundContextId(roundIndex);
    }

    if (result.reasoningContent && !result.reasoningHandledInLog) {
      runtime.appendEntry(createReasoning(
        runtime.allocId("reasoning"),
        0,
        roundIndex,
        result.reasoningContent,
        result.reasoningContent,
        result.reasoningState,
        contextId,
      ));
    }

    if (!result.text || result.textHandledInLog) return;

    const trimmedText = result.text.trimEnd();
    const hasNoReply = isNoReply(result.text) || trimmedText.endsWith(NO_REPLY_MARKER);
    if (hasNoReply) {
      const precedingText = trimmedText
        .slice(0, trimmedText.length - NO_REPLY_MARKER.length)
        .trim();
      runtime.appendEntry(createNoReply(
        runtime.allocId("no_reply"),
        0,
        roundIndex,
        precedingText || "<NO_REPLY>",
        contextId,
      ));
      return;
    }

    const cleanText = stripContextTags(result.text);
    runtime.appendEntry(createAssistantText(
      runtime.allocId("assistant_text"),
      0,
      roundIndex,
      cleanText,
      cleanText,
      contextId,
    ));
  }

  /**
   * Build a compact check callback for sub-agents.
   * Similar to _buildCompactCheck but without sub-agent deferral logic.
   */
  private _buildSubAgentCompactCheck(agent: Agent) {
    const mc = agent.modelConfig;
    const provider = (agent as any)._provider;
    const effectiveMax = mc.maxTokens;
    const budget = provider.budgetCalcMode === "full_context"
      ? this._effectiveContextLength(mc)
      : this._effectiveContextLength(mc) - effectiveMax;

    if (budget <= 0) return undefined;

    const compactOutputRatio = this._thresholds.compact_output / 100;
    const compactToolcallRatio = this._thresholds.compact_toolcall / 100;

    return (inputTokens: number, outputTokens: number, hasToolCalls: boolean) => {
      const tokensToCheck = provider.budgetCalcMode === "full_context"
        ? inputTokens
        : inputTokens + outputTokens;

      const threshold = hasToolCalls ? compactToolcallRatio : compactOutputRatio;

      if (tokensToCheck > threshold * budget) {
        return { compactNeeded: true, scenario: hasToolCalls ? "toolcall" as const : "output" as const };
      }
      return { compactNeeded: false };
    };
  }

  /**
   * Run compact phase for a sub-agent: inject compact prompt, let agent produce
   * a continuation prompt (possibly using tools), then return it.
   * Simplified version — does not inject important log or phase plan.
   */
  private async _runSubAgentCompactPhase(
    agent: Agent,
    runtime: ReturnType<typeof createEphemeralLogState>,
    subExecutors: Record<string, ToolExecutor>,
    getRoundContextId: (roundIndex: number) => string,
    scenario: "output" | "toolcall",
    onToolCall?: ((agentName: string, tool: string, args: Record<string, unknown>, summary: string) => void),
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt = scenario === "output" ? SUB_AGENT_COMPACT_PROMPT_OUTPUT : SUB_AGENT_COMPACT_PROMPT_TOOLCALL;
    runtime.appendEntry(createUserMessageEntry(
      runtime.allocId("user_message"),
      0,
      "",
      prompt,
      runtime.allocateContextId(),
    ));

    let continuationPrompt = "";
    for (let i = 0; i < MAX_COMPACT_PHASE_ROUNDS; i++) {
      if (signal?.aborted) break;

      const compactAgentName = agent.name;
      const result = await agent.asyncRunWithMessages(
        runtime.getMessages,
        runtime.appendEntry,
        runtime.allocId,
        0,
        runtime.computeNextRoundIndex(),
        subExecutors, onToolCall,
        undefined, undefined, signal,
        getRoundContextId, undefined, undefined, undefined, undefined, undefined,
        undefined,
        undefined,
        false,
        (attempt, max, delaySec, errMsg) => this._progress?.onRetryAttempt(compactAgentName, attempt, max, delaySec, errMsg),
        (attempt) => this._progress?.onRetrySuccess(compactAgentName, attempt),
        (max, errMsg) => this._progress?.onRetryExhausted(compactAgentName, max, errMsg),
      );

      if (result.text) {
        this._appendEphemeralAgentOutput(runtime, result, getRoundContextId);
        continuationPrompt = stripContextTags(result.text);
        break;
      }
    }

    if (!continuationPrompt) {
      continuationPrompt = "[Compact phase did not produce a continuation prompt.]";
    }

    return continuationPrompt;
  }

  // -- Result collection & delivery --

  private async _waitForAnyAgent(signal?: AbortSignal): Promise<void> {
    const working: Array<{ name: string; entry: AgentEntry }> = [];
    for (const [name, entry] of this._activeAgents) {
      if (entry.status === "working") {
        working.push({ name, entry });
      }
    }
    if (!working.length) return;

    // Race all working promises + a timeout
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), SUB_AGENT_TIMEOUT),
    );

    // Wrap each promise to return its name on settle
    const racers = working.map(({ name, entry }) =>
      entry.promise.then(
        (result) => ({ name, result, error: undefined }),
        (error) => ({ name, result: undefined, error }),
      ),
    );

    const abortPromise = this._makeAbortPromise(signal);
    const winner = await Promise.race([
      ...racers,
      timeout,
      ...(abortPromise ? [abortPromise] : []),
    ]);

    if (winner === "timeout") {
      // Kill the agent with the most elapsed work time
      let candidate: { name: string; entry: AgentEntry; workTime: number } | undefined;
      for (const w of working) {
        const workTime = performance.now() - w.entry.startTime;
        if (!candidate || workTime > candidate.workTime) {
          candidate = { ...w, workTime };
        }
      }
      if (candidate && candidate.workTime > SUB_AGENT_TIMEOUT) {
        console.warn(`Sub-agent '${candidate.name}' killed after ${(candidate.workTime / 1000).toFixed(0)}s elapsed time`);
        this._execKillAgent({ ids: [candidate.name] });
      }
      return;
    }
    if (winner === "aborted") {
      return;
    }

    // Update the entry that just finished
    const settled = winner as { name: string; result?: SubAgentResult; error?: unknown };
    const entry = this._activeAgents.get(settled.name);
    if (entry) {
      entry.elapsed = this._getElapsed(entry);
      if (settled.result) {
        entry.status = settled.result.status === "completed" ? "finished" : (settled.result.status as any);
        entry.resultText = settled.result.text;
      } else if (settled.error) {
        entry.status = "error";
        entry.resultText = `Sub-agent error: ${settled.error}`;
      }
    }

    // Also check if other agents have settled
    for (const w of working) {
      if (w.name === settled.name) continue;
      const e = this._activeAgents.get(w.name);
      if (!e || e.status !== "working") continue;
      // Check with a zero-delay race
      const zeroTimeout = new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 0),
      );
      const check = e.promise.then(
        (result) => ({ result, error: undefined }),
        (error) => ({ result: undefined, error }),
      );
      const r = await Promise.race([check, zeroTimeout]);
      if (r !== "pending") {
        const res = r as { result?: SubAgentResult; error?: unknown };
        e.elapsed = this._getElapsed(e);
        if (res.result) {
          e.status = res.result.status === "completed" ? "finished" : (res.result.status as any);
          e.resultText = res.result.text;
        } else {
          e.status = "error";
          e.resultText = `Sub-agent error: ${res.error}`;
        }
      }
    }
  }

  private _formatAgentOutput(result: Record<string, unknown>): string {
    const name = result["name"] as string;
    const status = result["status"] as string;
    const text = (result["text"] as string) ?? "";
    const elapsed = (result["elapsed"] as number) ?? 0;

    const header = `**${name}** [${status}, ${elapsed.toFixed(1)}s]`;

    if (status !== "finished") {
      return `${header}\n${text}`;
    }

    if (text.length > SUB_AGENT_OUTPUT_LIMIT) {
      const outputDir = join(this._getArtifactsDir(), "agent-outputs");
      mkdirSync(outputDir, { recursive: true });
      const outputPath = join(outputDir, `${name}.md`);
      writeFileSync(outputPath, text);

      const truncated = text.slice(0, SUB_AGENT_OUTPUT_LIMIT);
      const truncatedAtLine = truncated.split("\n").length;
      return (
        `${header}\n` +
        `(Output truncated at ${SUB_AGENT_OUTPUT_LIMIT.toLocaleString()} chars ` +
        `(line ${truncatedAtLine}). Full output: artifacts/agent-outputs/${name}.md. ` +
        `Continue reading from line ${truncatedAtLine} with \`read_file(start_line=${truncatedAtLine})\`; ` +
        `do not reread the portion already received.)\n\n` +
        truncated
      );
    }

    return `${header}\n${text}`;
  }

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

    try {
      await this._mcpManager.connectAll();
      const mcpTools = this._mcpManager.getAllTools();

      for (const tool of mcpTools) {
        const toolName = tool.name;
        if (toolName in this._toolExecutors) continue;

        const capturedName = toolName;
        this._toolExecutors[toolName] = async (args: Record<string, unknown>) => {
          return this._mcpManager!.callTool(capturedName, args);
        };
      }

      // Inject MCP tool defs into agents
      const agentsToPatch: Agent[] = [
        this.primaryAgent,
        ...Object.values(this.agentTemplates),
      ];
      const seenAgents = new Set<Agent>();

      for (const agent of agentsToPatch) {
        if (seenAgents.has(agent)) continue;
        seenAgents.add(agent);

        const spec = (agent as any)._mcpToolsSpec;
        if (!spec || spec === "none") continue;

        let selectedTools: ToolDef[];
        if (spec === "all") {
          selectedTools = mcpTools;
        } else if (Array.isArray(spec)) {
          const prefixes = (spec as string[]).map((s) => `mcp__${s}__`);
          selectedTools = mcpTools.filter((t) =>
            prefixes.some((p) => t.name.startsWith(p)),
          );
        } else {
          selectedTools = [];
        }

        if (!selectedTools.length) continue;

        const existingToolNames = new Set(agent.tools.map((t) => t.name));
        for (const tool of selectedTools) {
          if (existingToolNames.has(tool.name)) continue;
          agent.tools.push(tool);
          existingToolNames.add(tool.name);
        }
      }

      this._mcpConnected = mcpTools.length > 0;
    } catch (e) {
      this._mcpConnected = false;
      console.error("Failed to connect MCP servers:", e);
    }
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
    this.requestTurnInterrupt();
    await this.waitForTurnComplete();
    this._forceKillAllAgents();
    this._forceKillAllShells();
    if (this._mcpManager) {
      try {
        await this._mcpManager.closeAll();
      } catch (e) {
        console.warn("Error closing MCP connections:", e);
      }
    }
  }
}
