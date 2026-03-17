import React, { useEffect, useState } from "react";
import type { PlanCheckpoint } from "../context";
import { useSession } from "../context";
import { theme, mono } from "../theme";

const planPulseKeyframes = `
@keyframes plan-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
`;

export function PlanPanel(): React.ReactElement | null {
  const { planCheckpoints, state } = useSession();
  const [pulse, setPulse] = useState(false);

  const isBusy = state === "thinking" || state === "tool_calling";
  const firstUncheckedIdx = planCheckpoints?.findIndex((c) => !c.checked) ?? -1;

  useEffect(() => {
    if (!isBusy || firstUncheckedIdx < 0) {
      setPulse(false);
      return;
    }
    const timer = setInterval(() => setPulse((p) => !p), 1000);
    return () => clearInterval(timer);
  }, [firstUncheckedIdx, isBusy]);

  if (!planCheckpoints || planCheckpoints.length === 0) return null;

  const done = planCheckpoints.filter((c) => c.checked).length;
  const total = planCheckpoints.length;

  return (
    <>
      <style>{planPulseKeyframes}</style>
      <div
        style={{
          margin: "0 20px 12px",
          border: `1px solid ${theme.accentBorder}`,
          borderRadius: 4,
          backgroundColor: theme.surface,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 14px",
            borderBottom: `1px solid ${theme.border}`,
            backgroundColor: theme.accentDim,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={theme.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="12" height="12" rx="2" />
              <path d="M5 8h6M8 5v6" />
            </svg>
            <span
              style={{
                fontFamily: mono,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: theme.accent,
              }}
            >
              Plan
            </span>
          </div>
          <span
            style={{
              fontFamily: mono,
              fontSize: 11,
              color: theme.secondary,
              fontWeight: 500,
            }}
          >
            {done}/{total}
          </span>
        </div>

        {/* Checkpoints */}
        <div style={{ padding: "6px 8px" }}>
          {planCheckpoints.map((cp, i) => {
            const isCurrent = i === firstUncheckedIdx;
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "5px 6px",
                  borderRadius: 3,
                  backgroundColor: isCurrent ? theme.accentGlow : "transparent",
                }}
              >
                {/* Checkbox indicator */}
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 3,
                    border: `1.5px solid ${cp.checked ? theme.success : isCurrent ? theme.accent : theme.muted}`,
                    backgroundColor: cp.checked ? "rgba(107, 159, 120, 0.15)" : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    marginTop: 1,
                    transition: "all 200ms ease",
                    ...(isCurrent && isBusy ? { animation: "plan-pulse 1.2s ease-in-out infinite" } : {}),
                  }}
                >
                  {cp.checked && (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke={theme.success} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3,8 6.5,11.5 13,5" />
                    </svg>
                  )}
                </div>
                <span
                  style={{
                    fontSize: 12,
                    lineHeight: 1.4,
                    color: cp.checked ? theme.muted : isCurrent ? theme.text : theme.secondary,
                    textDecoration: cp.checked ? "line-through" : "none",
                    fontWeight: isCurrent ? 500 : 400,
                  }}
                >
                  {cp.text}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
