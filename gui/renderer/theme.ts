/**
 * Theme tokens — "Forge" design system.
 *
 * Warm darks, copper accent, monospace identity.
 * No blue tints, no gradients, no pill shapes.
 */

export const theme = {
  // Backgrounds (warm, not blue-tinted)
  bg: "#131314",
  surface: "#1B1B1D",
  elevated: "#242426",
  input: "#19191B",

  // Text — slightly brighter for improved contrast
  text: "#E8E6E3",
  secondary: "#9B9890",
  muted: "#666360",

  // Accent (warm copper)
  accent: "#CB8A5A",
  accentDim: "rgba(203, 138, 90, 0.12)",
  accentBorder: "rgba(203, 138, 90, 0.30)",
  accentGlow: "rgba(203, 138, 90, 0.06)",

  // Semantic
  success: "#6B9F78",
  error: "#BF6060",
  warning: "#C4A24C",

  // Borders
  border: "rgba(255, 255, 255, 0.06)",
  borderHover: "rgba(255, 255, 255, 0.12)",

  // Legacy aliases (for gradual migration)
  subtext: "#9B9890",
  sidebarBg: "#161617",
  crust: "#111112",
};

export type ThemeTokens = typeof theme;

/** Monospace font stack — identity font */
export const mono =
  "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace";

/**
 * Sans font stack — body text.
 * Uses native system fonts for a crisp, platform-native feel.
 * Avoids Inter/Roboto/Arial — generic AI coding aesthetics.
 */
export const sans =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif";

/** Shadow tokens — minimal, border-first approach */
export const shadows = {
  sidebar: "1px 0 0 rgba(255, 255, 255, 0.04)",
  card: "none",
  inputArea: "0 -1px 0 rgba(255, 255, 255, 0.04)",
  userBubble: "none",
  assistantBubble: "none",
  focusRing: `0 0 0 2px rgba(203, 138, 90, 0.20)`,
  dropdown: "0 4px 16px rgba(0, 0, 0, 0.4)",
  scrollBtn: "0 2px 8px rgba(0, 0, 0, 0.3)",
  insetCode: "none",
};

/**
 * Humanize raw model identifiers into readable display names.
 * Falls back to the raw ID if no mapping is found, but cleans up
 * the provider prefix for better readability.
 */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // Kimi / Moonshot
  "kimi-cn:kimi-k2.5": "Kimi K2.5",
  "kimi-cn:kimi-k2-instruct": "Kimi K2 Instruct",
  "kimi-cn:moonshot-v1-8k": "Moonshot V1 8K",
  "kimi-cn:moonshot-v1-32k": "Moonshot V1 32K",
  "kimi-cn:moonshot-v1-128k": "Moonshot V1 128K",
  // Anthropic
  "anthropic:claude-opus-4-6-20260310": "Claude Opus 4.6",
  "anthropic:claude-sonnet-4-6-20260310": "Claude Sonnet 4.6",
  "anthropic:claude-sonnet-4-20250514": "Claude Sonnet 4",
  "anthropic:claude-opus-4-20250514": "Claude Opus 4",
  "anthropic:claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "anthropic:claude-haiku-3-5-20241022": "Claude Haiku 3.5",
  "anthropic:claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  // OpenAI
  "openai:gpt-4.1": "GPT-4.1",
  "openai:gpt-4.1-mini": "GPT-4.1 Mini",
  "openai:gpt-4.1-nano": "GPT-4.1 Nano",
  "openai:gpt-4o": "GPT-4o",
  "openai:gpt-4o-mini": "GPT-4o Mini",
  "openai:gpt-4-turbo": "GPT-4 Turbo",
  "openai:o3": "O3",
  "openai:o3-mini": "O3 Mini",
  "openai:o4-mini": "O4 Mini",
  "openai:o1": "O1",
  "openai:o1-mini": "O1 Mini",
  // Google
  "google:gemini-2.5-pro": "Gemini 2.5 Pro",
  "google:gemini-2.5-flash": "Gemini 2.5 Flash",
  "google:gemini-2.0-flash": "Gemini 2.0 Flash",
  // DeepSeek
  "deepseek:deepseek-chat": "DeepSeek V3",
  "deepseek:deepseek-reasoner": "DeepSeek R1",
  // GLM
  "glm:glm-4-plus": "GLM-4 Plus",
  "glm:glm-4": "GLM-4",
  // MiniMax
  "minimax:minimax-text-01": "MiniMax Text 01",
  // Qwen
  "qwen:qwen-max": "Qwen Max",
  "qwen:qwen-plus": "Qwen Plus",
  "qwen:qwen-turbo": "Qwen Turbo",
};

