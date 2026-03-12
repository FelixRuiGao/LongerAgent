import { normalizeModelId } from "../config.js";
import {
  findProviderPreset,
  findProviderPresetModel,
} from "../provider-presets.js";

const PROVIDER_LABEL_OVERRIDES: Record<string, string> = {
  "anthropic": "Anthropic",
  "openai": "OpenAI",
  "openai-codex": "OpenAI Codex",
  "openrouter": "OpenRouter",
  "moonshotai": "Kimi",
  "kimi-ai": "Kimi Global",
  "z-ai": "GLM",
};

const MODEL_LABEL_OVERRIDES: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-6": "Opus 4.6",
  "gpt-5-2": "GPT-5.2",
  "gpt-5-2-codex": "GPT-5.2 Codex",
  "gpt-5-3-codex": "GPT-5.3 Codex",
  "gpt-5-4": "GPT-5.4",
  "kimi-k2-5": "Kimi K2.5",
  "kimi-k2-instruct": "Kimi K2 Instruct",
  "glm-5": "GLM 5",
  "glm-4-7": "GLM 4.7",
  "glm-4-7-flash": "GLM 4.7 Flash",
  "minimax-m2-1": "MiniMax M2.1",
  "minimax-m2-5": "MiniMax M2.5",
  "minimax-m1": "MiniMax M1",
};

function canonicalizeModelKey(model: string): string {
  return normalizeModelId(model)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanizeProvider(provider: string): string {
  return provider
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatProviderLabel(provider: string): string {
  const preset = findProviderPreset(provider);
  if (preset?.subLabel) {
    return preset.subLabel.replace(/-/g, " ");
  }
  return PROVIDER_LABEL_OVERRIDES[provider] ?? humanizeProvider(provider);
}

function compactPresetLabel(label: string): string {
  return label
    .replace(/^Claude\s+/i, "")
    .replace(/^GLM[-\s]+/i, "GLM ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatModelLabel(provider: string | undefined, model: string): string {
  const override = MODEL_LABEL_OVERRIDES[canonicalizeModelKey(model)];
  if (override) return override;

  if (provider) {
    const presetModel = findProviderPresetModel(provider, model);
    if (presetModel?.label) {
      return compactPresetLabel(presetModel.label);
    }
  }

  const normalized = normalizeModelId(model).trim();
  return MODEL_LABEL_OVERRIDES[canonicalizeModelKey(normalized)] ?? normalized;
}

export function formatStatusBarModelName(
  provider: string | undefined,
  model: string | undefined,
): string {
  const safeProvider = String(provider ?? "").trim();
  const safeModel = String(model ?? "").trim();

  if (!safeProvider) {
    return safeModel ? formatModelLabel(undefined, safeModel) : "";
  }

  const providerLabel = formatProviderLabel(safeProvider);
  if (!safeModel) return providerLabel;

  return `${providerLabel}/${formatModelLabel(safeProvider, safeModel)}`;
}
