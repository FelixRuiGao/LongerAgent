/**
 * Configuration management — resolve env vars, auto-detect model
 * capabilities from known lookup tables, build Config from preferences.
 */

import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOAuthAccessToken, hasOAuthTokens } from "./auth/openai-oauth.js";
import { loadGitHubTokens, hasGitHubTokens } from "./auth/github-copilot-oauth.js";
import { getFermiHomeDir } from "./home-path.js";
import {
  findProviderPreset,
  findProviderPresetModel,
  PROVIDER_PRESETS,
} from "./provider-presets.js";
import {
  MANAGED_PROVIDER_CREDENTIAL_SPECS,
  isManagedProvider,
} from "./managed-provider-credentials.js";
import type { AgentModelEntry, LocalProviderConfig, ModelTierEntry } from "./persistence.js";

export { FERMI_HOME_DIR } from "./home-path.js";

// ------------------------------------------------------------------
// Data interfaces
// ------------------------------------------------------------------

export interface ModelConfig {
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  supportsMultimodal: boolean;
  supportsThinking: boolean;
  thinkingBudget: number;
  supportsWebSearch: boolean;
  extra: Record<string, unknown>;
}

export interface ModelConfigEntry {
  name: string;
  provider: string;
  model: string;
  apiKeyRaw: string;
  hasResolvedApiKey: boolean;
}

export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  envAllowlist?: string[];
  sensitiveTools?: string[];
}

// ------------------------------------------------------------------
// Known model lookup tables
// ------------------------------------------------------------------

export const KNOWN_CONTEXT_LENGTHS: Record<string, number> = {
  // OpenAI - GPT-5 family
  "gpt-5.2": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5.5": 1_050_000,
  // Anthropic
  "claude-opus-4-1-20250805": 200_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-5-20251101": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-7": 1_000_000,
  // OpenRouter Anthropic aliases
  "claude-haiku-4.5": 200_000,
  "claude-opus-4.6": 200_000,
  "claude-sonnet-4.6": 200_000,
  "claude-opus-4.7": 1_000_000,
  // Kimi
  "kimi-k2.6": 256_000,
  "kimi-k2.5": 256_000,
  "kimi-k2-instruct": 128_000,
  // GLM (Zhipu AI)
  "glm-5.1": 204_800,
  "glm-5": 200_000,
  "glm-5-turbo": 200_000,
  "glm-5v-turbo": 204_800,
  "glm-4.7": 200_000,
  "glm-4.7-flash": 200_000,
  // MiniMax
  "MiniMax-M2.5": 204_800,
  "MiniMax-M2.5-highspeed": 204_800,
  "MiniMax-M2.7": 204_800,
  "MiniMax-M2.7-highspeed": 204_800,
  // MiniMax — lowercase aliases for OpenRouter (minimax/minimax-m2.5 → minimax-m2.5)
  "minimax-m2.5": 204_800,
  "minimax-m2.7": 204_800,
  // DeepSeek
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  // Xiaomi (MiMo)
  "mimo-v2.5": 1_048_576,
  "mimo-v2.5-pro": 1_048_576,
};

export const KNOWN_MULTIMODAL_MODELS: Set<string> = new Set([
  // OpenAI
  "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5",
  // Anthropic
  "claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4.5", "claude-opus-4.6", "claude-sonnet-4.6",
  "claude-opus-4.7",
  // GLM (Zhipu AI) — vision
  "glm-5v-turbo",
  // Kimi
  "kimi-k2.6",
  "kimi-k2.5",
  // Xiaomi (MiMo) — native omnimodal (vision + audio)
  "mimo-v2.5",
  "mimo-v2.5-pro",
]);

export const KNOWN_THINKING_MODELS: Set<string> = new Set([
  // OpenAI
  "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5",
  // Anthropic
  "claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4.5", "claude-opus-4.6", "claude-sonnet-4.6",
  "claude-opus-4.7",
  // Kimi
  "kimi-k2.6", "kimi-k2.5",
  // GLM
  "glm-5.1", "glm-5", "glm-5-turbo", "glm-5v-turbo", "glm-4.7", "glm-4.7-flash",
  // MiniMax
  "MiniMax-M2.5", "MiniMax-M2.5-highspeed",
  "MiniMax-M2.7", "MiniMax-M2.7-highspeed",
  // MiniMax — lowercase aliases for OpenRouter
  "minimax-m2.5", "minimax-m2.7",
  // DeepSeek
  "deepseek-v4-flash", "deepseek-v4-pro",
  // Xiaomi (MiMo)
  "mimo-v2.5", "mimo-v2.5-pro",
]);

