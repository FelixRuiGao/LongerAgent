import type { ToolCategory } from "./types.js";
import { DEFAULT_DISPLAY_THEME } from "../display/theme/index.js";

export const CATEGORY_COLORS: Record<ToolCategory, string> = DEFAULT_DISPLAY_THEME.presentation.categoryColors;

export const THINKING_COLOR = DEFAULT_DISPLAY_THEME.presentation.thinkingColor;
export const SUCCESS_COLOR = DEFAULT_DISPLAY_THEME.presentation.successColor;
export const ERROR_COLOR = DEFAULT_DISPLAY_THEME.presentation.errorColor;
