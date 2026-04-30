/**
 * Context management thresholds and hysteresis computation.
 *
 * Thresholds are fixed defaults — no longer loaded from settings.json.
 * The user controls effective context size via the contextRatio
 * preference (stored in tui-preferences.json).
 */

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface ContextThresholds {
  /** Context hint level 1 trigger (percentage of effective context budget). */
  context_hint_level1: number;
  /** Context hint level 2 trigger (percentage, must be >= level1). */
  context_hint_level2: number;
  /** Auto-compact trigger on normal output (percentage). */
  compact_output: number;
  /** Auto-compact trigger when tool calls present (percentage, must be >= compact_output). */
  compact_toolcall: number;
}

// ------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------

export const DEFAULT_THRESHOLDS: ContextThresholds = {
  context_hint_level1: 60,
  context_hint_level2: 80,
  compact_output: 85,
  compact_toolcall: 90,
};

// ------------------------------------------------------------------
// Derived hysteresis thresholds
// ------------------------------------------------------------------

/**
 * Compute hysteresis reset thresholds from trigger thresholds.
 * These are not user-configurable; they are auto-derived.
 */
export function computeHysteresisThresholds(t: ContextThresholds): {
  hintResetNone: number;
  hintResetLevel1: number;
} {
  return {
    hintResetNone: t.context_hint_level1 - 20,
    hintResetLevel1: (t.context_hint_level1 + t.context_hint_level2) / 2,
  };
}