/**
 * Known model slug fragments → readable labels.
 * Order matters: first match wins, so put longer/more specific patterns first.
 */
const SLUG_FRAGMENTS: [RegExp, string][] = [
  // Kimi / Moonshot
  [/kimi-k2[.-]?5/i, "Kimi K2.5"],
  [/kimi-k2-instruct/i, "Kimi K2 Instruct"],
  [/kimi-k2/i, "Kimi K2"],
  [/moonshot-v1-128k/i, "Moonshot V1 128K"],
  [/moonshot-v1-32k/i, "Moonshot V1 32K"],
  [/moonshot-v1-8k/i, "Moonshot V1 8K"],
  // Anthropic
  [/claude-opus-4-6/i, "Claude Opus 4.6"],
  [/claude-sonnet-4-6/i, "Claude Sonnet 4.6"],
  [/claude-sonnet-4\b/i, "Claude Sonnet 4"],
  [/claude-opus-4\b/i, "Claude Opus 4"],
  [/claude-haiku-4-5/i, "Claude Haiku 4.5"],
  [/claude-haiku-3-5/i, "Claude Haiku 3.5"],
  [/claude-3-5-sonnet/i, "Claude 3.5 Sonnet"],
  // OpenAI
  [/gpt-4\.1-nano/i, "GPT-4.1 Nano"],
  [/gpt-4\.1-mini/i, "GPT-4.1 Mini"],
  [/gpt-4\.1\b/i, "GPT-4.1"],
  [/gpt-4o-mini/i, "GPT-4o Mini"],
  [/gpt-4o\b/i, "GPT-4o"],
  [/gpt-4-turbo/i, "GPT-4 Turbo"],
  [/o4-mini/i, "O4 Mini"],
  [/o3-mini/i, "O3 Mini"],
  [/\bo3\b/i, "O3"],
  [/\bo1-mini/i, "O1 Mini"],
  [/\bo1\b/i, "O1"],
  // Google
  [/gemini-2\.5-pro/i, "Gemini 2.5 Pro"],
  [/gemini-2\.5-flash/i, "Gemini 2.5 Flash"],
  [/gemini-2\.0-flash/i, "Gemini 2.0 Flash"],
  // DeepSeek
  [/deepseek-reasoner/i, "DeepSeek R1"],
  [/deepseek-chat/i, "DeepSeek V3"],
  [/deepseek-r1/i, "DeepSeek R1"],
  [/deepseek-v3/i, "DeepSeek V3"],
  // GLM
  [/glm-5-turbo/i, "GLM-5 Turbo"],
  [/glm-5\b/i, "GLM-5"],
  [/glm-4\.7/i, "GLM-4.7"],
  [/glm-4-plus/i, "GLM-4 Plus"],
  [/glm-4\b/i, "GLM-4"],
  // MiniMax
  [/minimax-m2\.5/i, "MiniMax M2.5"],
  [/minimax-m2\.1/i, "MiniMax M2.1"],
  [/minimax-text-01/i, "MiniMax Text 01"],
  // Qwen
  [/qwen-max/i, "Qwen Max"],
  [/qwen-plus/i, "Qwen Plus"],
  [/qwen-turbo/i, "Qwen Turbo"],
  // Llama
  [/llama-3\.3-70b/i, "Llama 3.3 70B"],
  [/llama-3\.1-405b/i, "Llama 3.1 405B"],
  [/llama-3\.1-70b/i, "Llama 3.1 70B"],
  // Mistral
  [/mistral-large/i, "Mistral Large"],
  [/mistral-medium/i, "Mistral Medium"],
  [/codestral/i, "Codestral"],
];

