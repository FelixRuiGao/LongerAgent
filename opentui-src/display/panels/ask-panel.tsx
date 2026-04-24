/** @jsxImportSource @opentui/react */

import React from "react";

import type { AgentQuestionItem } from "../../../src/ask.js";
import type { DisplayTheme } from "../theme/index.js";
import type { AskPanelProps } from "../types.js";
import { PanelSurface } from "../primitives/panel-surface.js";

export function AskPanelView({
  ask,
  error,
  selectedIndex,
  currentQuestionIndex,
  totalQuestions,
  questionAnswers,
  customInputMode,
  noteInputMode,
  reviewMode,
  inlineValue,
  optionNotes,
  inputRef,
  onInput,
  onSubmit,
  theme,
}: AskPanelProps & { theme: DisplayTheme }): React.ReactNode {
  if (ask.kind === "approval") {
    const options = ask.options ?? [];
    const panelHeight = 2 + options.length + 1 + (error ? 1 : 0) + 2;
    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing} height={panelHeight}>
        <text fg={theme.colors.yellow} content={`⚠ ${ask.summary}`} />
        <text content="" />
        {options.map((label, index) => {
          const isSelected = index === selectedIndex;
          const isDeny = label === "Deny";
          return (
            <text
              key={`approval-opt-${index}`}
              fg={isSelected ? (isDeny ? theme.colors.red : theme.colors.accent) : theme.colors.text}
              content={`${isSelected ? "> " : "  "}${label}`}
            />
          );
        })}
        <text fg={theme.colors.dim} content="Use ↑/↓ to select, Enter to confirm." />
        {error ? <text fg={theme.colors.red} content={error} /> : null}
      </PanelSurface>
    );
  }

  if (ask.kind !== "agent_question") {
    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing}>
        <text fg={theme.colors.red} content={`Unsupported ask kind: ${ask.kind}`} />
        <text content={ask.summary} />
        {error ? <text fg={theme.colors.red} content={error} /> : null}
      </PanelSurface>
    );
  }

  const questions = (ask.payload["questions"] as AgentQuestionItem[]) ?? [];

  if (reviewMode) {
    const reviewContentLines =
      1 +
      questions.reduce((total, question, index) => {
        const answer = questionAnswers.get(index);
        const noteKey = answer ? `${index}-${answer.optionIndex}` : "";
        const note = noteKey ? optionNotes.get(noteKey) : undefined;
        return total + 2 + (note ? 1 : 0);
      }, 0) +
      1 +
      (error ? 1 : 0);
    const panelHeight = reviewContentLines + 2;

    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing} height={panelHeight}>
        <text fg={theme.colors.green} content="Review your answers" />
        {questions.map((question, index) => {
          const answer = questionAnswers.get(index);
          const selected = answer ? question.options[answer.optionIndex] : undefined;
          const answerDisplay = !answer
            ? "(unanswered)"
            : selected?.kind === "custom_input"
              ? `✎ ${answer.customText ?? ""}`
              : selected?.label ?? "(unknown)";
          const noteKey = answer ? `${index}-${answer.optionIndex}` : "";
          const note = noteKey ? optionNotes.get(noteKey) : undefined;
          return (
            <box key={`ask-review-${index}`} flexDirection="column">
              <text content={`${index + 1}. ${question.question}`} />
              <text fg={!answer ? theme.colors.yellow : selected?.kind === "discuss_further" ? theme.colors.yellow : theme.colors.green} content={`   → ${answerDisplay}`} />
              {note ? <text fg={theme.colors.yellow} content={`     Note: ${note}`} /> : null}
            </box>
          );
        })}
        <text fg={theme.colors.dim} content="Enter to submit. Esc to go back." />
        {error ? <text fg={theme.colors.red} content={error} /> : null}
      </PanelSurface>
    );
  }

  const question = questions[currentQuestionIndex];
  if (!question) {
    return (
      <PanelSurface colors={theme.colors} spacing={theme.spacing}>
        <text fg={theme.colors.red} content="Question index out of range." />
      </PanelSurface>
    );
  }

  const existingAnswer = questionAnswers.get(currentQuestionIndex);
  const agentOptionCount = question.options.filter((option) => !option.systemAdded).length;
  const optionContentLines = question.options.reduce((total, option, index) => {
    const note = !option.systemAdded ? optionNotes.get(`${currentQuestionIndex}-${index}`) : undefined;
    return total + 1 + (option.description ? 1 : 0) + (note ? 1 : 0);
  }, 0);
  const inlineLines = customInputMode || noteInputMode ? 3 : 0;
  const panelContentLines = 1 + optionContentLines + inlineLines + 1 + (error ? 1 : 0);
  const panelHeight = panelContentLines + 2;

  return (
    <PanelSurface colors={theme.colors} spacing={theme.spacing} height={panelHeight}>
      <text fg={theme.colors.yellow} content={`Question ${currentQuestionIndex + 1}/${totalQuestions}: ${question.question}`} />
      {question.options.map((option, index) => {
        const isSelected = index === selectedIndex;
        const isAnswered = existingAnswer?.optionIndex === index;
        const note = !option.systemAdded ? optionNotes.get(`${currentQuestionIndex}-${index}`) : undefined;
        return (
          <box key={`ask-option-${index}`} flexDirection="column">
            <text
              fg={isSelected ? theme.colors.accent : isAnswered ? theme.colors.green : theme.colors.text}
              content={`${isSelected ? "> " : isAnswered ? "✓ " : "  "}${option.label}`}
            />
            {option.description ? <text fg={theme.colors.dim} content={`   ${option.description}`} /> : null}
            {note ? <text fg={theme.colors.yellow} content={`   Note: ${note}${isSelected ? " (Tab to edit)" : ""}`} /> : null}
          </box>
        );
      })}
      {customInputMode || noteInputMode ? (
        <box flexDirection="column">
          <text fg={customInputMode ? theme.colors.accent : theme.colors.yellow} content={customInputMode ? "Your answer:" : "Note:"} />
          <input
            ref={(node) => {
              inputRef.current = node;
            }}
            value={inlineValue}
            focused={customInputMode || noteInputMode}
            placeholder={customInputMode ? "Type a custom answer" : "Add a note"}
            textColor={theme.colors.text}
            focusedTextColor={theme.colors.text}
            placeholderColor={theme.colors.dim}
            onInput={onInput}
            onChange={onInput}
            onSubmit={onSubmit as any}
          />
          <text
            fg={theme.colors.dim}
            content={customInputMode ? "Enter to confirm. Esc to cancel." : "Enter to save note. Esc to cancel."}
          />
        </box>
      ) : null}
      <text
        fg={theme.colors.dim}
        content={`Use ↑/↓ to select, ←/→ to navigate questions, Enter to confirm.${agentOptionCount > 0 && selectedIndex < agentOptionCount ? " Tab to add note." : ""}`}
      />
      {error ? <text fg={theme.colors.red} content={error} /> : null}
    </PanelSurface>
  );
}
