/** @jsxImportSource @opentui/react */

import React from "react";

import type { InputRenderable, KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import type { PendingAskUi } from "../../../src/ask.js";
import type { AgentQuestionItem } from "../../../src/ask.js";
import type { CommandPickerState } from "../../../src/ui/command-picker.js";
import type { CheckboxPickerState } from "../../../src/ui/checkbox-picker.js";
import type { PresentationEntry } from "../../presentation/types.js";
import type { ChildSessionSnapshot } from "../../../src/session-tree-types.js";
import type { ComposerTokenVisuals } from "../../composer-tokens.js";
import { PresentationPanel } from "../../components/entry/presentation-panel.js";
import { DetailThinkingTab } from "../../components/entry/detail-thinking-tab.js";
import { DetailToolTab } from "../../components/entry/detail-tool-tab.js";
import { InputArea } from "../../input/input-area.js";
import { ScrollViewport } from "../primitives/scroll-viewport.js";
import type { TabState } from "../../sidebar/sidebar-tabs.js";
import type { DisplayTheme } from "../theme/index.js";
import type {
  ActivityPhase,
  CommandOverlayState,
  OAuthOverlayState,
  PromptSecretState,
  PromptSelectState,
  QuestionAnswerState,
} from "../types.js";
import { AskPanelView } from "../panels/ask-panel.js";
import {
  CheckboxPickerView,
  CommandOverlayView,
  CommandPickerView,
  OAuthOverlayView,
  PromptSecretView,
  PromptSelectView,
} from "../overlays/views.js";
import { AgentListModal } from "../overlays/agent-list-modal.js";
import { RightSidebar, type SidebarMode } from "../../sidebar/right-sidebar.js";
import { computePickerMaxVisible, getSidebarWidth } from "./metrics.js";
import { HorizontalTabBar } from "./horizontal-tab-bar.js";
import { shortenPath } from "../utils/format.js";

export interface OpenTuiScreenProps {
  theme: DisplayTheme;
  terminal: { width: number; height: number };
  tabs: TabState[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  sidebarExpanded: boolean;
  onToggleSidebar: () => void;
  contextTokens: number;
  contextLimit?: number;
  cacheReadTokens?: number;
  /** Pre-formatted usage line (e.g. "5h: 90% left | wk: 80% left" or "month: 300/300 left"); null to hide. */
  usageText?: string | null;
  presentationEntries: readonly PresentationEntry[];
  processing: boolean;
  markdownMode: "rendered" | "raw";
  scrollRef: React.RefObject<ScrollBoxRenderable | null>;
  selectedChildId: string | null;
  onEntryClick: (entry: PresentationEntry) => void;
  onAgentClick?: (agentId: string) => void;
  pendingAsk: PendingAskUi | null;
  askError: string | null;
  askSelectionIndex: number;
  currentQuestionIndex: number;
  questionAnswers: Map<number, QuestionAnswerState>;
  customInputMode: boolean;
  noteInputMode: boolean;
  reviewMode: boolean;
  askInputValue: string;
  optionNotes: Map<string, string>;
  askInputRef: React.RefObject<InputRenderable | null>;
  onAskInput: (value: string) => void;
  onAskSubmit: (value: string) => void;
  getAskQuestions: () => AgentQuestionItem[];
  commandOverlay: CommandOverlayState;
  commandPicker: CommandPickerState | null;
  checkboxPicker: CheckboxPickerState | null;
  promptSelect: PromptSelectState | null;
  promptSecret: PromptSecretState | null;
  promptSecretInputRef: React.RefObject<InputRenderable | null>;
  oauthOverlay: OAuthOverlayState | null;
  onOverlayItemClick: (index: number) => void;
  onCommandPickerItemClick: (index: number) => void;
  onCheckboxPickerItemClick: (index: number) => void;
  onPromptSelectItemClick: (index: number) => void;
  onPromptSecretSubmit: (value: string) => void;
  inputRef: React.RefObject<TextareaRenderable | null>;
  phase: ActivityPhase;
  modelName: string;
  modelColor: string;
  turnElapsed: number;
  hint: string | null;
  inputVisibleLines: number;
  composerTokenVisuals: ComposerTokenVisuals;
  keyBindings: readonly KeyBinding[];
  onSubmit: () => void;
  onModelClick: () => void;
  onAgentIndicatorClick?: () => void;
  runningAgentCount?: number;
  idleAgentCount?: number;
  archivedAgentCount?: number;
  agentListOpen?: boolean;
  agentListAgents?: readonly ChildSessionSnapshot[];
  agentListSelectedIndex?: number;
  onAgentListClose?: () => void;
  onAgentListSelect?: (agentId: string) => void;
  onBackgroundMouseDown: () => void;
  sidebarMode?: SidebarMode;
  activeShells?: Array<{ id: string; command: string; status: string }>;
  /** Pre-rendered status panel (agents + todos, between conversation and input) */
  statusPanel?: React.ReactNode;
  /** Pre-rendered plan panel for sidebar (deprecated) */
  sidebarPlanSection?: React.ReactNode;
  /** Pre-rendered context usage card for sidebar */
  sidebarContextSection?: React.ReactNode;
  /** Pre-rendered codex usage card for sidebar */
  sidebarCodexSection?: React.ReactNode;
  todoOpenCount?: number;
  todoDoneCount?: number;
  todoPanelOpen?: boolean;
  onTodoClick?: () => void;
  agentsPanelOpen?: boolean;
  onAgentsPanelClick?: () => void;
  /** True when user has scrolled away from bottom — hides textarea cursor */
  scrolledAway?: boolean;
}

export function OpenTuiScreen({
  theme,
  terminal,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  contextTokens,
  contextLimit,
  cacheReadTokens,
  usageText,
  presentationEntries,
  processing,
  markdownMode,
  scrollRef,
  selectedChildId,
  onEntryClick,
  onAgentClick,
  pendingAsk,
  askError,
  askSelectionIndex,
  currentQuestionIndex,
  questionAnswers,
  customInputMode,
  noteInputMode,
  reviewMode,
  askInputValue,
  optionNotes,
  askInputRef,
  onAskInput,
  onAskSubmit,
  getAskQuestions,
  commandOverlay,
  commandPicker,
  checkboxPicker,
  promptSelect,
  promptSecret,
  promptSecretInputRef,
  oauthOverlay,
  onOverlayItemClick,
  onCommandPickerItemClick,
  onCheckboxPickerItemClick,
  onPromptSelectItemClick,
  onPromptSecretSubmit,
  inputRef,
  phase,
  modelName,
  modelColor,
  turnElapsed,
  hint,
  inputVisibleLines,
  composerTokenVisuals,
  keyBindings,
  onSubmit,
  onModelClick,
  onAgentIndicatorClick,
  runningAgentCount,
  idleAgentCount,
  archivedAgentCount,
  agentListOpen,
  agentListAgents,
  agentListSelectedIndex,
  onAgentListClose,
  onAgentListSelect,
  onBackgroundMouseDown,
  sidebarMode = "close",
  activeShells = [],
  statusPanel,
  sidebarPlanSection,
  sidebarContextSection,
  sidebarCodexSection,
  todoOpenCount,
  todoDoneCount,
  todoPanelOpen,
  onTodoClick,
  agentsPanelOpen,
  onAgentsPanelClick,
  scrolledAway = false,
}: OpenTuiScreenProps): React.ReactNode {
  const conversationColumnWidth = terminal.width - (theme.spacing.screenPaddingX * 2);
  const conversationContentWidth = Math.max(20, conversationColumnWidth - 6);
  const pickerMaxVisible = computePickerMaxVisible(terminal.height, theme.layout);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isDetailTab = activeTab?.kind === "detail-thinking" || activeTab?.kind === "detail-tool";
  // Detail entry lookup: live entries → frozenEntry fallback
  const detailEntry = isDetailTab
    ? (presentationEntries.find((entry) => activeTabId === `detail:${entry.id}`)
       ?? activeTab?.frozenEntry
       ?? null) as typeof presentationEntries[number] | null
    : null;

  // Sidebar visibility: hidden in child page, respects mode + terminal width
  const isChildPage = selectedChildId !== null;
  const sidebarVisible = !isChildPage && (
    sidebarMode === "open" ||
    (sidebarMode === "auto" && terminal.width >= theme.layout.minTerminalWidthForSidebar)
  );
  const sidebarWidth = getSidebarWidth(terminal.width, theme.layout);
  const effectiveSidebarWidth = sidebarVisible ? sidebarWidth : 0;
  const pickerContentWidth = terminal.width - effectiveSidebarWidth - 10;

  // Logo disappears once user sends the first message
  const hasUserMessage = presentationEntries.some((e) => e.kind === "user");
  const showLogoInScroll = !hasUserMessage
    && terminal.width >= theme.layout.minTerminalWidthForLogoHeader;

  // Shared InputArea element — rendered inside scrollbox for main view, outside for detail tabs
  const inputAreaElement = (
    <InputArea
      inputRef={inputRef}
      processing={processing}
      pendingAsk={Boolean(pendingAsk)}
      selectedChildId={selectedChildId}
      phase={phase}
      modelName={modelName}
      modelColor={modelColor}
      elapsed={turnElapsed}
      cwd={shortenPath(process.cwd())}
      hint={hint}
      contextTokens={contextTokens}
      contextLimit={contextLimit}
      cacheReadTokens={cacheReadTokens ?? 0}
      usageText={usageText ?? null}
      contentWidth={Math.max(20, conversationColumnWidth - effectiveSidebarWidth)}
      colors={theme.colors}
      inputVisibleLines={inputVisibleLines}
      maxInputLines={theme.layout.inputMaxVisibleLines}
      composerTokenVisuals={composerTokenVisuals}
      keyBindings={keyBindings}
      onSubmit={onSubmit}
      onModelClick={onModelClick}
      onAgentIndicatorClick={onAgentIndicatorClick}
      runningAgentCount={runningAgentCount}
      idleAgentCount={idleAgentCount}
      archivedAgentCount={archivedAgentCount}
      commandOverlayVisible={commandOverlay.visible}
      commandPicker={Boolean(commandPicker)}
      checkboxPicker={Boolean(checkboxPicker)}
      promptSelect={Boolean(promptSelect)}
      promptSecret={Boolean(promptSecret)}
      todoOpenCount={todoOpenCount}
      todoDoneCount={todoDoneCount}
      todoPanelOpen={todoPanelOpen}
      onTodoClick={onTodoClick}
      agentsPanelOpen={agentsPanelOpen}
      onAgentsPanelClick={onAgentsPanelClick}
      scrolledAway={scrolledAway}
    />
  );

  // Shared overlays block
  const overlaysBlock = (
    <>
      {pendingAsk ? (
        <AskPanelView
          ask={pendingAsk}
          error={askError}
          selectedIndex={askSelectionIndex}
          currentQuestionIndex={currentQuestionIndex}
          totalQuestions={pendingAsk.kind === "agent_question" ? getAskQuestions().length : 1}
          questionAnswers={questionAnswers}
          customInputMode={customInputMode}
          noteInputMode={noteInputMode}
          reviewMode={reviewMode}
          inlineValue={askInputValue}
          optionNotes={optionNotes}
          inputRef={askInputRef}
          onInput={onAskInput}
          onSubmit={onAskSubmit}
          theme={theme}
        />
      ) : null}
      <CommandOverlayView
        overlay={commandOverlay}
        theme={theme}
        contentWidth={pickerContentWidth}
        maxVisible={pickerMaxVisible}
        onItemClick={onOverlayItemClick}
      />
      <CommandPickerView
        picker={commandPicker}
        theme={theme}
        contentWidth={pickerContentWidth}
        maxVisible={pickerMaxVisible}
        onItemClick={onCommandPickerItemClick}
      />
      <CheckboxPickerView
        picker={checkboxPicker}
        theme={theme}
        contentWidth={pickerContentWidth}
        onItemClick={onCheckboxPickerItemClick}
      />
      <PromptSelectView
        prompt={promptSelect}
        theme={theme}
        contentWidth={pickerContentWidth}
        maxVisible={pickerMaxVisible}
        onItemClick={onPromptSelectItemClick}
      />
      <PromptSecretView
        prompt={promptSecret}
        inputRef={promptSecretInputRef}
        focused={Boolean(promptSecret)}
        onSubmit={onPromptSecretSubmit}
        theme={theme}
      />
      <OAuthOverlayView
        state={oauthOverlay}
        theme={theme}
        contentWidth={pickerContentWidth}
      />
    </>
  );

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.colors.background}
      paddingTop={theme.spacing.screenPaddingY}
      paddingBottom={theme.spacing.screenPaddingY}
      paddingLeft={theme.spacing.screenPaddingX}
      paddingRight={theme.spacing.screenPaddingX}
      gap={0}
      onMouseDown={onBackgroundMouseDown}
    >
      {/* Horizontal tab bar */}
      <HorizontalTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        colors={theme.colors}
      />

      {/* Spacer between tab bar and content */}
      <box height={1} />

      {/* Content area: main column + optional right sidebar */}
      <box flexDirection="row" flexGrow={1} gap={0}>
        {/* Main content column */}
        <box flexDirection="column" flexGrow={1} gap={0}>
          {detailEntry && activeTab?.kind === "detail-thinking" ? (
            /* Detail tabs keep their own scrollbox; InputArea is outside */
            <DetailThinkingTab entry={detailEntry} colors={theme.colors} scrollRef={scrollRef} />
          ) : detailEntry && activeTab?.kind === "detail-tool" ? (
            <DetailToolTab
              entry={detailEntry}
              colors={theme.colors}
              contentWidth={Math.max(20, conversationContentWidth - effectiveSidebarWidth)}
              scrollRef={scrollRef}
            />
          ) : (
            /* Main conversation: single scrollbox wraps entries + status panel + input */
            <ScrollViewport
              colors={theme.colors}
              scrollRef={scrollRef}
              stickyScroll={true}
              stickyStart="bottom"
            >
              <box flexDirection="column" gap={0}>
                <PresentationPanel
                  items={presentationEntries}
                  processing={processing}
                  contentWidth={Math.max(20, conversationContentWidth - effectiveSidebarWidth)}
                  markdownMode={markdownMode}
                  colors={theme.colors}
                  markdownStyle={theme.markdownStyle}
                  selectedChildId={selectedChildId}
                  showLogoInScroll={showLogoInScroll}
                  branding={theme.branding}
                  onEntryClick={onEntryClick}
                  onAgentClick={onAgentClick}
                />

                {/* Spacer between entries and input section */}
                <box height={1} />

                {/* Status panel (agents + todos) */}
                {statusPanel}

                {/* Input area — inside the scrollbox */}
                {inputAreaElement}

                {/* Overlays — inside scrollbox, directly below input */}
                {overlaysBlock}
              </box>
            </ScrollViewport>
          )}
        </box>
        {/* End main content column */}

        {/* Right sidebar */}
        <RightSidebar
          visible={sidebarVisible}
          width={sidebarWidth}
          colors={theme.colors}
          cwd={process.cwd()}
          activeShells={activeShells}
          planSection={sidebarPlanSection}
          contextSection={sidebarContextSection}
          codexSection={sidebarCodexSection}
        />
      </box>
      {/* End content row */}

      {/* For detail tabs: InputArea + overlays stay fixed outside the scrollbox */}
      {isDetailTab ? (
        <>
          <box height={1} />
          {statusPanel}
          {inputAreaElement}
          {overlaysBlock}
        </>
      ) : null}

      {/* Agent list modal (absolute positioned, above everything) */}
      <AgentListModal
        visible={agentListOpen ?? false}
        agents={agentListAgents ?? []}
        selectedIndex={agentListSelectedIndex ?? 0}
        terminalWidth={terminal.width}
        terminalHeight={terminal.height}
        colors={theme.colors}
        onClose={onAgentListClose ?? (() => {})}
        onSelect={onAgentListSelect ?? (() => {})}
      />
    </box>
  );
}