export function humanModelName(raw: string): string {
  // Exact match first
  if (MODEL_DISPLAY_NAMES[raw]) return MODEL_DISPLAY_NAMES[raw];

  // Strip provider prefix for colon-separated format
  const colonIdx = raw.indexOf(":");
  const withoutProvider = colonIdx > 0 ? raw.slice(colonIdx + 1) : raw;
  if (colonIdx > 0 && MODEL_DISPLAY_NAMES[raw]) return MODEL_DISPLAY_NAMES[raw];

  // Strip "openrouter/" prefix for cleaner display
  const cleanedForMatch = raw.replace(/^openrouter\//i, "");

  // Fuzzy match against known slug fragments
  for (const [pattern, label] of SLUG_FRAGMENTS) {
    if (pattern.test(raw) || pattern.test(cleanedForMatch)) return label;
  }

  // Fallback: clean up runtime / openrouter prefixes and humanize
  let cleaned = withoutProvider;
  cleaned = cleaned.replace(/^runtime-/i, "");
  cleaned = cleaned.replace(/^openrouter-/i, "");
  // For local servers: strip "vendor/" prefix (e.g., "qwen/qwen3.5-9b" → "qwen3.5-9b")
  if (cleaned.includes("/")) {
    cleaned = cleaned.split("/").pop() || cleaned;
  }
  // Remove known provider prefixes from the slug
  cleaned = cleaned.replace(/^(moonshotai|anthropic|openai|google|deepseek|meta|mistralai|qwen)-/i, "");
  // Strip trailing date stamps like -20260310
  cleaned = cleaned.replace(/-\d{8}$/, "");
  // Convert hyphens to spaces and title-case (with known uppercase acronyms)
  const UPPERCASE_WORDS: Record<string, string> = { gpt: "GPT", glm: "GLM", api: "API" };
  cleaned = cleaned
    .split("-")
    .map((w) => UPPERCASE_WORDS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return cleaned;
}

export function extractProvider(raw: string): string {
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) return raw.slice(0, colonIdx);
  return "";
}

/** Provider display info — label and brand color for model picker */
export const PROVIDER_INFO: Record<string, { label: string; color: string }> = {
  anthropic: { label: "Anthropic", color: "#D4A574" },
  openai: { label: "OpenAI", color: "#74AA9C" },
  google: { label: "Google", color: "#669DF6" },
  deepseek: { label: "DeepSeek", color: "#5B9BD5" },
  "kimi-cn": { label: "Moonshot", color: "#E8913A" },
  kimi: { label: "Moonshot", color: "#E8913A" },
  "kimi-ai": { label: "Moonshot", color: "#E8913A" },
  moonshot: { label: "Moonshot", color: "#E8913A" },
  glm: { label: "GLM", color: "#6B8E23" },
  minimax: { label: "MiniMax", color: "#9370DB" },
  qwen: { label: "Qwen", color: "#FF6B6B" },
  openrouter: { label: "OpenRouter", color: "#8B5CF6" },
  ollama: { label: "Ollama", color: "#FFFFFF" },
  "lm-studio": { label: "LM Studio", color: "#10B981" },
  lmstudio: { label: "LM Studio", color: "#10B981" },
  omlx: { label: "oMLX", color: "#F59E0B" },
  meta: { label: "Meta", color: "#0668E1" },
  mistral: { label: "Mistral", color: "#FF7000" },
};

/** Format a token count with 1 decimal for k/M */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
