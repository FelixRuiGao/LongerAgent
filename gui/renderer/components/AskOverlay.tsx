import React, { useCallback, useMemo, useState } from "react";
import { useSession } from "../context";
import { theme, mono, sans } from "../theme";

interface AskOption {
  label: string;
  description?: string;
  kind?: string;
}

interface AskQuestion {
  question: string;
  options: AskOption[];
}

export function AskOverlay(): React.ReactElement {
  const { pendingAsk, resolveAsk } = useSession();

  const questions = useMemo<AskQuestion[]>(() => {
    if (!pendingAsk) return [];
    const raw = (pendingAsk as any).payload?.questions;
    if (Array.isArray(raw)) return raw;
    if (pendingAsk.options && Array.isArray(pendingAsk.options)) {
      return [
        {
          question: pendingAsk.summary || "Choose an option",
          options: pendingAsk.options.map((opt) => ({
            label: typeof opt === "string" ? opt : (opt as any).label,
            description: undefined,
          })),
        },
      ];
    }
    return [];
  }, [pendingAsk]);

  const hasQuestions = questions.length > 0;

  const [selections, setSelections] = useState<Record<number, number>>(() => {
    const init: Record<number, number> = {};
    questions.forEach((_, qi) => {
      init[qi] = 0;
    });
    return init;
  });

  const [customTexts, setCustomTexts] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [freeText, setFreeText] = useState("");

  const handleSelect = useCallback((qi: number, oi: number) => {
    setSelections((prev) => ({ ...prev, [qi]: oi }));
  }, []);

  const handleCustomText = useCallback((qi: number, text: string) => {
    setCustomTexts((prev) => ({ ...prev, [qi]: text }));
  }, []);

  const handleConfirm = useCallback(() => {
    if (!pendingAsk) return;

    if (hasQuestions) {
      const answers = questions.map((q, qi) => {
        const selectedIdx = selections[qi] ?? 0;
        const option = q.options[selectedIdx];
        const isCustom = (option as any)?.kind === "custom_input";
        return {
          questionIndex: qi,
          selectedOptionIndex: selectedIdx,
          answerText: isCustom ? customTexts[qi] ?? "" : undefined,
          note: note || undefined,
        };
      });
      resolveAsk(pendingAsk.id, { answers });
    } else {
      resolveAsk(pendingAsk.id, {
        answers: [{ text: freeText || note || "ok" }],
      });
    }
  }, [pendingAsk, hasQuestions, questions, selections, customTexts, note, freeText, resolveAsk]);

  if (!pendingAsk) return <></>;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.65)",
        fontFamily: sans,
      }}
    >
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.borderHover}`,
          borderRadius: 4,
          maxWidth: 500,
          width: "90%",
          maxHeight: "80vh",
          overflowY: "auto",
          padding: 24,
        }}
      >
        {/* Title */}
        <div
          style={{
            fontFamily: mono,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: theme.accent,
            marginBottom: 4,
          }}
        >
          Decision required
        </div>

        {/* Source info */}
        {(pendingAsk as any).source && (
          <div style={{ fontSize: 11, color: theme.muted, marginBottom: 12, fontFamily: mono }}>
            from{" "}
            <span style={{ color: theme.secondary }}>
              {(pendingAsk as any).source?.agentName ||
                (pendingAsk as any).source?.toolName ||
                "agent"}
            </span>
          </div>
        )}

        {/* Summary */}
        <div
          style={{
            fontSize: 14,
            color: theme.text,
            lineHeight: 1.5,
            marginBottom: 16,
            padding: "10px 12px",
            background: theme.bg,
            borderRadius: 4,
            border: `1px solid ${theme.border}`,
            whiteSpace: "pre-wrap",
          }}
        >
          {pendingAsk.summary}
        </div>

        {/* Structured questions */}
        {hasQuestions &&
          questions.map((q, qi) => (
            <div key={qi} style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: theme.text,
                  marginBottom: 8,
                }}
              >
                {q.question}
              </div>

              {q.options.map((opt, oi) => {
                const isSelected = selections[qi] === oi;
                const isCustom = opt.kind === "custom_input";
                return (
                  <div key={oi} style={{ marginBottom: 4 }}>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        cursor: "pointer",
                        padding: "6px 10px",
                        borderRadius: 4,
                        background: isSelected ? theme.elevated : "transparent",
                        border: `1px solid ${isSelected ? theme.accentBorder : "transparent"}`,
                        transition: "all 100ms ease",
                      }}
                      onClick={() => handleSelect(qi, oi)}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.background = theme.elevated;
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <div
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: "50%",
                          border: `2px solid ${isSelected ? theme.accent : theme.muted}`,
                          marginTop: 2,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {isSelected && (
                          <div
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: theme.accent,
                            }}
                          />
                        )}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: theme.text }}>
                          {opt.label}
                        </div>
                        {opt.description && (
                          <div
                            style={{
                              fontSize: 11,
                              color: theme.muted,
                              marginTop: 2,
                            }}
                          >
                            {opt.description}
                          </div>
                        )}
                      </div>
                    </label>

                    {isCustom && isSelected && (
                      <div style={{ marginTop: 6, paddingLeft: 30 }}>
                        <input
                          type="text"
                          autoFocus
                          placeholder="Type your response..."
                          value={customTexts[qi] ?? ""}
                          onChange={(e) => handleCustomText(qi, e.target.value)}
                          style={{
                            width: "100%",
                            padding: "6px 10px",
                            background: theme.bg,
                            border: `1px solid ${theme.borderHover}`,
                            borderRadius: 4,
                            color: theme.text,
                            fontSize: 13,
                            fontFamily: sans,
                            outline: "none",
                          }}
                          onFocus={(e) => (e.target.style.borderColor = theme.accentBorder)}
                          onBlur={(e) => (e.target.style.borderColor = theme.borderHover)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

        {/* Free-text response */}
        {!hasQuestions && (
          <div style={{ marginBottom: 16 }}>
            <textarea
              autoFocus
              placeholder="Type your response..."
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              rows={3}
              style={{
                width: "100%",
                padding: "8px 10px",
                background: theme.bg,
                border: `1px solid ${theme.borderHover}`,
                borderRadius: 4,
                color: theme.text,
                fontSize: 13,
                fontFamily: sans,
                resize: "vertical",
                outline: "none",
              }}
              onFocus={(e) => (e.target.style.borderColor = theme.accentBorder)}
              onBlur={(e) => (e.target.style.borderColor = theme.borderHover)}
            />
          </div>
        )}

        {/* Note */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 10,
              fontWeight: 500,
              color: theme.muted,
              marginBottom: 4,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Note (optional)
          </div>
          <textarea
            placeholder="Add a note for the agent..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            style={{
              width: "100%",
              padding: "8px 10px",
              background: theme.bg,
              border: `1px solid ${theme.borderHover}`,
              borderRadius: 4,
              color: theme.text,
              fontSize: 13,
              fontFamily: sans,
              resize: "vertical",
              outline: "none",
            }}
            onFocus={(e) => (e.target.style.borderColor = theme.accentBorder)}
            onBlur={(e) => (e.target.style.borderColor = theme.borderHover)}
          />
        </div>

        {/* Confirm button */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={handleConfirm}
            style={{
              padding: "7px 18px",
              borderRadius: 4,
              border: "none",
              background: theme.accent,
              color: theme.bg,
              fontFamily: mono,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.04em",
              cursor: "pointer",
              transition: "opacity 100ms ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