export const KNOWN_NO_WEB_SEARCH_MODELS: Set<string> = new Set([
  // DeepSeek — no native web search tool
  "deepseek-v4-flash", "deepseek-v4-pro",
  // Xiaomi (MiMo) — no native web search tool
  "mimo-v2.5", "mimo-v2.5-pro",
]);

/** Models that support OpenAI's extended 24h prompt cache retention (`prompt_cache_retention: "24h"`). */
export const KNOWN_EXTENDED_CACHE_MODELS: Set<string> = new Set([
  // GPT-5 family
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini", "gpt-5.4-nano",
  "gpt-5.2", "gpt-5.2-codex",
  "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-chat-latest",
  "gpt-5", "gpt-5-codex",
  // GPT-4.1
  "gpt-4.1",
]);

// ------------------------------------------------------------------
// Max output tokens per model
// ------------------------------------------------------------------

export const KNOWN_MAX_OUTPUT_TOKENS: Record<string, number> = {
  // OpenAI — GPT-5 family
  "gpt-5.2": 128_000,
  "gpt-5.2-codex": 128_000,
  "gpt-5.3-codex": 128_000,
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
  "gpt-5.4-nano": 128_000,
  "gpt-5.5": 128_000,
  // Anthropic — Claude 4.7
  "claude-opus-4-7": 128_000,
  // Anthropic — Claude 4.6
  "claude-opus-4-6": 128_000,
  "claude-sonnet-4-6": 64_000,
  // Anthropic — Claude 4.5
  "claude-opus-4-5-20251101": 64_000,
  "claude-sonnet-4-5-20250929": 64_000,
  "claude-haiku-4-5-20251001": 64_000,
  "claude-haiku-4-5": 64_000,
  // Anthropic — Claude 4.1
  "claude-opus-4-1-20250805": 32_000,
  // OpenRouter — Anthropic aliases
  "claude-haiku-4.5": 64_000,
  "claude-opus-4.6": 128_000,
  "claude-sonnet-4.6": 64_000,
  "claude-opus-4.7": 128_000,
  // Kimi
  "kimi-k2.6": 65_536,
  "kimi-k2.5": 65_536,
  "kimi-k2-instruct": 65_536,
  // GLM (Zhipu AI)
  "glm-5.1": 131_072,
  "glm-5": 128_000,
  "glm-5-turbo": 128_000,
  "glm-5v-turbo": 131_072,
  "glm-4.7": 128_000,
  "glm-4.7-flash": 128_000,
  // MiniMax
  "MiniMax-M2.5": 196_608,
  "MiniMax-M2.5-highspeed": 196_608,
  "MiniMax-M2.7": 131_072,
  "MiniMax-M2.7-highspeed": 131_072,
  // MiniMax — lowercase aliases for OpenRouter
  "minimax-m2.5": 196_608,
  "minimax-m2.7": 131_072,
  // DeepSeek
  "deepseek-v4-flash": 384_000,
  "deepseek-v4-pro": 384_000,
  // Xiaomi (MiMo)
  "mimo-v2.5": 131_072,
  "mimo-v2.5-pro": 131_072,
};

/** Resolve max output tokens for a model. Priority: known lookup (exact then normalized) > undefined. */
export function getModelMaxOutputTokens(model: string): number | undefined {
  return KNOWN_MAX_OUTPUT_TOKENS[model]
    ?? KNOWN_MAX_OUTPUT_TOKENS[normalizeModelId(model)];
}

// ------------------------------------------------------------------
// Thinking levels per model
// ------------------------------------------------------------------

