/**
 * Centralized accent color configuration.
 *
 * `theme.accent` is the primary brand color used for logo, prompts,
 * headings, and highlights. Change it at runtime via `setAccent()`.
 * Accepts: named colors, "bright" variants, or hex strings like "#7c3aed".
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
