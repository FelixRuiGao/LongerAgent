import type { DisplayTheme } from "../theme/index.js";

export function getSystemEntryColor(
  severity: "info" | "error" | "compact" | "interrupted" | "sub_agent",
  theme: DisplayTheme,
): string {
  switch (severity) {
    case "error":
      return theme.colors.red;
    case "interrupted":
    case "compact":
    case "info":
      return theme.colors.orange;
    case "sub_agent":
      return theme.colors.dim;
    default:
      return theme.colors.orange;
  }
}

export function getActivityIndicatorColor(
  {
    active,
    error,
  }: {
    active: boolean;
    error: boolean;
  },
  theme: DisplayTheme,
  kind: "thinking" | "tool",
): string {
  if (active) {
    return kind === "thinking"
      ? theme.presentation.thinkingColor
      : theme.presentation.toolNameColor;
  }
  if (error) {
    return theme.presentation.errorColor;
  }
  return theme.presentation.successColor;
}