export const KNOWN_THINKING_LEVELS: Record<string, string[]> = {
  // OpenAI
  "gpt-5.2":   ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.2-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4":   ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.5":   ["none", "low", "medium", "high", "xhigh"],
  // Anthropic — adaptive + effort (4.6 / 4.7); 4.7 adds the exclusive "xhigh" level
  "claude-opus-4-6":   ["off", "low", "medium", "high", "max"],
  "claude-sonnet-4-6": ["off", "low", "medium", "high"],
  "claude-opus-4-7":   ["off", "low", "medium", "high", "xhigh", "max"],
  "claude-opus-4.6":   ["off", "low", "medium", "high", "max"],
  "claude-sonnet-4.6": ["off", "low", "medium", "high"],
  "claude-opus-4.7":   ["off", "low", "medium", "high", "xhigh", "max"],
  // Anthropic — manual extended thinking (4.5 and earlier)
  "claude-opus-4-1-20250805":   ["off", "low", "medium", "high"],
  "claude-sonnet-4-5-20250929": ["off", "low", "medium", "high"],
  "claude-haiku-4-5-20251001":  ["off", "low", "medium", "high"],
  "claude-haiku-4-5": ["off", "low", "medium", "high"],
  "claude-haiku-4.5": ["off", "low", "medium", "high"],
  "claude-opus-4-5-20251101":   ["off", "low", "medium", "high"],
  // GLM
  "glm-5.1": ["off", "on"], "glm-5": ["off", "on"], "glm-5-turbo": ["off", "on"], "glm-5v-turbo": ["off", "on"],
  "glm-4.7": ["off", "on"], "glm-4.7-flash": ["off", "on"],
  // Kimi
  "kimi-k2.6": ["off", "on"], "kimi-k2.5": ["off", "on"],
  // MiniMax (not configurable)
  "MiniMax-M2.5": ["on"], "MiniMax-M2.5-highspeed": ["on"],
  "MiniMax-M2.7": ["on"], "MiniMax-M2.7-highspeed": ["on"],
  // MiniMax — lowercase aliases for OpenRouter
  "minimax-m2.5": ["on"], "minimax-m2.7": ["on"],
  // DeepSeek — vendor-original three modes (off via thinking.type=disabled, high/max via reasoning_effort)
  "deepseek-v4-flash": ["off", "high", "max"],
  "deepseek-v4-pro": ["off", "high", "max"],
  // Xiaomi (MiMo) — thinking.type enabled/disabled
  "mimo-v2.5": ["off", "on"],
  "mimo-v2.5-pro": ["off", "on"],
};

/** Return available thinking levels for a model, or empty array if not a thinking model. */
export function getThinkingLevels(model: string): string[] {
  return KNOWN_THINKING_LEVELS[model]
    ?? KNOWN_THINKING_LEVELS[normalizeModelId(model)]
    ?? [];
}

/**
 * Tier-eligible thinking levels: native levels with "off" / "none" filtered out.
 *
 * Sub-agent tiers must always have thinking enabled — "off" / "none" defeat the
 * purpose of giving a tier its own configuration. Main-agent flow may still pick
 * "off" / "none" via getThinkingLevels (user override is sovereign there).
 */
export function getTierEligibleThinkingLevels(model: string): string[] {
  return getThinkingLevels(model).filter((l) => l !== "off" && l !== "none");
}

/** Return the highest (last) thinking level for a model, or undefined if not a thinking model. */
export function getHighestThinkingLevel(model: string): string | undefined {
  const levels = getThinkingLevels(model);
  return levels.length > 0 ? levels[levels.length - 1] : undefined;
}

// ------------------------------------------------------------------
// Helper functions
// ------------------------------------------------------------------

/**
 * Strip the vendor prefix from an OpenRouter-style model ID.
 * e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
 * If the model ID contains no "/", it is returned unchanged.
 */
