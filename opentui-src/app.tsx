/** @jsxImportSource @opentui/react */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { execSync } from "node:child_process";

import type {
  CommandRegistry,
  CommandContext,
  Session as TuiSession,
} from "../src/ui/contracts.js";
import type { SessionStore } from "../src/persistence.js";
import type { ChildSessionSnapshot } from "../src/session-tree-types.js";
import { saveLog } from "../src/persistence.js";
import { isCommandExitSignal } from "../src/commands.js";
import { ProgressReporter, type ProgressEvent } from "../src/progress.js";
import { scanCandidates } from "../src/file-attach.js";
import { classifyPastedText, TurnPasteCounter } from "../src/ui/input/paste.js";
import { readClipboardImage } from "../src/clipboard-image.js";
import { processImage, type ProcessedImage } from "../src/image-compress.js";
import type { InlineImageInput } from "../src/ui/contracts.js";
import type {
  PendingAskUi,
  AgentQuestionAnswer,
  AgentQuestionDecision,
  AgentQuestionItem,
} from "../src/ask.js";
import type {
  PromptSecretRequest,
  PromptSelectRequest,
} from "../src/provider-credential-flow.js";
import {
  acceptCommandPickerSelection,
  createCommandPicker,
  exitCommandPickerLevel,
  isCommandPickerActive,
  moveCommandPickerSelection,
  setCommandPickerSelection,
  type CommandPickerState,
} from "../src/ui/command-picker.js";
import {
  createCheckboxPicker,
  isCheckboxPickerActive,
  moveCheckboxSelection,
  setCheckboxPickerSelection,
  submitCheckboxPicker,
  toggleCheckboxItem,
  type CheckboxPickerState,
} from "../src/ui/checkbox-picker.js";
import {
  type InputRenderable,
  type KeyBinding,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import "./forked/patch-opentui-markdown.js";
import {
  getLongerAgentAssistantRenderer,
  isLongerAgentMarkdownPatchDisabled,
  isLongerAgentOpenTuiDiagEnabled,
  writeLongerAgentOpenTuiDiag,
} from "./forked/core/lib/diagnostic.js";
import { usePresentationEntries } from "./presentation/use-presentation.js";
import { useTurnTimer } from "./presentation/use-turn-timer.js";
import type { TabState } from "./sidebar/sidebar-tabs.js";
import { getCurrentModelDescriptor } from "../src/model-presentation.js";
import { UsagePoller, type UsageSnapshot } from "../src/provider-usage.js";
import {
  readOAuthAccessToken,
  hasOAuthTokens,
  isTokenExpiring,
  saveOAuthTokens,
  browserLoginHeadless,
  deviceCodeLoginHeadless,
  type OAuthProgress,
  type OAuthTokens,
} from "../src/auth/openai-oauth.js";
import {
  buildFileReferenceLabel,
  createComposerTokenVisuals,
  ensureComposerTokenType,
  findFileReferenceQuery,
  getComposerTokenSnapshots,
  getTextDiffRange,
  patchComposerExtmarksForDisplayWidth,
  replaceRangeWithComposerToken,
  serializeComposerText,
  type ComposerTokenVisuals,
} from "./composer-tokens.js";
import { DEFAULT_DISPLAY_THEME, type DisplayTheme } from "./display/theme/index.js";
import { ContextUsageCard, CodexUsageCard } from "./display/panels/usage-cards.js";
import { StatusPanel } from "./display/panels/status-panel.js";
import { usePlan } from "./presentation/use-plan.js";
import {
  type ActivityPhase,
  type CommandOverlayState,
  type OAuthOverlayState,
  type PromptSecretState,
  type PromptSelectState,
  type QuestionAnswerState,
  EMPTY_COMMAND_OVERLAY,
} from "./display/types.js";
import { clamp, computePickerMaxVisible } from "./display/layout/metrics.js";
import { OpenTuiScreen } from "./display/layout/open-tui-screen.js";
import { resolveModelNameColor } from "./display/utils/model.js";

export interface OpenTuiAppProps {
  session: TuiSession;
  commandRegistry: CommandRegistry;
  store: SessionStore | null;
  verbose?: boolean;
  onExit: (farewell?: string) => Promise<void> | void;
  theme?: DisplayTheme;
}

const CTRL_C_EXIT_WINDOW_MS = 2000;
const CUSTOM_EMPTY_HINT =
  'Custom answer is empty. Please enter an answer first, or choose "Discuss further" instead.';
const GOODBYE_MESSAGES = [
  "Bye!",
  "Goodbye!",
  "See you later!",
  "Until next time!",
  "Take care!",
  "Happy coding!",
  "Catch you later!",
  "Peace out!",
  "So long!",
  "Off I go!",
  "Later, gator!",
] as const;

const ASSISTANT_RENDERER_MODE = getLongerAgentAssistantRenderer();

const DISABLED_TEXTAREA_ACTION = "__disabled__" as unknown as KeyBinding["action"];

const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "n", ctrl: true, action: "newline" },
  { name: "up", action: DISABLED_TEXTAREA_ACTION },
  { name: "down", action: DISABLED_TEXTAREA_ACTION },
  { name: "backspace", meta: true, action: DISABLED_TEXTAREA_ACTION },
  { name: "backspace", super: true, action: DISABLED_TEXTAREA_ACTION },
  { name: "u", ctrl: true, action: DISABLED_TEXTAREA_ACTION },
];

function isDeleteToVisualLineStartShortcut(
  event: {
    name: string;
    ctrl?: boolean;
    meta?: boolean;
    super?: boolean;
  },
): boolean {
  return (
    (event.name === "backspace" && (event.meta || event.super))
    || (event.name === "u" && event.ctrl && !event.meta && !event.super)
  );
}

function isCommandOverlayEligible(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.includes("\n")) return false;
  return !value.slice(1).includes(" ");
}

function isFileOverlayEligible(value: string, cursorOffset: number): boolean {
  return findFileReferenceQuery(value, cursorOffset) !== null;
}

function copyToClipboard(text: string, rendererCopy: (text: string) => boolean): boolean {
  try {
    execSync("pbcopy", { input: text, timeout: 2000 });
    return true;
  } catch {
    return rendererCopy(text);
  }
}

function sameChildSessionList(
  a: ChildSessionSnapshot[],
  b: ChildSessionSnapshot[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left?.id !== right?.id ||
      left?.lifecycle !== right?.lifecycle ||
      left?.phase !== right?.phase ||
      left?.outcome !== right?.outcome ||
      left?.running !== right?.running ||
      left?.logRevision !== right?.logRevision ||
      left?.lifetimeToolCallCount !== right?.lifetimeToolCallCount ||
      left?.lastTotalTokens !== right?.lastTotalTokens ||
      left?.lastToolCallSummary !== right?.lastToolCallSummary ||
      left?.pendingInboxCount !== right?.pendingInboxCount
    ) {
      return false;
    }
  }

  return true;
}

