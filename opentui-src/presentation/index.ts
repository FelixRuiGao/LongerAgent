export type {
  PresentationKind,
  PresentationState,
  PresentationEntry,
  ToolCategory,
  InlineResultData,
} from "./types.js";

export { CATEGORY_COLORS, THINKING_COLOR, SUCCESS_COLOR, ERROR_COLOR } from "./colors.js";
export { getToolProfile, TOOL_PROFILES, HIDDEN_TOOLS } from "./tool-profiles.js";
export type { ToolDisplayProfile } from "./tool-profiles.js";
export { presentationTransform } from "./transform.js";
export { usePresentationEntries } from "./use-presentation.js";
export {
  useSpinner,
  THINKING_SPINNER_FRAMES,
  THINKING_SPINNER_INTERVAL,
  TOOL_SPINNER_FRAMES,
  TOOL_SPINNER_INTERVAL,
} from "./use-spinner.js";
export { useShimmer } from "./use-shimmer.js";
export { useTurnTimer, formatElapsed } from "./use-turn-timer.js";