export function normalizeModelId(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/** Format a short user-facing model label for UI surfaces such as the status bar. */
export function formatDisplayModelName(provider: string | undefined, model: string | undefined): string {
  const safeProvider = String(provider ?? "").trim();
  const safeModel = String(model ?? "").trim();
  if (!safeModel) return safeProvider;
  if (safeProvider === "openrouter") {
    return `openrouter/${normalizeModelId(safeModel)}`;
  }
  return safeModel;
}

/** Format a provider-scoped user-facing model label for status messages. */
export function formatScopedModelName(provider: string | undefined, model: string | undefined): string {
  const safeProvider = String(provider ?? "").trim();
  const safeModel = String(model ?? "").trim();
  if (!safeProvider) return formatDisplayModelName(undefined, safeModel);
  if (!safeModel) return safeProvider;
  if (safeProvider === "openrouter") {
    return `openrouter/${normalizeModelId(safeModel)}`;
  }
  return `${safeProvider}/${safeModel}`;
}

/** Resolve effective context length. Priority: explicit > known lookup (exact then normalized) > 0. */
export function getContextLength(model: string, contextLength = 0): number {
  if (contextLength > 0) return contextLength;
  return KNOWN_CONTEXT_LENGTHS[model]
    ?? KNOWN_CONTEXT_LENGTHS[normalizeModelId(model)]
    ?? 0;
}

/** Resolve multimodal support. Priority: explicit > known lookup (exact then normalized) > false. */
export function getMultimodalSupport(model: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return KNOWN_MULTIMODAL_MODELS.has(model)
    || KNOWN_MULTIMODAL_MODELS.has(normalizeModelId(model));
}

/** Resolve thinking/reasoning support. Priority: explicit > known lookup (exact then normalized) > false. */
export function getThinkingSupport(model: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return KNOWN_THINKING_MODELS.has(model)
    || KNOWN_THINKING_MODELS.has(normalizeModelId(model));
}

/** Check whether a model supports OpenAI's extended 24h prompt cache retention. */
export function getExtendedCacheSupport(model: string): boolean {
  return KNOWN_EXTENDED_CACHE_MODELS.has(model)
    || KNOWN_EXTENDED_CACHE_MODELS.has(normalizeModelId(model));
}

/** Resolve native web search support. Priority: explicit > provider default > blacklist > true. */
export function getWebSearchSupport(model: string, explicit?: boolean, provider?: string): boolean {
  if (explicit !== undefined) return explicit;
  // OpenRouter: web search is a paid add-on, default to false.
  // Users can explicitly enable via supports_web_search: true in config.
  if (provider === "openrouter") return false;
  if (KNOWN_NO_WEB_SEARCH_MODELS.has(model)
    || KNOWN_NO_WEB_SEARCH_MODELS.has(normalizeModelId(model))) return false;
  return true;
}

// ------------------------------------------------------------------
// Environment variable resolution
// ------------------------------------------------------------------

function parseEnvRef(value: string): string | null {
  if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
    return value.slice(2, -1);
  }
  return null;
}

function hasResolvableApiKey(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  // OAuth token check
  if (value === "oauth:openai-codex") return hasOAuthTokens();
  if (value === "oauth:copilot") return hasGitHubTokens();
  if (value.startsWith("${") && value.endsWith("}")) {
    const envName = value.slice(2, -1);
    const resolved = process.env[envName];
    return typeof resolved === "string" && resolved.trim() !== "";
  }
  return true;
}

function requireConfigStringField(
  modelConfigName: string,
  cfg: Record<string, unknown>,
  field: string,
): string {
  const raw = cfg[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `Invalid model config '${modelConfigName}': missing required string field '${field}'`,
    );
  }
  return raw;
}

function optionalConfigStringField(
  modelConfigName: string,
  cfg: Record<string, unknown>,
  field: string,
): string | undefined {
  const raw = cfg[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(
      `Invalid model config '${modelConfigName}': field '${field}' must be a string`,
    );
  }
  return raw;
}

function optionalConfigNumberField(
  modelConfigName: string,
  cfg: Record<string, unknown>,
  field: string,
): number | undefined {
  const raw = cfg[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    throw new Error(
      `Invalid model config '${modelConfigName}': field '${field}' must be a number`,
    );
  }
  return raw;
}

function optionalConfigBooleanField(
  modelConfigName: string,
  cfg: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const raw = cfg[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new Error(
      `Invalid model config '${modelConfigName}': field '${field}' must be a boolean`,
    );
  }
  return raw;
}

// ------------------------------------------------------------------
// Config path resolution
// ------------------------------------------------------------------

/**
 * Extension discovery paths across four layers (highest priority first):
 *
 *   workspace  — {cwd}/.fermi/         (checked into repo, shared with team)
 *   project    — ~/.fermi/projects/<hash>/.fermi/  (per-project, not in repo)
 *   global     — ~/.fermi/             (user-wide defaults)
 *   bundled    — package assets        (shipped with fermi)
 */
export interface ResolvedPaths {
  templatesPath: string | null;
  promptsPath: string | null;
  homeDir: string;

  // Four-layer extension discovery roots (each may be null if dir doesn't exist)
  extensions: {
    /** {cwd}/.fermi/ — workspace layer (highest priority) */
    workspace: string | null;
    /** ~/.fermi/projects/<hash>/.fermi/ — project layer */
    project: string | null;
    /** ~/.fermi/ — global layer */
    global: string;
    /** bundled assets dir — bundled layer (lowest priority) */
    bundled: string | null;
  };

