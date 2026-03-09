/**
 * Centralized TUI theme.
 *
 * `theme.accent` is the primary brand color used for logo, prompts,
 * headings, and highlights.  Change it at runtime via `setAccent()`.
 * Ink accepts: named colors, "bright" variants, or hex strings like "#7c3aed".
 */

export const DEFAULT_ACCENT = "#4b4bf0";

export const theme = {
  /** Primary brand / accent color used for logo, prompts, headings, highlights. */
  accent: DEFAULT_ACCENT,
};

/** Update the accent color at runtime. */
export function setAccent(color: string): void {
  theme.accent = color;
}

/** Preset accent color options for the /theme picker (ordered by hue). */
export const ACCENT_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Indigo",      value: "#4b4bf0" },
  { label: "Lavender",    value: "#7264B5" },
  { label: "Mauve",       value: "#AF5A85" },
  { label: "Dusty Rose",  value: "#C0596A" },
  { label: "Terracotta",  value: "#C26647" },
  { label: "Gold",        value: "#BE9C37" },
  { label: "Olive",       value: "#759E4C" },
  { label: "Ocean",       value: "#4396B2" },
  { label: "Deep Blue",   value: "#1919E6" },
];