export function OpenTuiApp({
  session,
  commandRegistry,
  store,
  verbose = false,
  onExit,
  theme: themeProp,
}: OpenTuiAppProps): React.ReactElement {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const theme = themeProp ?? DEFAULT_DISPLAY_THEME;
  const inputMaxVisibleLines = theme.layout.inputMaxVisibleLines;
  const [processing, _setProcessing] = useState(false);
  const processingRef = useRef(false);
  const setProcessing = useCallback((v: boolean) => {
    processingRef.current = v;
    _setProcessing(v);
  }, []);
  const [phase, setPhase] = useState<ActivityPhase>("idle");
  const [contextTokens, setContextTokens] = useState(0);
  const [cacheReadTokens, setCacheReadTokens] = useState(0);
  const [codexUsage, setCodexUsage] = useState<UsageSnapshot | null>(null);
  const codexPollerRef = useRef<UsagePoller | null>(null);
  const [childSessions, setChildSessions] = useState<ChildSessionSnapshot[]>([]);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const presentationEntries = usePresentationEntries({ session, selectedChildId, childSessions, processing });
  const turnElapsed = useTurnTimer(processing);
  const planCheckpoints = usePlan(session);
  const [agentsPanelOpen, setAgentsPanelOpen] = useState(false);
  const [todoPanelOpen, setTodoPanelOpen] = useState(false);

  // Agent list modal state
  const [agentListOpen, setAgentListOpen] = useState(false);
  const [agentListSelectedIndex, setAgentListSelectedIndex] = useState(0);

  // Frozen child view — protects display when viewed child becomes archived
  const [frozenChildView, setFrozenChildView] = useState<{
    snapshot: ChildSessionSnapshot;
    entries: readonly import("./presentation/types.js").PresentationEntry[];
  } | null>(null);

  // Tab state for sidebar
  const [tabs, setTabs] = useState<TabState[]>([
    { id: "main", label: "Main Session", icon: "●", closeable: false, kind: "main" },
  ]);
  const [activeTabId, setActiveTabId] = useState("main");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sidebarMode, setSidebarMode] = useState<"open" | "close" | "auto">("close");

  // Sync child session tabs — child tabs are now temporary (created on enter, removed on exit).
  // Only clean up tabs for children that no longer exist and aren't frozen.
  useEffect(() => {
    setTabs((prev) => {
      const currentChildIds = new Set(childSessions.map((s) => s.id));
      return prev.filter((t) => {
        if (t.kind !== "child") return true;
        // Extract child id from tab id (format: "child:{agentId}")
        const childId = t.id.startsWith("child:") ? t.id.slice(6) : t.id;
        // Keep if child still active, or if user is viewing it (frozen view handles archived)
        return currentChildIds.has(childId) || (selectedChildId === childId) || (frozenChildView !== null && selectedChildId === childId);
      });
    });
  }, [childSessions, selectedChildId, frozenChildView]);

  // Derive selectedChildId from active tab
  // Tab id format is "child:{agentId}" — strip prefix to get the raw session id
  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab?.kind === "child") {
      const childId = activeTab.id.startsWith("child:") ? activeTab.id.slice(6) : activeTab.id;
      setSelectedChildId(childId);
    } else {
      setSelectedChildId(null);
    }
  }, [activeTabId, tabs]);

  const handleCloseTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1 || !prev[idx].closeable) return prev;
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(next[Math.max(0, idx - 1)]?.id ?? "main");
      }
      // If closing a child tab, clear selectedChildId
      if (tabId.startsWith("child:")) {
        setSelectedChildId(null);
      }
      return next;
    });
  }, [activeTabId]);

  const openDetailTab = useCallback((entry: import("./presentation/types.js").PresentationEntry) => {
    const tabId = `detail:${entry.id}`;
    const sourceKey = selectedChildId ? `child:${selectedChildId}` : "main";
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev;
      const kind = entry.kind === "thinking" ? "detail-thinking" as const : "detail-tool" as const;
      const label = entry.kind === "thinking"
        ? "Thinking"
        : `${entry.toolDisplayName ?? "Tool"} ${entry.toolText ?? ""}`.trim();
      return [...prev, {
        id: tabId,
        label,
        icon: "◇",
        closeable: true,
        kind,
        sourceSessionKey: sourceKey,
        detailEntryId: entry.id,
      }];
    });
    setActiveTabId(tabId);
  }, [selectedChildId]);

  const [hint, setHint] = useState<string | null>(null);
  const [markdownMode, setMarkdownMode] = useState<"rendered" | "raw">("rendered");
  const [pendingAsk, setPendingAsk] = useState<PendingAskUi | null>(
    typeof session.getPendingAsk === "function" ? session.getPendingAsk() : null,
  );
  const [askError, setAskError] = useState<string | null>(null);
  const [askSelectionIndex, setAskSelectionIndex] = useState(0);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [questionAnswers, setQuestionAnswers] = useState<Map<number, QuestionAnswerState>>(new Map());
  const [customInputMode, setCustomInputMode] = useState(false);
  const [noteInputMode, setNoteInputMode] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [askInputValue, setAskInputValue] = useState("");
  const [optionNotes, setOptionNotes] = useState<Map<string, string>>(new Map());
  const [draftValue, setDraftValue] = useState("");
  const [inputVisibleLines, setInputVisibleLines] = useState(1);
  const [commandOverlay, setCommandOverlay] = useState<CommandOverlayState>(EMPTY_COMMAND_OVERLAY);
  const [commandPicker, setCommandPicker] = useState<CommandPickerState | null>(null);
  const [checkboxPicker, setCheckboxPicker] = useState<CheckboxPickerState | null>(null);
  const [promptSelect, setPromptSelect] = useState<PromptSelectState | null>(null);
  const [promptSecret, setPromptSecret] = useState<PromptSecretState | null>(null);
  const [oauthOverlay, setOauthOverlay] = useState<OAuthOverlayState | null>(null);
  const oauthAbortRef = useRef<AbortController | null>(null);

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const promptSecretInputRef = useRef<InputRenderable | null>(null);
  const askInputRef = useRef<InputRenderable | null>(null);
  const lastInputValueRef = useRef("");
  const lastCtrlCRef = useRef(0);
  const closingRef = useRef(false);
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const suppressComposerSyncRef = useRef(false);
  const pasteCounterRef = useRef(new TurnPasteCounter());
  const imageCounterRef = useRef(0);
  const draftImagesRef = useRef(new Map<string, ProcessedImage & { id: string; index: number }>());
  const maybeCollapseLargePasteRef = useRef<(previousValue: string, nextValue: string) => boolean>(() => false);
  const updateInputOverlayRef = useRef<(value: string, cursorOffset: number) => void>(() => { });
  const composerTokenVisualsRef = useRef<ComposerTokenVisuals | null>(null);
  const promptSelectResolverRef = useRef<((value: string | undefined) => void) | null>(null);
  const promptSecretResolverRef = useRef<((value: string | undefined) => void) | null>(null);
  const colors = theme.colors;
  const composerTokenColorsRef = useRef(colors);
  const markdownStyle = theme.markdownStyle;
  if (!composerTokenVisualsRef.current || composerTokenColorsRef.current !== colors) {
    composerTokenColorsRef.current = colors;
    composerTokenVisualsRef.current = createComposerTokenVisuals(colors);
  }
  const composerTokenVisuals = composerTokenVisualsRef.current;

  // -- Codex usage poller lifecycle --
  // Start/stop based on current provider. Runs inside the component because
  // the poller needs to survive model switches within the same session.
  useEffect(() => {
    const provider = session.primaryAgent?.modelConfig?.provider;
    if (provider !== "openai-codex") {
      // Not a codex model — stop any running poller and clear state.
      if (codexPollerRef.current) {
        codexPollerRef.current.stop();
        codexPollerRef.current = null;
      }
      setCodexUsage(null);
      return;
    }

    const token = readOAuthAccessToken();
    if (!token) {
      setCodexUsage(null);
      return;
    }

    // Reuse existing poller if already running, just update the token.
    if (codexPollerRef.current) {
      codexPollerRef.current.updateToken(token);
      return;
    }

    const poller = new UsagePoller();
    codexPollerRef.current = poller;
    poller.on("update", (snapshot: UsageSnapshot) => setCodexUsage(snapshot));
    poller.start(token);

    return () => {
      poller.stop();
      if (codexPollerRef.current === poller) codexPollerRef.current = null;
    };
  }, [session.primaryAgent?.modelConfig?.provider]);

  useEffect(() => {
    setAskError(null);
    setAskSelectionIndex(0);
    setCurrentQuestionIndex(0);
    setQuestionAnswers(new Map());
    setCustomInputMode(false);
    setNoteInputMode(false);
    setReviewMode(false);
    setAskInputValue("");
    setOptionNotes(new Map());
  }, [pendingAsk?.id]);

  const autoSave = useCallback(() => {
    if (!store || !store.sessionDir || typeof session.getLogForPersistence !== "function") return;
    try {
      const { meta, entries: persistedEntries } = session.getLogForPersistence();
      if (meta.turnCount === 0) return;
      saveLog(store.sessionDir, meta, persistedEntries as any[]);
    } catch {
      // ignore autosave failures in the prototype
    }
  }, [session, store]);

  useEffect(() => {
    session.onSaveRequest = autoSave;
    return () => {
      session.onSaveRequest = undefined;
    };
  }, [session, autoSave]);

  const runPendingTurn = useCallback(async () => {
    if (typeof session.resumePendingTurn !== "function") {
      setAskError("Current session does not support resuming pending asks.");
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("prefilling");
    try {
      await session.resumePendingTurn({ signal: controller.signal });
      setPhase("idle");
      setContextTokens(session.lastInputTokens);
      setCacheReadTokens(session.lastCacheReadTokens ?? 0);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      autoSave();
    } catch (err) {
      if (!controller.signal.aborted) {
        setAskError(err instanceof Error ? err.message : String(err));
        session.appendErrorMessage?.(err instanceof Error ? err.message : String(err), "resume_pending_turn");
        setPhase("error");
      }
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
    }
  }, [autoSave, session]);

  const getAskQuestions = useCallback((): AgentQuestionItem[] => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return [];
    return (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
  }, [pendingAsk]);

  const resolveAgentQuestion = useCallback((
    answersOverride?: Map<number, QuestionAnswerState>,
    notesOverride?: Map<string, string>,
  ) => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
    const effectiveAnswers = answersOverride ?? questionAnswers;
    const effectiveNotes = notesOverride ?? optionNotes;

    for (let index = 0; index < questions.length; index += 1) {
      if (!effectiveAnswers.has(index)) {
        setReviewMode(false);
        setCurrentQuestionIndex(index);
        setAskSelectionIndex(0);
        setAskError("Please answer all questions before continuing.");
        return;
      }
    }

    const answers: AgentQuestionAnswer[] = [];
    for (let index = 0; index < questions.length; index += 1) {
      const answer = effectiveAnswers.get(index)!;
      const selectedOption = questions[index].options[answer.optionIndex];
      if (!selectedOption) {
        setReviewMode(false);
        setCurrentQuestionIndex(index);
        setAskSelectionIndex(0);
        setAskError("Selected answer is out of range.");
        return;
      }
      answers.push({
        questionIndex: index,
        selectedOptionIndex: answer.optionIndex,
        answerText: selectedOption.kind === "custom_input" ? (answer.customText ?? "") : selectedOption.label,
        note: effectiveNotes.get(`${index}-${answer.optionIndex}`) || undefined,
      });
    }

    const decision: AgentQuestionDecision = { answers };
    try {
      session.resolveAgentQuestionAsk?.(pendingAsk.id, decision);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      setAskError(null);
      autoSave();
      if (session.hasPendingTurnToResume?.()) {
        void runPendingTurn();
      }
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err));
    }
  }, [autoSave, optionNotes, pendingAsk, questionAnswers, runPendingTurn, session]);

  const confirmCurrentQuestion = useCallback((selectedIndex: number, extra?: { customText?: string }) => {
    const next = new Map(questionAnswers);
    next.set(currentQuestionIndex, { optionIndex: selectedIndex, ...extra });
    setQuestionAnswers(next);
    return next;
  }, [currentQuestionIndex, questionAnswers]);

  const submitOrReview = useCallback((updated: Map<number, QuestionAnswerState>) => {
    const questions = getAskQuestions();
    const firstMissing = questions.findIndex((_, index) => !updated.has(index));
    if (firstMissing !== -1) {
      setReviewMode(false);
      setCurrentQuestionIndex(firstMissing);
      setAskSelectionIndex(0);
      setAskError("Please answer all questions before reviewing.");
      return;
    }
    if (questions.length > 1) {
      setAskError(null);
      setReviewMode(true);
      return;
    }
    resolveAgentQuestion(updated, optionNotes);
  }, [getAskQuestions, optionNotes, resolveAgentQuestion]);

  const beginAskCustomInput = useCallback((selectedIndex: number) => {
    const existing = questionAnswers.get(currentQuestionIndex);
    const initialValue = existing?.optionIndex === selectedIndex ? (existing.customText ?? "") : "";
    setAskInputValue(initialValue);
    setCustomInputMode(true);
  }, [currentQuestionIndex, questionAnswers]);

  const beginAskNoteInput = useCallback((selectedIndex: number) => {
    const noteKey = `${currentQuestionIndex}-${selectedIndex}`;
    setAskInputValue(optionNotes.get(noteKey) ?? "");
    setNoteInputMode(true);
  }, [currentQuestionIndex, optionNotes]);

  const cancelAskInlineInput = useCallback(() => {
    setCustomInputMode(false);
    setNoteInputMode(false);
    setAskInputValue("");
  }, []);

  const resolveSelectedPendingAsk = useCallback(() => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
    const question = questions[currentQuestionIndex];
    if (!question) return;

    const selectedOption = question.options[askSelectionIndex];
    if (!selectedOption) return;

    if (selectedOption.kind === "custom_input") {
      beginAskCustomInput(askSelectionIndex);
      return;
    }

    const updated = confirmCurrentQuestion(askSelectionIndex);
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((current) => current + 1);
      setAskSelectionIndex(0);
      setAskError(null);
      return;
    }
    submitOrReview(updated);
  }, [
    askSelectionIndex,
    beginAskCustomInput,
    confirmCurrentQuestion,
    currentQuestionIndex,
    pendingAsk,
    submitOrReview,
  ]);

  useEffect(() => {
    const syncFromLog = () => {
      const nextChildSessions = session.getChildSessionSnapshots?.() ?? [];
      setChildSessions((previous) => sameChildSessionList(previous, nextChildSessions) ? previous : nextChildSessions);
      // Archived children stay in _childSessions (Session instance alive), so they always
      // appear in snapshots. No need for frozenChildView protection here.
      setPendingAsk(session.getPendingAsk?.() ?? null);
      if (session.lastInputTokens > 0) {
        setContextTokens(session.lastInputTokens);
        setCacheReadTokens(session.lastCacheReadTokens ?? 0);
      }
    };

    syncFromLog();
    const unsubscribe = typeof session.subscribeLog === "function"
      ? session.subscribeLog(syncFromLog)
      : undefined;
    const poller = setInterval(syncFromLog, 250);
    return () => {
      if (unsubscribe) unsubscribe();
      clearInterval(poller);
    };
  }, [selectedChildId, session]);

  useEffect(() => {
    if (!isLongerAgentOpenTuiDiagEnabled()) return;
    const assistantPEs = presentationEntries.filter((pe) => pe.kind === "assistant");
    const lastAssistant = assistantPEs.length > 0 ? assistantPEs[assistantPEs.length - 1] : null;
    writeLongerAgentOpenTuiDiag("app.entries", {
      totalEntries: presentationEntries.length,
      assistantEntries: assistantPEs.length,
      lastAssistantLength: lastAssistant?.assistantText?.length ?? 0,
      processing,
      markdownMode,
      assistantRenderer: ASSISTANT_RENDERER_MODE,
      markdownPatchDisabled: isLongerAgentMarkdownPatchDisabled(),
      activeAgents: childSessions.length,
    });
  }, [childSessions.length, presentationEntries, markdownMode, processing]);

  const handleProgressRef = useRef<(event: ProgressEvent) => void>(() => { });
  handleProgressRef.current = (event) => {
    if (closingRef.current) return;
    switch (event.action) {
      case "reasoning_chunk":
      case "text_chunk":
        setPhase("decoding");
        break;
      case "tool_call":
        if (event.extra?.["tool"] === "wait") {
          setPhase("waiting");
        } else {
          setPhase("decoding");
        }
        break;
      case "tool_result":
        setPhase("prefilling");
        break;
      case "agent_no_reply":
        session.appendStatusMessage("[No reply] The model chose not to reply.", "no_reply");
        break;
      case "agent_end":
        setPhase("idle");
        if (session.lastInputTokens > 0) {
          setContextTokens(session.lastInputTokens);
          setCacheReadTokens(session.lastCacheReadTokens ?? 0);
        }
        break;
      case "ask_requested":
        setPendingAsk(session.getPendingAsk?.() ?? null);
        setAskError(null);
        setPhase("asking");
        break;
      case "ask_resolved":
        setPendingAsk(session.getPendingAsk?.() ?? null);
        setAskError(null);
        break;
      case "token_update":
        setContextTokens((event.extra["input_tokens"] as number) ?? session.lastInputTokens);
        setCacheReadTokens((event.extra["cache_read_tokens"] as number) ?? session.lastCacheReadTokens ?? 0);
        break;
    }
  };

  useEffect(() => {
    const reporter = new ProgressReporter({
      level: verbose ? "verbose" : "normal",
      callback: (event) => {
        handleProgressRef.current(event);
      },
    });
    session._progress = reporter;
    return () => {
      if (session._progress === reporter) {
        session._progress = undefined;
      }
    };
  }, [session, verbose]);

  const syncComposerState = useCallback(() => {
    const composer = inputRef.current;
    if (!composer || composer.isDestroyed) return;
    const previousValue = lastInputValueRef.current;
    const nextValue = composer.plainText;
    if (previousValue !== nextValue) {
      maybeCollapseLargePasteRef.current(previousValue, nextValue);
      // Prune draft images whose composer token was deleted
      if (draftImagesRef.current.size > 0) {
        const tokens = getComposerTokenSnapshots(composer, ensureComposerTokenType(composer));
        const liveImageIds = new Set(tokens.filter((t) => t.kind === "image" && t.imageId).map((t) => t.imageId));
        for (const id of draftImagesRef.current.keys()) {
          if (!liveImageIds.has(id)) draftImagesRef.current.delete(id);
        }
      }
    }
    const visibleValue = composer.plainText;
    const cursorOffset = composer.cursorOffset;
    const computedWidth = Math.max(1, composer.getLayoutNode().getComputedWidth());
    const measured = composer.editorView.measureForDimensions(computedWidth, inputMaxVisibleLines);
    const measuredLines = Math.max(
      composer.lineCount || 1,
      composer.virtualLineCount || 1,
      measured?.lineCount || 1,
    );
    lastInputValueRef.current = visibleValue;
    setDraftValue(visibleValue);
    setInputVisibleLines(Math.max(1, Math.min(inputMaxVisibleLines, measuredLines)));
    updateInputOverlayRef.current(visibleValue, cursorOffset);
  }, [inputMaxVisibleLines]);

  const setComposerText = useCallback((value: string, cursorToEnd = true) => {
    const composer = inputRef.current;
    if (!composer) return;
    composer.setText(value);
    if (cursorToEnd) {
      composer.cursorOffset = Bun.stringWidth(value);
    }
    syncComposerState();
  }, [syncComposerState]);

  const clearInput = useCallback(() => {
    pasteCounterRef.current.reset();
    lastInputValueRef.current = "";
    setDraftValue("");
    setInputVisibleLines(1);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    setCommandPicker(null);
    setCheckboxPicker(null);
    if (inputRef.current) {
      inputRef.current.extmarks.clear();
      inputRef.current.setText("");
    }
  }, []);

  const focusComposerSoon = useCallback(() => {
    queueMicrotask(() => {
      inputRef.current?.focus();
    });
  }, []);

  const resolvePromptSelect = useCallback((value: string | undefined) => {
    const resolve = promptSelectResolverRef.current;
    promptSelectResolverRef.current = null;
    setPromptSelect(null);
    if (resolve) resolve(value);
    focusComposerSoon();
  }, [focusComposerSoon]);

  const resolvePromptSecret = useCallback((value: string | undefined) => {
    const resolve = promptSecretResolverRef.current;
    promptSecretResolverRef.current = null;
    setPromptSecret(null);
    if (promptSecretInputRef.current) {
      promptSecretInputRef.current.value = "";
    }
    if (resolve) resolve(value);
    focusComposerSoon();
  }, [focusComposerSoon]);

  const cancelOAuthOverlay = useCallback(() => {
    if (oauthAbortRef.current) {
      oauthAbortRef.current.abort();
      oauthAbortRef.current = null;
    }
    setOauthOverlay((prev) => {
      if (prev) prev.resolve(null);
      return null;
    });
    focusComposerSoon();
  }, [focusComposerSoon]);

  const startOAuthFlow = useCallback((method: "browser" | "device") => {
    const controller = new AbortController();
    oauthAbortRef.current = controller;

    const onProgress = (event: OAuthProgress) => {
      switch (event.phase) {
        case "browser_waiting":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "browser_waiting", url: event.url } } : s);
          break;
        case "device_code":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "device_code", url: event.url, userCode: event.userCode } } : s);
          break;
        case "polling":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "polling" } } : s);
          break;
        case "exchanging":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "exchanging" } } : s);
          break;
        case "done":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "done" } } : s);
          break;
        case "error":
          setOauthOverlay((s) => s ? { ...s, phase: { step: "error", message: event.message } } : s);
          break;
      }
    };

    const loginFn = method === "browser" ? browserLoginHeadless : deviceCodeLoginHeadless;
    loginFn({ onProgress, signal: controller.signal })
      .then(async (tokens) => {
        saveOAuthTokens(tokens);
        oauthAbortRef.current = null;
        // Show "Login successful!" briefly before closing
        await new Promise((r) => setTimeout(r, 800));
        setOauthOverlay((prev) => {
          if (prev) prev.resolve(tokens);
          return null;
        });
        focusComposerSoon();
      })
      .catch((err) => {
        if (err instanceof Error && err.message === "Cancelled") return;
        setOauthOverlay((s) => s
          ? { ...s, phase: { step: "error", message: err instanceof Error ? err.message : String(err) } }
          : s);
        oauthAbortRef.current = null;
      });
  }, [focusComposerSoon]);

  const acceptOAuthChoice = useCallback(() => {
    setOauthOverlay((s) => {
      if (!s || s.phase.step !== "choose") return s;
      // Schedule flow start outside updater to avoid side effects
      queueMicrotask(() => startOAuthFlow(s.selected === 0 ? "browser" : "device"));
      return s;
    });
  }, [startOAuthFlow]);

  /**
   * Show the OAuth overlay and return a promise that resolves
   * with tokens on success, or null on cancel/error.
   */
  const requestOAuthLogin = useCallback((): Promise<OAuthTokens | null> => {
    return new Promise<OAuthTokens | null>((resolve) => {
      setOauthOverlay({
        phase: { step: "choose" },
        selected: 0,
        resolve,
      });
    });
  }, []);

  // -- Startup OAuth check: prompt login if codex token is missing/expired --
  const startupOAuthCheckedRef = useRef(false);
  useEffect(() => {
    if (startupOAuthCheckedRef.current) return;
    const provider = session.primaryAgent?.modelConfig?.provider;
    if (provider !== "openai-codex") return;
    const token = readOAuthAccessToken();
    const needsLogin = !hasOAuthTokens() || (token && isTokenExpiring(token));
    if (!needsLogin) return;
    startupOAuthCheckedRef.current = true;
    queueMicrotask(() => { requestOAuthLogin(); });
  }, [session.primaryAgent?.modelConfig?.provider, requestOAuthLogin]);

  const showHint = useCallback((message: string) => {
    setHint(message);
    setTimeout(() => {
      setHint((current) => (current === message ? null : current));
    }, 2500);
  }, []);

  const performExit = useCallback(async () => {
    autoSave();
    const msg = GOODBYE_MESSAGES[Math.floor(Math.random() * GOODBYE_MESSAGES.length)]!;
    await onExit(msg);
  }, [autoSave, onExit]);

  const beginClosing = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setProcessing(false);
    setPhase("closing");
    setHint(null);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    setCommandPicker(null);
    setCheckboxPicker(null);
    if (closingTimerRef.current) {
      clearTimeout(closingTimerRef.current);
    }
    void performExit();
  }, [performExit]);

  const buildCommandOptions = useCallback((cmdName: string) => {
    const command = commandRegistry.lookup(cmdName);
    if (!command?.options) return [];
    return command.options({
      session,
      store: store ?? undefined,
    });
  }, [commandRegistry, session, store]);

  const pickerMaxVisible = computePickerMaxVisible(terminal.height, theme.layout);

  const startCommandPicker = useCallback((cmdName: string): boolean => {
    const command = commandRegistry.lookup(cmdName);
    const options = buildCommandOptions(cmdName);
    if (options.length === 0) return false;

    setCommandOverlay(EMPTY_COMMAND_OVERLAY);

    if (command?.checkboxMode) {
      setCheckboxPicker(
        createCheckboxPicker(
          cmdName,
          options.map((option) => ({
            label: option.label,
            value: option.value,
            checked: option.checked !== false,
          })),
          Math.min(pickerMaxVisible, options.length),
        ),
      );
      return true;
    }

    setCommandPicker(
      createCommandPicker(
        cmdName,
        options,
        pickerMaxVisible,
      ),
    );
    return true;
  }, [buildCommandOptions, commandRegistry, pickerMaxVisible]);

  const updateInputOverlay = useCallback((value: string, cursorOffset: number) => {
    if (commandPicker || checkboxPicker || promptSelect || promptSecret) return;

    const livePrefix = inputRef.current ? inputRef.current.getTextRange(0, cursorOffset) : value;

    if (isCommandOverlayEligible(livePrefix)) {
      const prefix = livePrefix.slice(1);
      const matches = commandRegistry.getAll().filter((command) =>
        command.name.slice(1).startsWith(prefix),
      );

      if (matches.length > 0) {
        setCommandOverlay((current) => ({
          mode: "command",
          visible: true,
          items: matches.map((command) => `${command.name.padEnd(20)}${command.description}`),
          values: matches.map((command) => command.name),
          selected: current.mode === "command"
            ? clamp(current.selected, 0, Math.max(0, matches.length - 1))
            : 0,
        }));
        return;
      }
    }

    const fileQuery = isFileOverlayEligible(value, cursorOffset)
      ? findFileReferenceQuery(value, cursorOffset)
      : null;
    if (fileQuery) {
      const candidates = scanCandidates(fileQuery.prefix);
      if (candidates.length > 0) {
        setCommandOverlay((current) => ({
          mode: "file",
          visible: true,
          items: candidates,
          values: candidates,
          selected: current.mode === "file"
            ? clamp(current.selected, 0, Math.max(0, candidates.length - 1))
            : 0,
        }));
        return;
      }
    }

    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
  }, [checkboxPicker, commandPicker, commandRegistry, promptSecret, promptSelect]);
  updateInputOverlayRef.current = updateInputOverlay;

  const resetTurnPasteState = useCallback(() => {
    pasteCounterRef.current.reset();
    imageCounterRef.current = 0;
    draftImagesRef.current.clear();
  }, []);

  const maybeCollapseLargePaste = useCallback((previousValue: string, nextValue: string): boolean => {
    const composer = inputRef.current;
    if (!composer || suppressComposerSyncRef.current) return false;

    const diff = getTextDiffRange(previousValue, nextValue);
    if (!diff || !diff.insertedText) return false;

    const decision = classifyPastedText(diff.insertedText, pasteCounterRef.current);
    if (!decision.replacedWithPlaceholder || decision.index === undefined) return false;

    suppressComposerSyncRef.current = true;
    try {
      replaceRangeWithComposerToken(composer, {
        rangeStart: diff.startOffset,
        rangeEnd: diff.endAfterOffset,
        label: decision.text,
        metadata: {
          kind: "paste",
          label: decision.text,
          submitText: diff.insertedText,
          index: decision.index,
          lineCount: decision.lineCount,
        },
        styleId: composerTokenVisuals.pasteStyleId,
      });
    } finally {
      suppressComposerSyncRef.current = false;
    }

    return true;
  }, [composerTokenVisuals.pasteStyleId]);
  maybeCollapseLargePasteRef.current = maybeCollapseLargePaste;

  useEffect(() => {
    const composer = inputRef.current;
    if (!composer) return;
    patchComposerExtmarksForDisplayWidth(composer);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let followupTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      syncComposerState();
    };
    const scheduleSync = () => {
      sync();
      queueMicrotask(sync);
      timeoutId = setTimeout(sync, 0);
      followupTimeoutId = setTimeout(sync, 16);
    };

    composer.onContentChange = scheduleSync;
    composer.onCursorChange = scheduleSync;
    scheduleSync();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (followupTimeoutId) clearTimeout(followupTimeoutId);
      if (inputRef.current === composer) {
        composer.onContentChange = undefined;
        composer.onCursorChange = undefined;
      }
    };
  }, [syncComposerState]);

  useEffect(() => {
    if (promptSecret) {
      queueMicrotask(() => {
        promptSecretInputRef.current?.focus();
      });
      return;
    }

    if (phase === "closing") {
      return;
    }

    if (pendingAsk?.kind === "agent_question" && (customInputMode || noteInputMode)) {
      queueMicrotask(() => {
        askInputRef.current?.focus();
      });
      return;
    }

    if (!pendingAsk && !commandPicker && !checkboxPicker && !promptSelect) {
      focusComposerSoon();
    }
  }, [
    checkboxPicker,
    commandPicker,
    customInputMode,
    focusComposerSoon,
    noteInputMode,
    pendingAsk,
    phase,
    promptSecret,
    promptSelect,
  ]);

  useEffect(() => {
    return () => {
      promptSelectResolverRef.current?.(undefined);
      promptSecretResolverRef.current?.(undefined);
      promptSelectResolverRef.current = null;
      promptSecretResolverRef.current = null;
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current);
        closingTimerRef.current = null;
      }
    };
  }, []);

  const buildCommandContext = useCallback((): CommandContext => {
    return {
      session,
      store: store ?? undefined,
      commandRegistry,
      autoSave,
      showMessage: (message: string) => {
        // Intercept magic messages from /raw and /agents commands
        if (message === "__toggle_markdown_raw__") {
          setMarkdownMode((current) => {
            const next = current === "rendered" ? "raw" : "rendered";
            showHint(next === "raw" ? "Markdown raw: ON" : "Markdown raw: OFF");
            return next;
          });
          return;
        }
        if (message === "__open_agent_list__") {
          setAgentListSelectedIndex(0);
          setAgentListOpen(true);
          return;
        }
        if (message.startsWith("__sidebar_mode__:")) {
          const mode = message.slice(17) as "open" | "close" | "auto";
          setSidebarMode(mode);
          showHint(`Sidebar: ${mode}`);
          return;
        }
        if (message === "__sidebar_toggle__") {
          setSidebarMode((current) => {
            const next = current === "auto" ? "open" : current === "open" ? "close" : "auto";
            showHint(`Sidebar: ${next}`);
            return next;
          });
          return;
        }
        session.appendStatusMessage?.(message);
      },
      resetUiState: () => {
        setProcessing(false);
        setPhase("idle");
        setContextTokens(session.lastInputTokens);
        setCacheReadTokens(session.lastCacheReadTokens ?? 0);
        setPendingAsk(null);
        setAskError(null);
      },
      exit: performExit,
      onTurnRequested: (content: string) => {
        void handleSubmit(content);
      },
      onManualSummarizeRequested: (instruction: string) => {
        void runManualSummarize(instruction);
      },
      onManualCompactRequested: (instruction: string) => {
        void runManualCompact(instruction);
      },
      promptSecret: async (request: PromptSecretRequest) => {
        resolvePromptSecret(undefined);
        resolvePromptSelect(undefined);
        return await new Promise<string | undefined>((resolve) => {
          promptSecretResolverRef.current = resolve;
          setCommandOverlay(EMPTY_COMMAND_OVERLAY);
          setCommandPicker(null);
          setCheckboxPicker(null);
          setPromptSecret({
            message: request.message,
            allowEmpty: request.allowEmpty ?? false,
          });
          queueMicrotask(() => {
            promptSecretInputRef.current?.focus();
          });
        });
      },
      promptSelect: async (request: PromptSelectRequest) => {
        resolvePromptSelect(undefined);
        resolvePromptSecret(undefined);
        return await new Promise<string | undefined>((resolve) => {
          promptSelectResolverRef.current = resolve;
          setCommandOverlay(EMPTY_COMMAND_OVERLAY);
          setCommandPicker(null);
          setCheckboxPicker(null);
          setPromptSelect({
            message: request.message,
            options: request.options,
            selected: 0,
          });
        });
      },
      requestOAuthLogin,
    };
  }, [session, store, commandRegistry, autoSave, performExit, resolvePromptSecret, resolvePromptSelect, requestOAuthLogin]);

  const runTurn = useCallback(async (input: string, inlineImages?: InlineImageInput[]) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("prefilling");
    try {
      await session.turn(input, { signal: controller.signal, inlineImages });
      setPhase("idle");
      setContextTokens(session.lastInputTokens);
      setCacheReadTokens(session.lastCacheReadTokens ?? 0);
      setPendingAsk(session.getPendingAsk?.() ?? null);
      autoSave();
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(message, "turn");
        setPhase("error");
      }
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
      setPhase("idle");
    }
  }, [session, autoSave]);

  const runManualSummarize = useCallback(async (instruction: string) => {
    if (typeof session.runManualSummarize !== "function") {
      session.appendStatusMessage?.("/summarize is not available in this session.");
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("prefilling");
    try {
      await session.runManualSummarize(instruction, { signal: controller.signal });
      setPhase("idle");
      autoSave();
    } catch (err) {
      if (!controller.signal.aborted) {
        session.appendErrorMessage?.(err instanceof Error ? err.message : String(err), "manual_summarize");
        setPhase("error");
      }
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
      setPhase("idle");
    }
  }, [session, autoSave]);

  const runManualCompact = useCallback(async (instruction: string) => {
    if (typeof session.runManualCompact !== "function") {
      session.appendStatusMessage?.("/compact is not available in this session.");
      return;
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessing(true);
    setPhase("prefilling");
    try {
      await session.runManualCompact(instruction, { signal: controller.signal });
      setPhase("idle");
      autoSave();
    } catch (err) {
      if (!controller.signal.aborted) {
        session.appendErrorMessage?.(err instanceof Error ? err.message : String(err), "manual_compact");
        setPhase("error");
      }
    } finally {
      abortControllerRef.current = null;
      setProcessing(false);
      setPhase("idle");
    }
  }, [session, autoSave]);

  const getSerializedComposerInput = useCallback((): string => {
    const composer = inputRef.current;
    if (!composer) return draftValue;
    return serializeComposerText(composer, ensureComposerTokenType(composer));
  }, [draftValue]);

  const UI_ONLY_COMMANDS = new Set(["/agents", "/raw", "/sidebar"]);

  const handleSubmit = useCallback(async (submittedValue: string) => {
    const input = submittedValue.trim();
    if (!input) return;

    // UI-only commands: always intercept, even when processing
    if (input.startsWith("/")) {
      const cmdToken = input.split(/\s/)[0];
      if (UI_ONLY_COMMANDS.has(cmdToken)) {
        clearInput();
        const command = commandRegistry.lookup(cmdToken);
        if (command) {
          const args = input.slice(cmdToken.length).trim();
          try { await command.handler(buildCommandContext(), args); } catch { /* ignore */ }
        }
        return;
      }
    }

    if (pendingAsk) {
      showHint("Ask resolution is not implemented in this prototype yet.");
      return;
    }

    if (!processingRef.current && input.startsWith("/") && !/\s/.test(input)) {
      const command = commandRegistry.lookup(input);
      if (command?.options && startCommandPicker(input)) {
        if (inputRef.current) {
          inputRef.current.extmarks.clear();
          inputRef.current.setText("");
        }
        resetTurnPasteState();
        lastInputValueRef.current = "";
        setDraftValue("");
        setInputVisibleLines(1);
        return;
      }
    }

    // Capture image tokens before clearInput destroys composer state
    let inlineImages: InlineImageInput[] | undefined;
    if (draftImagesRef.current.size > 0) {
      const images: InlineImageInput[] = [];
      for (const [imageId, img] of draftImagesRef.current) {
        // Only include images whose placeholder is still in the text
        if (input.includes(`[Image #${img.index}]`)) {
          images.push({ id: imageId, base64: img.base64, mediaType: img.mediaType });
        }
      }
      if (images.length > 0) inlineImages = images;
    }

    clearInput();

    // Use ref to avoid stale closure — OpenTUI's custom renderer may not
    // re-create useCallback closures on every state change.
    const isProcessing = processingRef.current;

    if (isProcessing) {
      if (typeof session.deliverMessage === "function") {
        session.deliverMessage("user", input);
        session.appendStatusMessage?.(`[Queued user message]\n${input}`, "queued_user_message");
        showHint("Message queued for the next activation boundary.");
      } else {
        showHint("The assistant is busy and this prototype cannot queue input here.");
      }
      return;
    }

    if (input.startsWith("/")) {
      const [cmdName] = input.split(/\s+/, 1);
      const args = input.slice(cmdName.length).trim();
      const command = commandRegistry.lookup(cmdName);
      if (!command) {
        session.appendErrorMessage?.(`Unknown command: ${cmdName}`, "command");
        return;
      }
      try {
        await command.handler(buildCommandContext(), args);
      } catch (err) {
        if (isCommandExitSignal(err)) {
          await performExit();
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        session.appendErrorMessage?.(`Command failed (${cmdName}): ${message}`, "command");
      }
      return;
    }

    await runTurn(input, inlineImages);
  }, [
    clearInput,
    pendingAsk,
    processing,
    session,
    commandRegistry,
    startCommandPicker,
    buildCommandContext,
    performExit,
    runTurn,
    showHint,
  ]);

  const acceptInputOverlaySelection = useCallback(() => {
    const selectedValue = commandOverlay.values[commandOverlay.selected];
    if (!selectedValue) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    if (commandOverlay.mode === "file") {
      const composer = inputRef.current;
      if (!composer) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      const query = findFileReferenceQuery(composer.plainText, composer.cursorOffset);
      if (!query) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      const label = buildFileReferenceLabel(selectedValue);
      suppressComposerSyncRef.current = true;
      try {
        replaceRangeWithComposerToken(composer, {
          rangeStart: query.startOffset,
          rangeEnd: query.endOffset,
          label,
          metadata: {
            kind: "file",
            label,
            submitText: label,
            path: selectedValue,
          },
          styleId: composerTokenVisuals.fileStyleId,
          trailingText: " ",
        });
      } finally {
        suppressComposerSyncRef.current = false;
      }

      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      syncComposerState();
      return;
    }

    const command = commandRegistry.lookup(selectedValue);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    if (command?.options && startCommandPicker(selectedValue)) {
      if (inputRef.current) {
        inputRef.current.setText("");
        inputRef.current.extmarks.clear();
      }
      resetTurnPasteState();
      lastInputValueRef.current = "";
      setDraftValue("");
      setInputVisibleLines(1);
      return;
    }

    void handleSubmit(selectedValue);
  }, [
    commandOverlay,
    commandRegistry,
    composerTokenVisuals.fileStyleId,
    handleSubmit,
    resetTurnPasteState,
    startCommandPicker,
    syncComposerState,
  ]);

  const completeInputOverlaySelection = useCallback(() => {
    const selectedValue = commandOverlay.values[commandOverlay.selected];
    if (!selectedValue) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    if (commandOverlay.mode === "file") {
      acceptInputOverlaySelection();
      return;
    }

    setComposerText(`${selectedValue} `);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
  }, [acceptInputOverlaySelection, commandOverlay, setComposerText]);

  const acceptCommandPickerSelectionLocal = useCallback(() => {
    if (!commandPicker) return;
    const result = acceptCommandPickerSelection(commandPicker);
    if (!result) {
      setCommandPicker(null);
      return;
    }

    if (result.kind === "drill_down") {
      setCommandPicker(result.picker);
      return;
    }

    setCommandPicker(null);
    void handleSubmit(result.command);
  }, [commandPicker, handleSubmit]);

  const clickCommandPickerItem = useCallback((index: number) => {
    if (!commandPicker) return;
    const withSelection = setCommandPickerSelection(commandPicker, index);
    const result = acceptCommandPickerSelection(withSelection);
    if (!result) {
      setCommandPicker(null);
      return;
    }
    if (result.kind === "drill_down") {
      setCommandPicker(result.picker);
      return;
    }
    setCommandPicker(null);
    void handleSubmit(result.command);
  }, [commandPicker, handleSubmit]);

  const clickCheckboxPickerItem = useCallback((index: number) => {
    setCheckboxPicker((current) => {
      if (!current) return current;
      const withSelection = setCheckboxPickerSelection(current, index);
      return toggleCheckboxItem(withSelection);
    });
  }, []);

  const clickOverlayItem = useCallback((index: number) => {
    const selectedValue = commandOverlay.values[index];
    if (!selectedValue) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
      return;
    }

    if (commandOverlay.mode === "file") {
      // Set selection and let the standard accept handle file references
      setCommandOverlay((current) => ({ ...current, selected: index }));
      acceptInputOverlaySelection();
      return;
    }

    const command = commandRegistry.lookup(selectedValue);
    setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    if (command?.options && startCommandPicker(selectedValue)) {
      if (inputRef.current) {
        inputRef.current.setText("");
        inputRef.current.extmarks.clear();
      }
      resetTurnPasteState();
      lastInputValueRef.current = "";
      setDraftValue("");
      setInputVisibleLines(1);
      return;
    }
    void handleSubmit(selectedValue);
  }, [commandOverlay, commandRegistry, startCommandPicker, handleSubmit, acceptInputOverlaySelection, resetTurnPasteState]);

  const clickPromptSelectItem = useCallback((index: number) => {
    if (!promptSelect) return;
    const option = promptSelect.options[clamp(index, 0, promptSelect.options.length - 1)];
    resolvePromptSelect(option?.value);
  }, [promptSelect, resolvePromptSelect]);

  const submitCheckboxPickerSelection = useCallback(async () => {
    if (!checkboxPicker) return;
    const result = submitCheckboxPicker(checkboxPicker);
    if (result.kind !== "submit") return;

    const enabled = result.items.filter((item) => item.checked).map((item) => item.value);
    const args = enabled.length > 0 ? enabled.join(",") : ",";
    setCheckboxPicker(null);
    await handleSubmit(`/skills ${args}`);
  }, [checkboxPicker, handleSubmit]);

  const deleteToVisualLineStart = useCallback(() => {
    const composer = inputRef.current;
    if (!composer) return;

    if (composer.hasSelection()) {
      composer.deleteCharBackward();
      syncComposerState();
      return;
    }

    const cursor = composer.editorView.getCursor();
    const visualStart = composer.editorView.getVisualSOL();
    if (
      visualStart.logicalRow === cursor.row &&
      visualStart.logicalCol === cursor.col
    ) {
      return;
    }

    if (visualStart.logicalRow === cursor.row && visualStart.logicalCol === 0) {
      composer.deleteToLineStart();
      syncComposerState();
      return;
    }

    composer.gotoVisualLineHome({ select: true });
    if (composer.hasSelection()) {
      composer.deleteCharBackward();
    }
    syncComposerState();
  }, [syncComposerState]);

  const isAtFirstVisualLine = useCallback((): boolean => {
    const composer = inputRef.current;
    if (!composer) return false;
    const visualStart = composer.editorView.getVisualSOL();
    return visualStart.logicalRow === 0 && visualStart.logicalCol === 0;
  }, []);

  const isAtLastVisualLine = useCallback((): boolean => {
    const composer = inputRef.current;
    if (!composer) return false;
    const lineCount = composer.lineCount || composer.editBuffer.getLineCount();
    const visualEnd = composer.editorView.getVisualEOL();
    const logicalEnd = composer.editBuffer.getEOL();
    return (
      visualEnd.logicalRow === Math.max(0, lineCount - 1) &&
      visualEnd.logicalCol === logicalEnd.col
    );
  }, []);

  const moveComposerVertically = useCallback((direction: "up" | "down") => {
    const composer = inputRef.current;
    if (!composer) return;

    if (direction === "up") {
      composer.moveCursorUp();
    } else {
      composer.moveCursorDown();
    }

    syncComposerState();
  }, [syncComposerState]);

  const acceptPromptSelect = useCallback(() => {
    if (!promptSelect) return;
    const option = promptSelect.options[clamp(promptSelect.selected, 0, promptSelect.options.length - 1)];
    resolvePromptSelect(option?.value);
  }, [promptSelect, resolvePromptSelect]);

  const submitPromptSecret = useCallback((value: string) => {
    if (!promptSecret) return;
    if (!promptSecret.allowEmpty && value.trim() === "") {
      showHint("A value is required.");
      return;
    }
    resolvePromptSecret(value);
  }, [promptSecret, resolvePromptSecret, showHint]);

  const submitAskInlineInput = useCallback((value: string) => {
    if (!pendingAsk || pendingAsk.kind !== "agent_question") return;
    const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];

    if (noteInputMode) {
      const noteText = value.trim();
      const noteKey = `${currentQuestionIndex}-${askSelectionIndex}`;
      setOptionNotes((current) => {
        const next = new Map(current);
        if (noteText) {
          next.set(noteKey, noteText);
        } else {
          next.delete(noteKey);
        }
        return next;
      });
      confirmCurrentQuestion(askSelectionIndex);
      cancelAskInlineInput();
      return;
    }

    if (!customInputMode) return;

    const customText = value.trim();
    if (!customText) {
      setAskError(CUSTOM_EMPTY_HINT);
      return;
    }

    const updated = confirmCurrentQuestion(askSelectionIndex, { customText });
    cancelAskInlineInput();
    setAskError(null);
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((current) => current + 1);
      setAskSelectionIndex(0);
      return;
    }
    submitOrReview(updated);
  }, [
    askSelectionIndex,
    cancelAskInlineInput,
    confirmCurrentQuestion,
    currentQuestionIndex,
    customInputMode,
    noteInputMode,
    pendingAsk,
    submitOrReview,
  ]);

  useKeyboard((event) => {
    const selectionText = renderer.getSelection()?.getSelectedText() ?? "";
    const hasSelection = selectionText.length > 0;
    const isCopyCombo = event.name === "c" && (event.meta || event.super || event.ctrl);
    const composer = inputRef.current;

    if (phase === "closing") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (hasSelection && isCopyCombo) {
      const copied = copyToClipboard(selectionText, (text) => renderer.copyToClipboardOSC52(text));
      if (!copied) {
        showHint("Copy failed.");
      }
      renderer.clearSelection();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (hasSelection && event.name === "escape") {
      renderer.clearSelection();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (promptSecret) {
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        resolvePromptSecret(undefined);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (promptSelect) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setPromptSelect((current) => current
          ? { ...current, selected: (current.selected - 1 + current.options.length) % current.options.length }
          : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down" || event.name === "tab") {
        setPromptSelect((current) => current
          ? { ...current, selected: (current.selected + 1) % current.options.length }
          : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        acceptPromptSelect();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        resolvePromptSelect(undefined);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (oauthOverlay) {
      if (oauthOverlay.phase.step === "choose") {
        if (event.name === "up" || (event.name === "tab" && event.shift)) {
          setOauthOverlay((s) => s ? { ...s, selected: s.selected === 0 ? 1 : 0 } : s);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "down" || event.name === "tab") {
          setOauthOverlay((s) => s ? { ...s, selected: s.selected === 0 ? 1 : 0 } : s);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "return") {
          acceptOAuthChoice();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (event.name === "escape" || (event.name === "c" && event.ctrl)) {
        cancelOAuthOverlay();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (pendingAsk?.kind === "agent_question") {
      if (!(event.name === "c" && event.ctrl)) {
        const questions = (pendingAsk.payload["questions"] as AgentQuestionItem[]) ?? [];
        const question = questions[currentQuestionIndex];
        const totalOptions = question?.options.length ?? 0;
        const agentOptionCount = question?.options.filter((option) => !option.systemAdded).length ?? 0;

        if (reviewMode) {
          if (event.name === "return") {
            resolveAgentQuestion(questionAnswers, optionNotes);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.name === "escape") {
            setReviewMode(false);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (/^[1-9]$/.test(event.name)) {
            const nextQuestionIndex = Number(event.name) - 1;
            if (nextQuestionIndex < questions.length) {
              setReviewMode(false);
              setCurrentQuestionIndex(nextQuestionIndex);
              setAskSelectionIndex(questionAnswers.get(nextQuestionIndex)?.optionIndex ?? 0);
            }
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          return;
        }

        if (customInputMode || noteInputMode) {
          if (event.name === "escape") {
            cancelAskInlineInput();
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }

        if (!question) return;

        if (event.name === "tab" && askSelectionIndex < agentOptionCount) {
          beginAskNoteInput(askSelectionIndex);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "up" && totalOptions > 0) {
          setAskSelectionIndex((current) => (current - 1 + totalOptions) % totalOptions);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "down" && totalOptions > 0) {
          setAskSelectionIndex((current) => (current + 1) % totalOptions);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "left" && questions.length > 1) {
          setCurrentQuestionIndex((current) => Math.max(0, current - 1));
          setAskSelectionIndex(questionAnswers.get(Math.max(0, currentQuestionIndex - 1))?.optionIndex ?? 0);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "right" && questions.length > 1) {
          if (question.options[askSelectionIndex]?.kind !== "custom_input") {
            confirmCurrentQuestion(askSelectionIndex);
          }
          const nextQuestionIndex = Math.min(questions.length - 1, currentQuestionIndex + 1);
          setCurrentQuestionIndex(nextQuestionIndex);
          setAskSelectionIndex(questionAnswers.get(nextQuestionIndex)?.optionIndex ?? 0);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.name === "return") {
          resolveSelectedPendingAsk();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }

    if (isCheckboxPickerActive(checkboxPicker)) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setCheckboxPicker((current) => current ? moveCheckboxSelection(current, -1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down" || event.name === "tab") {
        setCheckboxPicker((current) => current ? moveCheckboxSelection(current, 1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "space") {
        setCheckboxPicker((current) => current ? toggleCheckboxItem(current) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        event.preventDefault();
        event.stopPropagation();
        void submitCheckboxPickerSelection();
        return;
      }
      if (event.name === "escape") {
        setCheckboxPicker(null);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (isCommandPickerActive(commandPicker)) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setCommandPicker((current) => current ? moveCommandPickerSelection(current, -1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down" || event.name === "tab") {
        setCommandPicker((current) => current ? moveCommandPickerSelection(current, 1) : current);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        event.preventDefault();
        event.stopPropagation();
        acceptCommandPickerSelectionLocal();
        return;
      }
      if (event.name === "escape") {
        setCommandPicker((current) => current ? exitCommandPickerLevel(current) : null);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    const liveComposerValue = composer?.plainText ?? draftValue;
    const liveCursorOffset = composer?.cursorOffset ?? liveComposerValue.length;
    const shouldHandleInputOverlay = commandOverlay.visible && (
      commandOverlay.mode === "command"
        ? isCommandOverlayEligible(composer ? composer.getTextRange(0, liveCursorOffset) : liveComposerValue)
        : isFileOverlayEligible(liveComposerValue, liveCursorOffset)
    );
    if (commandOverlay.visible && !shouldHandleInputOverlay) {
      setCommandOverlay(EMPTY_COMMAND_OVERLAY);
    }

    if (shouldHandleInputOverlay) {
      if (event.name === "up" || (event.name === "tab" && event.shift)) {
        setCommandOverlay((current) => ({
          ...current,
          selected: (current.selected - 1 + current.items.length) % current.items.length,
        }));
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down") {
        setCommandOverlay((current) => ({
          ...current,
          selected: (current.selected + 1) % current.items.length,
        }));
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "tab") {
        completeInputOverlaySelection();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        acceptInputOverlaySelection();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "escape") {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (event.name === "pageup") {
      scrollRef.current?.scrollBy(-(scrollRef.current.height / 2));
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "pagedown") {
      scrollRef.current?.scrollBy(scrollRef.current.height / 2);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Ctrl+V: paste image from system clipboard
    if (event.name === "v" && event.ctrl && !event.meta && !event.alt && !event.super) {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        try {
          const clipResult = await readClipboardImage();
          if (!clipResult) {
            showHint("No image in clipboard.");
            return;
          }
          const processed = await processImage(clipResult.buffer, clipResult.mediaType);
          const idx = ++imageCounterRef.current;
          const imageId = `img-${idx}`;
          draftImagesRef.current.set(imageId, { ...processed, id: imageId, index: idx });

          const label = `[Image #${idx}]`;
          const cmp = inputRef.current;
          if (cmp) {
            suppressComposerSyncRef.current = true;
            try {
              replaceRangeWithComposerToken(cmp, {
                rangeStart: cmp.cursorOffset,
                rangeEnd: cmp.cursorOffset,
                label,
                metadata: {
                  kind: "image",
                  label,
                  submitText: label,
                  imageId,
                  index: idx,
                },
                styleId: composerTokenVisuals.imageStyleId,
                trailingText: " ",
              });
            } finally {
              suppressComposerSyncRef.current = false;
            }
            syncComposerState();
          }
          const sizeMB = (processed.sizeBytes / (1024 * 1024)).toFixed(1);
          showHint(`Image pasted (${processed.width}×${processed.height}, ${sizeMB} MB)`);
        } catch (err) {
          showHint(`Image paste failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      return;
    }

    // Option+Left / Option+Right: switch to adjacent tab
    // Ghostty sends Esc+b / Esc+f (word movement) for Option+Left/Right
    const isOptLeft = (event.meta && event.name === "left") || (event.meta && event.name === "b");
    const isOptRight = (event.meta && event.name === "right") || (event.meta && event.name === "f");
    if (isOptLeft || isOptRight) {
      const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
      if (currentIdx !== -1) {
        const nextIdx = isOptLeft
          ? (currentIdx - 1 + tabs.length) % tabs.length
          : (currentIdx + 1) % tabs.length;
        if (nextIdx !== currentIdx) {
          setActiveTabId(tabs[nextIdx].id);
        }
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Option+Up: go to Main Session
    if (event.meta && event.name === "up") {
      setActiveTabId("main");
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Esc / Ctrl+C on sub-pages: interrupt running agent OR close tab
    if ((event.name === "escape" || (event.name === "c" && event.ctrl)) && activeTabId !== "main") {
      // If viewing a running child agent, interrupt it first
      if (selectedChildId) {
        const snapshot = childSessions.find((s) => s.id === selectedChildId);
        if (snapshot?.lifecycle === "running") {
          const decision = session.interruptChildSession?.(selectedChildId) ?? { accepted: false, reason: "unsupported" };
          if (decision.accepted) {
            if (event.name === "c" && event.ctrl) {
              session.deliverMessage?.(
                "system",
                `${selectedChildId} was interrupted early by the user. Ask the user for next steps if more information is needed.`,
              );
            }
            showHint(`Interrupted ${selectedChildId}`);
          }
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      // Not a running agent (or not a child tab at all) — close tab, jump to adjacent
      const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
      const currentTab = tabs[currentIdx];
      if (currentTab?.closeable) {
        const remaining = tabs.filter((t) => t.id !== activeTabId);
        const jumpIdx = Math.min(currentIdx, remaining.length - 1);
        const jumpTab = remaining[Math.max(0, jumpIdx)];
        setTabs(remaining);
        setActiveTabId(jumpTab?.id ?? "main");
        if (activeTabId.startsWith("child:")) {
          setSelectedChildId(null);
        }
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Esc on main page: interrupt current turn (no exit behavior)
    if (event.name === "escape" && activeTabId === "main") {
      if (commandPicker) {
        setCommandPicker(null);
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (checkboxPicker) {
        setCheckboxPicker(null);
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (commandOverlay.visible) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (processingRef.current) {
        const decision = session.requestTurnInterrupt
          ? session.requestTurnInterrupt()
          : (session.cancelCurrentTurn?.(), { accepted: true as const });
        if (decision.accepted) {
          abortControllerRef.current?.abort();
          setPhase("cancelling");
        } else {
          showHint(
            decision.reason === "compact_in_progress"
              ? "Interrupt is disabled during compact phase"
              : "Interrupt is currently disabled.",
          );
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (event.name === "c" && event.ctrl) {
      event.preventDefault();
      event.stopPropagation();

      if (commandPicker) {
        setCommandPicker(null);
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      if (checkboxPicker) {
        setCheckboxPicker(null);
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      if (commandOverlay.visible) {
        setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        return;
      }

      const now = Date.now();
      if (now - lastCtrlCRef.current < CTRL_C_EXIT_WINDOW_MS) {
        if (processingRef.current) {
          const decision = session.requestTurnInterrupt
            ? session.requestTurnInterrupt()
            : (session.cancelCurrentTurn?.(), { accepted: true as const });
          if (decision.accepted) {
            abortControllerRef.current?.abort();
          }
        }
        beginClosing();
        return;
      }

      lastCtrlCRef.current = now;

      if (processingRef.current) {
        const decision = session.requestTurnInterrupt
          ? session.requestTurnInterrupt()
          : (session.cancelCurrentTurn?.(), { accepted: true as const });
        if (decision.accepted) {
          abortControllerRef.current?.abort();
          // Do NOT set processing=false here — let runTurn's finally block
          // handle it after the turn actually finishes. This prevents a new
          // turn from starting before the old one unwinds.
          setPhase("cancelling");
        } else {
          showHint(
            decision.reason === "compact_in_progress"
              ? "Interrupt is disabled during compact phase"
              : "Interrupt is currently disabled.",
          );
        }
        return;
      }

      if (lastInputValueRef.current.trim()) {
        clearInput();
        return;
      }

      showHint("Press Ctrl+C again to exit");
      return;
    }

    // Agent list modal keyboard handling
    if (agentListOpen) {
      if (event.name === "escape") {
        setAgentListOpen(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "up") {
        setAgentListSelectedIndex((i) => (i - 1 + childSessions.length) % childSessions.length);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "down") {
        setAgentListSelectedIndex((i) => (i + 1) % childSessions.length);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.name === "return") {
        const agent = childSessions[agentListSelectedIndex];
        if (agent) enterChildSession(agent.id);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Block all other keys while modal is open
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "g" && event.ctrl) {
      openAgentList();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Ctrl+O: toggle todo panel expand/collapse
    if (event.name === "o" && event.ctrl) {
      const openTodos = planCheckpoints.filter((cp) => cp.status !== "done");
      if (openTodos.length > 0) {
        setTodoPanelOpen((prev) => !prev);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Tab switching: Ctrl+Left/Right to cycle, Ctrl+Up to return to Main Session
    if (event.name === "left" && event.ctrl && tabs.length > 1) {
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const prev = (idx - 1 + tabs.length) % tabs.length;
      setActiveTabId(tabs[prev].id);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.name === "right" && event.ctrl && tabs.length > 1) {
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const next = (idx + 1) % tabs.length;
      setActiveTabId(tabs[next].id);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.name === "up" && event.ctrl) {
      const mainTab = tabs.find((t) => t.kind === "main");
      if (mainTab && activeTabId !== mainTab.id) {
        setActiveTabId(mainTab.id);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (!composer || pendingAsk) return;

    if (isDeleteToVisualLineStartShortcut(event)) {
      deleteToVisualLineStart();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "up" && isAtFirstVisualLine()) {
      composer.gotoVisualLineHome();
      syncComposerState();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "up") {
      moveComposerVertically("up");
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "down" && isAtLastVisualLine()) {
      composer.gotoVisualLineEnd();
      syncComposerState();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.name === "down") {
      moveComposerVertically("down");
      event.preventDefault();
      event.stopPropagation();
      return;
    }

  });

  const modelDescriptor = getCurrentModelDescriptor(session);
  const modelName = modelDescriptor?.compactScopedLabel ?? "unknown";
  const modelNameColor = resolveModelNameColor(modelDescriptor, theme);

  // Agent counts for indicator — all 3 states
  const runningAgentCount = childSessions.filter((s) => s.lifecycle === "running").length;
  const idleAgentCount = childSessions.filter((s) => s.lifecycle === "idle").length;
  const archivedAgentCount = childSessions.filter((s) => s.lifecycle === "archived").length;

  const openAgentList = useCallback(() => {
    if (childSessions.length === 0) {
      showHint("No agents spawned");
      return;
    }
    setAgentListSelectedIndex(0);
    setAgentListOpen(true);
  }, [childSessions.length, showHint]);

  const enterChildSession = useCallback((agentId: string) => {
    setAgentListOpen(false);
    setSelectedChildId(agentId);
    // Create temporary child tab
    const tabId = `child:${agentId}`;
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev;
      return [...prev, { id: tabId, label: agentId, icon: "◎", closeable: true, kind: "child" as const }];
    });
    setActiveTabId(tabId);
  }, []);

  // Data source switching: use child snapshot when viewing a child page
  const childSnapshot = selectedChildId
    ? (childSessions.find((s) => s.id === selectedChildId) ?? null)
    : null;

  const effectivePhase: ActivityPhase = childSnapshot
    ? (childSnapshot.running ? "decoding" : "idle")
    : phase;
  const effectiveElapsed = childSnapshot ? childSnapshot.turnElapsed : turnElapsed;
  const effectiveModelName = childSnapshot ? (childSnapshot.modelConfigName || modelName) : modelName;
  const effectiveModelColor = childSnapshot
    ? (theme.presentation.modelProviderColors[childSnapshot.modelProvider] ?? modelNameColor)
    : modelNameColor;
  const effectiveContextTokens = childSnapshot ? childSnapshot.inputTokens : contextTokens;
  const effectiveContextLimit = childSnapshot ? childSnapshot.contextBudget : session.primaryAgent.modelConfig?.contextLength;
  const effectiveCacheReadTokens = childSnapshot ? childSnapshot.cacheReadTokens : cacheReadTokens;
  const effectiveProcessing = childSnapshot ? childSnapshot.running : processing;
  const effectiveEntries = presentationEntries;

  return (
    <OpenTuiScreen
      theme={theme}
      terminal={terminal}
      tabs={tabs}
      activeTabId={activeTabId}
      onSelectTab={setActiveTabId}
      onCloseTab={handleCloseTab}
      sidebarExpanded={sidebarExpanded}
      onToggleSidebar={() => setSidebarExpanded((value) => !value)}
      contextTokens={effectiveContextTokens}
      contextLimit={effectiveContextLimit}
      cacheReadTokens={effectiveCacheReadTokens}
      presentationEntries={effectiveEntries}
      processing={effectiveProcessing}
      markdownMode={markdownMode}
      scrollRef={scrollRef}
      selectedChildId={selectedChildId}
      onEntryClick={openDetailTab}
      pendingAsk={pendingAsk}
      askError={askError}
      askSelectionIndex={askSelectionIndex}
      currentQuestionIndex={currentQuestionIndex}
      questionAnswers={questionAnswers}
      customInputMode={customInputMode}
      noteInputMode={noteInputMode}
      reviewMode={reviewMode}
      askInputValue={askInputValue}
      optionNotes={optionNotes}
      askInputRef={askInputRef}
      onAskInput={setAskInputValue}
      onAskSubmit={submitAskInlineInput}
      getAskQuestions={getAskQuestions}
      commandOverlay={commandOverlay}
      commandPicker={commandPicker}
      checkboxPicker={checkboxPicker}
      promptSelect={promptSelect}
      promptSecret={promptSecret}
      promptSecretInputRef={promptSecretInputRef}
      oauthOverlay={oauthOverlay}
      onOverlayItemClick={clickOverlayItem}
      onCommandPickerItemClick={clickCommandPickerItem}
      onCheckboxPickerItemClick={clickCheckboxPickerItem}
      onPromptSelectItemClick={clickPromptSelectItem}
      onPromptSecretSubmit={submitPromptSecret}
      inputRef={inputRef}
      phase={effectivePhase}
      modelName={effectiveModelName}
      modelColor={effectiveModelColor}
      turnElapsed={effectiveElapsed}
      hint={hint}
      inputVisibleLines={inputVisibleLines}
      composerTokenVisuals={composerTokenVisuals}
      keyBindings={COMPOSER_KEY_BINDINGS}
      onSubmit={() => {
        if (selectedChildId) {
          showHint("Return to the primary session to send messages.");
          return;
        }
        void handleSubmit(getSerializedComposerInput());
      }}
      onModelClick={() => void handleSubmit("/model")}
      onAgentIndicatorClick={openAgentList}
      runningAgentCount={runningAgentCount}
      idleAgentCount={idleAgentCount}
      archivedAgentCount={archivedAgentCount}
      agentListOpen={agentListOpen}
      agentListAgents={childSessions}
      agentListSelectedIndex={agentListSelectedIndex}
      onAgentListClose={() => setAgentListOpen(false)}
      onAgentListSelect={enterChildSession}
      sidebarMode={sidebarMode}
      statusPanel={(() => {
        const showAgents = agentsPanelOpen && childSessions.length > 0;
        const openTodos = planCheckpoints.filter((cp) => cp.status !== "done");
        const showTodos = todoPanelOpen && openTodos.length > 0;
        if (!showAgents && !showTodos) return undefined;
        return (
          <StatusPanel
            agents={childSessions}
            showAgents={showAgents}
            todos={planCheckpoints}
            showTodos={showTodos}
            colors={theme.colors}
            contentWidth={terminal.width - (theme.spacing.screenPaddingX * 2)}
            onAgentClick={enterChildSession}
          />
        );
      })()}
      todoOpenCount={planCheckpoints.filter((cp) => cp.status !== "done").length}
      todoDoneCount={planCheckpoints.filter((cp) => cp.status === "done").length}
      todoPanelOpen={todoPanelOpen}
      onTodoClick={() => setTodoPanelOpen((p) => !p)}
      agentsPanelOpen={agentsPanelOpen}
      onAgentsPanelClick={() => setAgentsPanelOpen((p) => !p)}
      sidebarPlanSection={undefined}
      sidebarContextSection={
        <ContextUsageCard
          contextTokens={effectiveContextTokens}
          contextLimit={effectiveContextLimit}
          cacheReadTokens={cacheReadTokens}
          theme={theme}
        />
      }
      sidebarCodexSection={codexUsage ? <CodexUsageCard snapshot={codexUsage} theme={theme} /> : undefined}
      onBackgroundMouseDown={() => {
        if (commandOverlay.visible) setCommandOverlay(EMPTY_COMMAND_OVERLAY);
        if (commandPicker) setCommandPicker(null);
        if (checkboxPicker) setCheckboxPicker(null);
        if (agentListOpen) setAgentListOpen(false);
      }}
    />
  );
}