  // Convenience: flattened paths for specific extension types
  /** Skills roots ordered by priority: [bundled, global, project, workspace] */
  skillRoots: string[];
  /** Hooks roots ordered by priority: [global, project, workspace] */
  hookRoots: { dir: string; scope: "global" | "project" | "workspace" }[];
  /** Template paths: [bundled, global, project, workspace] — used by loadTemplates */
  templateRoots: string[];
  /** Project .mcp.json path (workspace layer) */
  projectMcpConfigPath: string | null;

  // Legacy compat (used by cli.ts for template loading)
  projectTemplatesPath: string | null;
  projectSkillsPath: string | null;
}

/**
 * Discover extension paths across four layers.
 *
 * Layer priority (highest first):
 *   workspace  — {cwd}/.fermi/
 *   project    — ~/.fermi/projects/<hash>/.fermi/
 *   global     — ~/.fermi/
 *   bundled    — package assets (resolved separately via getBundledAssetsDir)
 */
export function resolveAssetPaths(opts?: {
  templatesFlag?: string;
  projectPath?: string;
}): ResolvedPaths {
  const home = getFermiHomeDir();
  const projectPath = opts?.projectPath ?? process.cwd();

  // Compute project hash dir: ~/.fermi/projects/<name>_<hash>/
  const slug = makeProjectSlug(projectPath);
  const projectStoreDir = join(home, "projects", slug);

  // Four extension layer roots
  const workspaceRoot = join(projectPath, ".fermi");
  const projectRoot = join(projectStoreDir, ".fermi");
  const globalRoot = home;

  const extensions = {
    workspace: isDir(workspaceRoot) ? workspaceRoot : null,
    project: isDir(projectRoot) ? projectRoot : null,
    global: globalRoot,
    bundled: null as string | null, // set by caller from getBundledAssetsDir()
  };

  // --- Templates (legacy: CLI flag > global > cwd) ---
  let templatesPath: string | null = null;
  if (opts?.templatesFlag) {
    templatesPath = isDir(opts.templatesFlag) ? opts.templatesFlag : null;
  } else {
    const homeTemplates = join(home, "agent_templates");
    const cwdTemplates = join(process.cwd(), "agent_templates");
    if (isDir(homeTemplates)) {
      templatesPath = homeTemplates;
    } else if (isDir(cwdTemplates)) {
      templatesPath = cwdTemplates;
    }
  }

  // --- Prompts ---
  let promptsPath: string | null = null;
  if (templatesPath) {
    const siblingPrompts = join(dirname(templatesPath), "prompts");
    if (isDir(siblingPrompts)) promptsPath = siblingPrompts;
  }
  if (!promptsPath) {
    const homePrompts = join(home, "prompts");
    const cwdPrompts = join(process.cwd(), "prompts");
    if (isDir(homePrompts)) promptsPath = homePrompts;
    else if (isDir(cwdPrompts)) promptsPath = cwdPrompts;
  }

  // --- Skills roots (bundled > global > project > workspace) ---
  const skillRoots: string[] = [];
  // bundled added by caller
  const globalSkills = join(globalRoot, "skills");
  if (isDir(globalSkills)) skillRoots.push(globalSkills);
  const projectSkills = join(projectStoreDir, ".fermi", "skills");
  if (isDir(projectSkills)) skillRoots.push(projectSkills);
  const workspaceSkills = join(workspaceRoot, "skills");
  if (isDir(workspaceSkills)) skillRoots.push(workspaceSkills);

  // --- Hooks roots (global > project > workspace) ---
  const hookRoots: { dir: string; scope: "global" | "project" | "workspace" }[] = [];
  const globalHooks = join(globalRoot, "hooks");
  if (isDir(globalHooks)) hookRoots.push({ dir: globalHooks, scope: "global" });
  const projectHooks = join(projectStoreDir, ".fermi", "hooks");
  if (isDir(projectHooks)) hookRoots.push({ dir: projectHooks, scope: "project" });
  const workspaceHooks = join(workspaceRoot, "hooks");
  if (isDir(workspaceHooks)) hookRoots.push({ dir: workspaceHooks, scope: "workspace" });

  // --- Template roots (for loadTemplates layered loading) ---
  const templateRoots: string[] = [];
  // bundled added by caller
  if (templatesPath) templateRoots.push(templatesPath);
  const projectTemplates = join(projectStoreDir, ".fermi", "agent_templates");
  if (isDir(projectTemplates)) templateRoots.push(projectTemplates);
  const workspaceTemplates = join(workspaceRoot, "agent_templates");
  if (isDir(workspaceTemplates)) templateRoots.push(workspaceTemplates);

  // --- Project MCP config ---
  const mcpPath = join(projectPath, ".mcp.json");
  const projectMcpConfigPath = existsSync(mcpPath) ? mcpPath : null;

  // Legacy compat fields
  const projectTemplatesPath = isDir(workspaceTemplates) ? workspaceTemplates : null;
  const projectSkillsPath = isDir(workspaceSkills) ? workspaceSkills : null;

  return {
    templatesPath,
    promptsPath,
    homeDir: home,
    extensions,
    skillRoots,
    hookRoots,
    templateRoots,
    projectMcpConfigPath,
    projectTemplatesPath,
    projectSkillsPath,
  };
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function makeProjectSlug(projectPath: string): string {
  const name = basename(projectPath) || "root";
  const h = createHash("sha256").update(projectPath).digest("hex").slice(0, 6);
  return `${name}_${h}`;
}

// ------------------------------------------------------------------
// Bundled assets path
// ------------------------------------------------------------------

/** Return the root directory of the installed package (parent of dist/). */
export function getBundledAssetsDir(): string {
  // This file compiles to dist/config.js, so ".." reaches the package root.
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "..");
}

// ------------------------------------------------------------------
// Provider default base URLs
// ------------------------------------------------------------------

const PROVIDER_URLS: Record<string, string> = {
  "ollama": "http://localhost:11434/v1",
  "omlx": "http://localhost:8000/v1",
  "lmstudio": "http://localhost:1234/v1",
  "openai-codex": "https://chatgpt.com/backend-api/codex",
  "kimi": "https://api.moonshot.ai/v1",
  "kimi-cn": "https://api.moonshot.cn/v1",
  "kimi-ai": "https://api.moonshot.ai/v1",
  "kimi-code": "https://api.kimi.com/coding/v1",
  "glm": "https://open.bigmodel.cn/api/paas/v4",
  "glm-intl": "https://api.z.ai/api/paas/v4",
  "glm-code": "https://open.bigmodel.cn/api/coding/paas/v4",
  "glm-intl-code": "https://api.z.ai/api/coding/paas/v4",
  "minimax": "https://api.minimax.io/v1",
  "minimax-cn": "https://api.minimaxi.com/v1",
  "deepseek": "https://api.deepseek.com/v1",
  "xiaomi": "https://api.xiaomimimo.com/v1",
  "openrouter": "https://openrouter.ai/api/v1",
};

// ------------------------------------------------------------------
// Config class
// ------------------------------------------------------------------

export class Config {
  private _rawModels: Record<string, Record<string, unknown>> = {};
  private _models: Map<string, ModelConfig> = new Map();
  private _mcpServers: MCPServerConfig[];
  private _modelTiers: { high?: ModelTierEntry; medium?: ModelTierEntry; low?: ModelTierEntry } = {};
  private _agentModels: Record<string, AgentModelEntry> = {};
  private _subAgentInheritMcp: boolean;
  private _subAgentInheritHooks: boolean;

  constructor(opts: {
    providerEnvVars?: Record<string, string>;
    localProviders?: Record<string, LocalProviderConfig>;
    mcpServers?: MCPServerConfig[];
    modelTiers?: { high?: ModelTierEntry; medium?: ModelTierEntry; low?: ModelTierEntry };
    agentModels?: Record<string, AgentModelEntry>;
    subAgentInheritMcp?: boolean;
    subAgentInheritHooks?: boolean;
  }) {
    this._mcpServers = opts.mcpServers ?? [];
    this._agentModels = opts.agentModels ?? {};
    this._modelTiers = opts.modelTiers ?? {};
    this._subAgentInheritMcp = opts.subAgentInheritMcp ?? true;
    this._subAgentInheritHooks = opts.subAgentInheritHooks ?? true;
    this._populateFromPreferences(
      opts.providerEnvVars ?? {},
      opts.localProviders ?? {},
    );
  }

  get subAgentInheritMcp(): boolean {
    return this._subAgentInheritMcp;
  }

  get subAgentInheritHooks(): boolean {
    return this._subAgentInheritHooks;
  }

  /**
   * Populate the raw model map from provider env-var mappings and local server configs.
   * For each configured provider, all preset models are registered.
   * For each local server, a single model entry is registered.
   */
  private _populateFromPreferences(
    providerEnvVars: Record<string, string>,
    localProviders: Record<string, LocalProviderConfig>,
  ): void {
    const preferenceApiKey = (providerId: string, source: string): string => {
      if (
        providerId === "openai-codex"
        && (source === "_OPENAI_CODEX_OAUTH" || source === "oauth:openai-codex")
      ) {
        return "oauth:openai-codex";
      }
      if (
        providerId === "copilot"
        && (source === "_COPILOT_OAUTH" || source === "oauth:copilot")
      ) {
        return "oauth:copilot";
      }
      if (source.startsWith("${") && source.endsWith("}")) {
        return source;
      }
      return `\${${source}}`;
    };

    // Cloud / standard providers
    for (const [providerId, envVar] of Object.entries(providerEnvVars)) {
      const preset = findProviderPreset(providerId);
      if (!preset || preset.localServer || isManagedProvider(providerId)) continue;

      for (const model of preset.models) {
        const name = `${providerId}:${model.key}`;
        this._rawModels[name] = {
          provider: providerId,
          model: model.id,
          api_key: preferenceApiKey(providerId, envVar),
          ...(model.config ?? {}),
        };
      }
    }

    // Managed cloud providers: resolve directly from fixed Fermi env slots.
    for (const spec of MANAGED_PROVIDER_CREDENTIAL_SPECS) {
      const raw = process.env[spec.internalEnvVar];
      if (typeof raw !== "string" || raw.trim() === "") continue;
      const preset = findProviderPreset(spec.providerId);
      if (!preset || preset.localServer) continue;

      for (const model of preset.models) {
        const name = `${spec.providerId}:${model.key}`;
        this._rawModels[name] = {
          provider: spec.providerId,
          model: model.id,
          api_key: preferenceApiKey(spec.providerId, spec.internalEnvVar),
          ...(model.config ?? {}),
        };
      }
    }

    // Local inference servers
    for (const [providerId, local] of Object.entries(localProviders)) {
      const name = `${providerId}:${local.model}`;
      this._rawModels[name] = {
        provider: providerId,
        model: local.model,
        api_key: local.apiKey ?? "local",
        base_url: local.baseUrl,
        context_length: local.contextLength,
        supports_web_search: false,
      };
    }
  }

  private _buildModel(name: string, cfg: Record<string, unknown>): ModelConfig {
    const provider = requireConfigStringField(name, cfg, "provider");
    const modelName = requireConfigStringField(name, cfg, "model");
    const apiKeyRaw = requireConfigStringField(name, cfg, "api_key");
    const baseUrl = optionalConfigStringField(name, cfg, "base_url") || PROVIDER_URLS[provider];
    const apiKeyEnv = parseEnvRef(apiKeyRaw);
    const resolvedApiKey = (() => {
      // OAuth token resolution
      if (apiKeyRaw === "oauth:openai-codex") {
        const token = readOAuthAccessToken();
        if (!token) {
          throw new Error(
            `Missing OAuth token for model config '${name}' (${provider}/${modelName}): ` +
            "no OpenAI OAuth credentials stored.\n" +
            "Run 'fermi oauth' to log in with your ChatGPT account.",
          );
        }
        return token;
      }
      if (apiKeyRaw === "oauth:copilot") {
        // CopilotProvider ignores this value at runtime (it mints short-lived
        // tokens via copilotTokenManager). We just need a non-empty string so
        // downstream SDK construction doesn't fail. Use the stored GitHub OAuth
        // token for parallelism with the Codex branch.
        const gh = loadGitHubTokens();
        if (!gh) {
          throw new Error(
            `Missing OAuth token for model config '${name}' (${provider}/${modelName}): ` +
            "no GitHub Copilot credentials stored.\n" +
            "Run 'fermi oauth' to log in with your GitHub account.",
          );
        }
        return gh.access_token;
      }
      if (!apiKeyEnv) return apiKeyRaw;
      const fromEnv = process.env[apiKeyEnv];
      if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
        return fromEnv;
      }
      throw new Error(
        `Missing API key for model config '${name}' (${provider}/${modelName}): ` +
        `environment variable '${apiKeyEnv}' is not set.\n` +
        "Run 'fermi init' to configure API keys, or export that variable and retry.",
      );
    })();

    const knownKeys = new Set([
      "provider", "model", "api_key", "base_url",
      "temperature", "max_tokens", "context_length",
      "supports_multimodal", "supports_thinking", "thinking_budget",
      "supports_web_search",
    ]);
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (!knownKeys.has(k)) extra[k] = v;
    }

    const explicitCtxLen = optionalConfigNumberField(name, cfg, "context_length") ?? 0;
    const temperature = optionalConfigNumberField(name, cfg, "temperature") ?? 0.7;
    const maxTokens = optionalConfigNumberField(name, cfg, "max_tokens") ?? 32_000;
    const thinkingBudget = optionalConfigNumberField(name, cfg, "thinking_budget") ?? 0;
    const supportsMultimodalOverride = optionalConfigBooleanField(name, cfg, "supports_multimodal");
    const supportsThinkingOverride = optionalConfigBooleanField(name, cfg, "supports_thinking");
    const supportsWebSearchOverride = optionalConfigBooleanField(name, cfg, "supports_web_search");

    return {
      name,
      provider,
      model: modelName,
      apiKey: resolvedApiKey,
      baseUrl,
      temperature,
      maxTokens,
      contextLength: getContextLength(modelName, explicitCtxLen),
      supportsMultimodal: getMultimodalSupport(
        modelName,
        supportsMultimodalOverride,
      ),
      supportsThinking: getThinkingSupport(
        modelName,
        supportsThinkingOverride,
      ),
      thinkingBudget,
      supportsWebSearch: getWebSearchSupport(
        modelName,
        supportsWebSearchOverride,
        provider,
      ),
      extra,
    };
  }

  getModel(name: string): ModelConfig {
    const cached = this._models.get(name);
    if (cached) return cached;

    const raw = this._rawModels[name];
    if (!raw) {
      const available = Object.keys(this._rawModels).join(", ") || "(none)";
      throw new Error(`Model config '${name}' not found. Available: ${available}`);
    }

    const model = this._buildModel(name, raw);
    this._models.set(name, model);
    return model;
  }

  get modelNames(): string[] {
    return Object.keys(this._rawModels);
  }

  /**
   * Return raw model entries without resolving env vars.
   * Useful for UI that needs to show missing API keys instead of throwing.
   */
  listModelEntries(): ModelConfigEntry[] {
    const out: ModelConfigEntry[] = [];
    for (const [name, cfg] of Object.entries(this._rawModels)) {
      const provider = typeof cfg["provider"] === "string" ? cfg["provider"] : "";
      const model = typeof cfg["model"] === "string" ? cfg["model"] : "";
      const apiKeyRaw = typeof cfg["api_key"] === "string" ? cfg["api_key"] : "";
      out.push({
        name,
        provider,
        model,
        apiKeyRaw,
        hasResolvedApiKey: hasResolvableApiKey(apiKeyRaw),
      });
    }
    return out;
  }

  /** Find the first model config name matching provider + model ID exactly. */
  findModelConfigName(provider: string, model: string): string | undefined {
    for (const [name, cfg] of Object.entries(this._rawModels)) {
      if (cfg["provider"] === provider && cfg["model"] === model) {
        return name;
      }
    }
    return undefined;
  }

  /**
   * Insert or replace a raw model config at runtime (in-memory only).
   */
  upsertModelRaw(name: string, cfg: Record<string, unknown>): void {
    this._rawModels[name] = { ...cfg };
    this._models.delete(name);
  }

  /**
   * Return the best default model name.
   * Priority: first with resolvable API key > first model.
   */
  get defaultModel(): string | undefined {
    for (const [name, cfg] of Object.entries(this._rawModels)) {
      const apiKeyRaw = (cfg["api_key"] as string) ?? "";
      if (typeof apiKeyRaw === "string" && apiKeyRaw.startsWith("${") && apiKeyRaw.endsWith("}")) {
        const envName = apiKeyRaw.slice(2, -1);
        if (process.env[envName]) return name;
      } else if (apiKeyRaw) {
        return name;
      }
    }
    const names = Object.keys(this._rawModels);
    return names.length > 0 ? names[0] : undefined;
  }

  get mcpServerConfigs(): MCPServerConfig[] {
    return this._mcpServers;
  }

  // -- Model tiers --

  get modelTiers(): { high?: ModelTierEntry; medium?: ModelTierEntry; low?: ModelTierEntry } {
    return this._modelTiers;
  }

  // -- Agent model pins --

  get agentModels(): Record<string, AgentModelEntry> {
    return this._agentModels;
  }
}
