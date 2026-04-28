/**
 * Session persistence — log-native session storage on disk.
 *
 * Storage layout:
 *
 *   <base_dir>/
 *   └── projects/
 *       ├── <project_slug>/           # <dir_name>_<sha256[:6]>
 *       │   ├── project.json
 *       │   ├── 20260212_143052_chat/
 *       │   │   ├── log.json
 *       │   │   └── artifacts/
 *       │   └── ...
 *       └── general/                  # sessions without a project path
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getFermiHomeDir } from "./home-path.js";
import { LogIdAllocator, type LogEntry, type LogEntryType, type TuiDisplayKind } from "./log-entry.js";
import type { ChildSessionMetaRecord } from "./session-tree-types.js";
import { parseJsonc } from "./jsonc.js";
import type { MCPServerConfig } from "./config.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const GLOBAL_TUI_PREFERENCES_FILE = "tui-preferences.json";
const SETTINGS_FILE = "settings.json";
const STATE_DIR = "state";
const MODEL_SELECTION_FILE = "model-selection.json";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function projectSlug(projectPath: string): string {
  const name = basename(projectPath) || "root";
  const h = createHash("sha256").update(projectPath).digest("hex").slice(0, 6);
  return `${name}_${h}`;
}

function resolvePreferredBaseDir(baseDir?: string): string {
  if (baseDir) return baseDir.replace(/^~/, homedir());
  return getFermiHomeDir();
}

function resolveSessionTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatLocalIso(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absOffset / 60));
  const offsetMins = pad(absOffset % 60);
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
    `${sign}${offsetHours}:${offsetMins}`,
  ].join("");
}

function toLocalIsoFromUtc(utcIso: string): string {
  if (!utcIso) return "";
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return "";
  return formatLocalIso(new Date(ms));
}

function nowTimestamps(): {
  utcIso: string;
  localIso: string;
  epochMs: number;
  timeZone: string;
} {
  const now = new Date();
  return {
    utcIso: now.toISOString(),
    localIso: formatLocalIso(now),
    epochMs: now.getTime(),
    timeZone: resolveSessionTimezone(),
  };
}

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    "_",
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
  ].join("");
}

// ------------------------------------------------------------------
// SessionStore
// ------------------------------------------------------------------

export class SessionStore {
  private _projectPath: string | undefined;
  private _projectSlug: string;
  private _preferredBaseDir: string;
  private _activeBaseDir: string | undefined;
  private _projectDir: string;
  private _sessionDir: string | undefined;
  private _predictedSessionDir: string | undefined;

  constructor(opts?: { projectPath?: string; baseDir?: string }) {
    this._projectPath = opts?.projectPath;
    this._projectSlug = opts?.projectPath
      ? projectSlug(opts.projectPath)
      : "general";
    this._preferredBaseDir = resolvePreferredBaseDir(opts?.baseDir);
    this._projectDir = join(this._preferredBaseDir, "projects", this._projectSlug);
  }

  // -- lifecycle --

  private _candidateBaseDirs(): string[] {
    const candidates = [
      this._preferredBaseDir,
      join(tmpdir(), "fermi", "sessions"),
    ];
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const c of candidates) {
      if (seen.has(c)) continue;
      seen.add(c);
      dedup.push(c);
    }
    return dedup;
  }

  private _ensureProjectMetadata(projectDir: string): void {
    const projectJson = join(projectDir, "project.json");
    if (existsSync(projectJson)) return;
    const now = nowTimestamps().utcIso;
    writeFileSync(
      projectJson,
      JSON.stringify(
        {
          original_path: this._projectPath ?? "",
          created_at: now,
          last_active_at: now,
        },
        null,
        2,
      ),
    );
  }

  private _globalPreferenceBaseDirs(): string[] {
    const candidates = [
      this._activeBaseDir,
      ...this._candidateBaseDirs(),
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const c of candidates) {
      if (seen.has(c)) continue;
      seen.add(c);
      dedup.push(c);
    }
    return dedup;
  }

  private _globalPreferencesPath(baseDir: string): string {
    return join(baseDir, GLOBAL_TUI_PREFERENCES_FILE);
  }

  private static _findUniqueSessionDir(projectDir: string): string {
    const ts = timestampSlug();
    const first = join(projectDir, `${ts}_chat`);
    if (!existsSync(first)) {
      return first;
    }
    for (let idx = 1; idx < 1000; idx++) {
      const candidate = join(projectDir, `${ts}_${String(idx).padStart(3, "0")}_chat`);
      if (existsSync(candidate)) continue;
      return candidate;
    }
    throw new Error("Failed to allocate a unique session directory.");
  }

  createSession(): string {
    const errors: string[] = [];

    for (const baseDir of this._candidateBaseDirs()) {
      const projectDir = join(baseDir, "projects", this._projectSlug);
      try {
        mkdirSync(projectDir, { recursive: true });
        this._ensureProjectMetadata(projectDir);
        let sessionDir = this._predictedSessionDir;
        if (!sessionDir || dirname(sessionDir) !== projectDir || existsSync(sessionDir)) {
          sessionDir = SessionStore._findUniqueSessionDir(projectDir);
        }
        mkdirSync(sessionDir, { recursive: true });
        mkdirSync(join(sessionDir, "artifacts"), { recursive: true });

        // Ensure global AGENTS.md exists (fallback for users who skipped init wizard)
        const globalAgentsMd = join(baseDir, "AGENTS.md");
        if (!existsSync(globalAgentsMd)) {
          try { writeFileSync(globalAgentsMd, ""); } catch { /* non-critical */ }
        }

        this._activeBaseDir = baseDir;
        this._projectDir = projectDir;
        this._sessionDir = sessionDir;
        this._predictedSessionDir = undefined;

        if (baseDir !== this._preferredBaseDir) {
          console.warn(
            `SessionStore fallback active: preferred '${this._preferredBaseDir}' not writable, using '${baseDir}'`,
          );
        }
        return sessionDir;
      } catch (exc) {
        errors.push(`${baseDir}: ${exc}`);
        continue;
      }
    }

    const detail = errors.length > 0 ? errors.join(" | ") : "no candidate paths available";
    throw new Error(`Unable to create session storage directory. Tried: ${detail}`);
  }

  /** Clear the current session directory (used by /new to defer creation). */
  clearSession(): void {
    this._sessionDir = undefined;
    this._predictedSessionDir = undefined;
  }

  captureBindingState(): {
    activeBaseDir: string | undefined;
    projectDir: string;
    sessionDir: string | undefined;
    predictedSessionDir: string | undefined;
  } {
    return {
      activeBaseDir: this._activeBaseDir,
      projectDir: this._projectDir,
      sessionDir: this._sessionDir,
      predictedSessionDir: this._predictedSessionDir,
    };
  }

  restoreBindingState(state: {
    activeBaseDir: string | undefined;
    projectDir: string;
    sessionDir: string | undefined;
    predictedSessionDir: string | undefined;
  }): void {
    this._activeBaseDir = state.activeBaseDir;
    this._projectDir = state.projectDir;
    this._sessionDir = state.sessionDir;
    this._predictedSessionDir = state.predictedSessionDir;
  }

  attachToExistingSession(sessionDir: string): void {
    this._sessionDir = sessionDir;
    this._predictedSessionDir = undefined;
    this._projectDir = dirname(sessionDir);

    const projectsDir = dirname(this._projectDir);
    if (basename(projectsDir) === "projects") {
      this._activeBaseDir = dirname(projectsDir);
    }
  }

  predictNextSessionDir(): string {
    if (this._sessionDir) return this._sessionDir;
    if (this._predictedSessionDir) return this._predictedSessionDir;

    const errors: string[] = [];
    for (const baseDir of this._candidateBaseDirs()) {
      const projectDir = join(baseDir, "projects", this._projectSlug);
      try {
        mkdirSync(projectDir, { recursive: true });
        this._ensureProjectMetadata(projectDir);
        const sessionDir = SessionStore._findUniqueSessionDir(projectDir);
        this._activeBaseDir = baseDir;
        this._projectDir = projectDir;
        this._predictedSessionDir = sessionDir;
        return sessionDir;
      } catch (exc) {
        errors.push(`${baseDir}: ${exc}`);
      }
    }

    const detail = errors.length > 0 ? errors.join(" | ") : "no candidate paths available";
    throw new Error(`Unable to predict session storage directory. Tried: ${detail}`);
  }

  predictNextArtifactsDir(): string {
    return join(this.predictNextSessionDir(), "artifacts");
  }

  loadGlobalPreferences(): GlobalTuiPreferences {
    for (const baseDir of this._globalPreferenceBaseDirs()) {
      const path = this._globalPreferencesPath(baseDir);
      if (!existsSync(path)) continue;
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        return createGlobalTuiPreferences({
          version: raw.version ?? 1,
          modelConfigName: raw.model_config_name ?? undefined,
          modelProvider: raw.model_provider ?? undefined,
          modelSelectionKey: raw.model_selection_key ?? undefined,
          modelId: raw.model_id ?? undefined,
          thinkingLevel: raw.thinking_level ?? "",
          accentColor: raw.accent_color ?? undefined,
          disabledSkills: Array.isArray(raw.disabled_skills) ? raw.disabled_skills : undefined,
          providerEnvVars: raw.provider_env_vars ?? undefined,
          localProviders: raw.local_providers ?? undefined,
          contextRatio: typeof raw.context_ratio === "number" ? raw.context_ratio : undefined,
        });
      } catch {
        continue;
      }
    }
    return createGlobalTuiPreferences();
  }

  saveGlobalPreferences(preferences: GlobalTuiPreferences): void {
    const payload = createGlobalTuiPreferences(preferences);
    const errors: string[] = [];

    for (const baseDir of this._globalPreferenceBaseDirs()) {
      try {
        mkdirSync(baseDir, { recursive: true });
        const file = this._globalPreferencesPath(baseDir);
        const tmp = file + ".tmp";
        writeFileSync(
          tmp,
          JSON.stringify({
            version: payload.version,
            model_config_name: payload.modelConfigName ?? null,
            model_provider: payload.modelProvider ?? null,
            model_selection_key: payload.modelSelectionKey ?? null,
            model_id: payload.modelId ?? null,
            thinking_level: payload.thinkingLevel,
            accent_color: payload.accentColor ?? null,
            disabled_skills: payload.disabledSkills ?? null,
            provider_env_vars: payload.providerEnvVars ?? null,
            local_providers: payload.localProviders ?? null,
            context_ratio: payload.contextRatio ?? null,
          }, null, 2),
        );
        renameSync(tmp, file);
        this._activeBaseDir = baseDir;
        return;
      } catch (exc) {
        errors.push(`${baseDir}: ${exc}`);
      }
    }

    const detail = errors.length > 0 ? errors.join(" | ") : "no writable base directory available";
    throw new Error(`Unable to save TUI preferences. Tried: ${detail}`);
  }

  listSessions(): Array<{ path: string; created: string; lastActiveAt: string; summary: string; title?: string; turns: number }> {
    if (!existsSync(this._projectDir)) return [];

    const sessions: Array<{ path: string; created: string; lastActiveAt: string; summary: string; title?: string; turns: number }> = [];
    const entries = readdirSync(this._projectDir).sort().reverse();

    for (const name of entries) {
      const d = join(this._projectDir, name);
      if (!name.endsWith("_chat")) continue;
      try {
        if (!statSync(d).isDirectory()) continue;
      } catch {
        continue;
      }

      // Prefer meta.json for fast listing
      const metaFile = join(d, "meta.json");
      if (existsSync(metaFile)) {
        try {
          const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
          const createdUtc = (raw.created_at as string) ?? "";
          const created = toLocalIsoFromUtc(createdUtc) || createdUtc;
          const lastActiveUtc = (raw.last_active_at as string) ?? createdUtc;
          const lastActiveAt = toLocalIsoFromUtc(lastActiveUtc) || lastActiveUtc;
          const summary = raw.summary ?? "";
          const title = raw.title ?? undefined;
          const turns = raw.turn_count ?? 0;
          // Skip empty sessions (0 turns) and archived sessions
          if (turns === 0) continue;
          if (raw.archived) continue;
          sessions.push({ path: d, created, lastActiveAt, summary, title, turns });
          continue;
        } catch {
          // Fall through to log.json
        }
      }

      // Fallback to log.json
      const logFile = join(d, "log.json");
      if (!existsSync(logFile)) continue;
      try {
        const raw = JSON.parse(readFileSync(logFile, "utf-8"));
        const createdUtc = (raw["created_at"] as string) ?? "";
        const created = toLocalIsoFromUtc(createdUtc) || createdUtc;
        const lastActiveUtc = (raw["updated_at"] as string) ?? createdUtc;
        const lastActiveAt = toLocalIsoFromUtc(lastActiveUtc) || lastActiveUtc;
        const summary = raw["summary"] ?? "";
        const title = raw["title"] ?? undefined;
        const turns = raw["turn_count"] ?? 0;
        // Skip empty sessions (0 turns) and archived sessions
        if (turns === 0) continue;
        if (raw.archived) continue;
        sessions.push({ path: d, created, lastActiveAt, summary, title, turns });
      } catch {
        continue;
      }
    }

    // Sort by lastActiveAt descending (most recently active first)
    sessions.sort((a, b) => {
      if (!a.lastActiveAt && !b.lastActiveAt) return 0;
      if (!a.lastActiveAt) return 1;
      if (!b.lastActiveAt) return -1;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });

    return sessions;
  }

  /** List all projects across the storage directory, sorted by last_active_at descending. */
  listProjects(): Array<{
    slug: string;
    originalPath: string;
    createdAt: string;
    lastActiveAt: string;
  }> {
    const projectsDir = join(this._preferredBaseDir, "projects");
    if (!existsSync(projectsDir)) return [];

    const result: Array<{
      slug: string;
      originalPath: string;
      createdAt: string;
      lastActiveAt: string;
    }> = [];

    for (const name of readdirSync(projectsDir)) {
      const d = join(projectsDir, name);
      try {
        if (!statSync(d).isDirectory()) continue;
      } catch { continue; }

      const projectJson = join(d, "project.json");
      if (!existsSync(projectJson)) continue;

      try {
        const raw = JSON.parse(readFileSync(projectJson, "utf-8"));
        result.push({
          slug: name,
          originalPath: raw.original_path ?? "",
          createdAt: raw.created_at ?? "",
          lastActiveAt: raw.last_active_at ?? "",
        });
      } catch { continue; }
    }

    // Sort by last_active_at descending
    result.sort((a, b) => {
      if (!a.lastActiveAt && !b.lastActiveAt) return 0;
      if (!a.lastActiveAt) return 1;
      if (!b.lastActiveAt) return -1;
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });

    return result;
  }

  get projectDir(): string {
    return this._projectDir;
  }

  get artifactsDir(): string | undefined {
    if (!this._sessionDir) return undefined;
    const d = join(this._sessionDir, "artifacts");
    try {
      mkdirSync(d, { recursive: true });
    } catch (exc) {
      console.warn(`Failed to ensure artifacts directory '${d}': ${exc}`);
      return undefined;
    }
    return d;
  }

  get sessionDir(): string | undefined {
    return this._sessionDir;
  }

  set sessionDir(value: string) {
    this._sessionDir = value;
  }
}

// ====================================================================
// Log-native persistence (v2)
// ====================================================================

// ------------------------------------------------------------------
// LogSessionMeta
// ------------------------------------------------------------------

export interface LogSessionMeta {
  version: number;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  projectPath: string;
  modelConfigName: string;
  modelProvider?: string;
  modelSelectionKey?: string;
  modelId?: string;
  summary: string;
  title?: string;
  turnCount: number;
  compactCount: number;
  thinkingLevel: string;
  childSessions?: ChildSessionMetaRecord[];
  /** Root session's frozen inbox (persisted on close for snapshot/restore). */
  inbox?: import("./session-tree-types.js").MessageEnvelope[];
}

/** Local inference server config (oMLX, LM Studio, etc.) */
export interface LocalProviderConfig {
  baseUrl: string;
  model: string;
  contextLength: number;
  /** API key for servers that require authentication (e.g. oMLX). Defaults to "local" if omitted. */
  apiKey?: string;
}

// ------------------------------------------------------------------
// New settings types (replaces GlobalTuiPreferences)
// ------------------------------------------------------------------

/** A single sub-agent model tier entry: stable model identity + thinking level. */
export interface ModelTierEntry {
  provider: string;
  selection_key: string;
  model_id: string;
  /** Required. Use one of the model's available levels, or "none" for non-thinking models. */
  thinking_level: string;
}

/** Per-template model pin: locks a specific agent template to a fixed model. */
export type AgentModelEntry = ModelTierEntry;

/** User-editable settings. Lives in settings.json (JSONC). */
export interface FermiSettings {
  // -- Model --
  /** Declarative default model. Overrides state/model-selection.json. */
  default_model?: string;
  /** Sub-agent model tiers. Each level maps to a model + optional thinking level. */
  model_tiers?: {
    high?: ModelTierEntry;
    medium?: ModelTierEntry;
    low?: ModelTierEntry;
  };
  /** Default thinking level for the main agent. */
  thinking_level?: string;
  /** Context window multiplier (0.0–1.0). */
  context_ratio?: number;

  // -- Providers (global only, not overridden by local settings) --
  /** Cloud provider → env var name, or local provider → full config. */
  providers?: Record<string, ProviderEntry>;

  // -- Display --
  accent_color?: string;

  // -- Permissions --
  /** Default permission mode: "read_only" | "reversible" | "yolo". */
  permission_mode?: string;

  // -- Sub-agent inheritance --
  /** Sub-agents inherit the parent's MCP servers/tools. Default: true. */
  sub_agent_inherit_mcp?: boolean;
  /** Sub-agents inherit the parent's hooks. Default: true. */
  sub_agent_inherit_hooks?: boolean;

  // -- Skills --
  disabled_skills?: string[];

  // -- Agent Models (per-template model pins, global + local merge) --
  agent_models?: Record<string, AgentModelEntry>;

  // -- MCP Servers (global + local merge) --
  mcp_servers?: Record<string, MCPServerSettingsEntry>;
}

/**
 * A provider entry in settings.json.
 * Cloud providers have `api_key_env`; local providers have `base_url` + `model`.
 */
export interface ProviderEntry {
  /** Environment variable name holding the API key (cloud providers). */
  api_key_env?: string;
  /** Base URL (local providers / custom endpoints). */
  base_url?: string;
  /** Model identifier (local providers). */
  model?: string;
  /** Context window size (local providers). */
  context_length?: number;
  /** Optional API key for local servers that need auth. */
  api_key?: string;
}

/** MCP server entry in settings.json. Same shape as the old mcp.json values. */
export interface MCPServerSettingsEntry {
  transport?: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  env_allowlist?: string[];
  sensitive_tools?: string[];
}

/** System-managed model selection state. Lives in state/model-selection.json. */
export interface ModelSelectionState {
  config_name?: string;
  provider?: string;
  selection_key?: string;
  model_id?: string;
  thinking_level?: string;
}

// ------------------------------------------------------------------
// Old preferences type (kept temporarily during migration)
// ------------------------------------------------------------------

export interface GlobalTuiPreferences {
  version: number;
  modelConfigName?: string;
  modelProvider?: string;
  modelSelectionKey?: string;
  modelId?: string;
  thinkingLevel: string;
  accentColor?: string;
  disabledSkills?: string[];
  /** Provider → environment variable name mapping (e.g. { "openai": "OPENAI_API_KEY_1" }) */
  providerEnvVars?: Record<string, string>;
  /** Local inference server configurations (e.g. { "lmstudio": { baseUrl, model, contextLength } }) */
  localProviders?: Record<string, LocalProviderConfig>;
  /** Context window multiplier (0.0–1.0). Effective context = contextLength × contextRatio. Default 1.0. */
  contextRatio?: number;
  /** Whether to show the Codex usage card in the sidebar. Default true. */
  showCodexUsage?: boolean;
  /** Permission mode preference. Default "reversible". */
  permissionMode?: string;
}

export function createGlobalTuiPreferences(
  partial?: Partial<GlobalTuiPreferences>,
): GlobalTuiPreferences {
  return {
    version: 1,
    modelConfigName: undefined,
    modelProvider: undefined,
    modelSelectionKey: undefined,
    modelId: undefined,
    thinkingLevel: "",
    ...partial,
  };
}

export function createLogSessionMeta(
  partial?: Partial<LogSessionMeta>,
): LogSessionMeta {
  return {
    version: 2,
    sessionId: "",
    createdAt: "",
    updatedAt: "",
    projectPath: "",
    modelConfigName: "",
    modelProvider: undefined,
    modelSelectionKey: undefined,
    modelId: undefined,
    summary: "",
    title: undefined,
    turnCount: 0,
    compactCount: 0,
    thinkingLevel: "",
    childSessions: undefined,
    ...partial,
  };
}

// ------------------------------------------------------------------
// camelCase ↔ snake_case conversion for LogEntry
// ------------------------------------------------------------------

function entryToSnake(entry: LogEntry): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id: entry.id,
    type: entry.type,
    timestamp: entry.timestamp,
    turn_index: entry.turnIndex,
    tui_visible: entry.tuiVisible,
    display_kind: entry.displayKind,
    display: entry.display,
    api_role: entry.apiRole,
    content: entry.content,
    archived: entry.archived,
    meta: entry.meta,
  };
  if (entry.roundIndex !== undefined) obj.round_index = entry.roundIndex;
  if (entry.summarized) obj.summarized = true;
  if (entry.summarizedBy) obj.summarized_by = entry.summarizedBy;
  if (entry.discarded) obj.discarded = true;
  return obj;
}

function entryFromSnake(obj: Record<string, unknown>): LogEntry {
  return {
    id: obj.id as string,
    type: obj.type as LogEntryType,
    timestamp: obj.timestamp as number,
    turnIndex: (obj.turn_index as number) ?? 0,
    roundIndex: obj.round_index as number | undefined,
    tuiVisible: (obj.tui_visible as boolean) ?? false,
    displayKind: (obj.display_kind as TuiDisplayKind | null) ?? null,
    display: (obj.display as string) ?? "",
    apiRole: (obj.api_role as LogEntry["apiRole"]) ?? null,
    content: obj.content ?? null,
    archived: (obj.archived as boolean) ?? false,
    meta: (obj.meta as Record<string, unknown>) ?? {},
    ...(obj.summarized ? { summarized: true } : {}),
    ...(obj.summarized_by ? { summarizedBy: obj.summarized_by as string } : {}),
    ...(obj.discarded ? { discarded: true } : {}),
  };
}

// ------------------------------------------------------------------
// Session meta.json (lightweight summary for fast listing)
// ------------------------------------------------------------------

export interface SessionMetaSummary {
  created_at: string;
  last_active_at: string;
  summary: string;
  title?: string;
  turn_count: number;
  archived?: boolean;
}

export function saveSessionMeta(sessionDir: string, meta: LogSessionMeta): void {
  const metaFile = join(sessionDir, "meta.json");
  const tmp = metaFile + ".tmp";
  // Preserve fields set externally (e.g. "archived") by merging with existing meta
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(metaFile)) {
      existing = JSON.parse(readFileSync(metaFile, "utf-8"));
    }
  } catch { /* ignore */ }
  const payload: Record<string, unknown> = {
    ...existing,
    created_at: meta.createdAt,
    last_active_at: meta.updatedAt,
    summary: meta.summary,
    title: meta.title,
    turn_count: meta.turnCount,
  };
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, metaFile);
}

function updateProjectLastActive(projectDir: string, lastActiveAt: string): void {
  const projectJson = join(projectDir, "project.json");
  if (!existsSync(projectJson)) return;
  try {
    const raw = JSON.parse(readFileSync(projectJson, "utf-8"));
    raw.last_active_at = lastActiveAt;
    const tmp = projectJson + ".tmp";
    writeFileSync(tmp, JSON.stringify(raw, null, 2));
    renameSync(tmp, projectJson);
  } catch {
    // Best-effort update
  }
}

// ------------------------------------------------------------------
// saveLog / loadLog
// ------------------------------------------------------------------

export function saveLog(
  dir: string,
  meta: LogSessionMeta,
  entries: LogEntry[],
): void {
  const now = nowTimestamps();
  meta.updatedAt = now.utcIso;
  if (!meta.createdAt) meta.createdAt = now.utcIso;
  if (!meta.sessionId) meta.sessionId = basename(dir);

  const payload: Record<string, unknown> = {
    version: meta.version,
    session_id: meta.sessionId,
    created_at: meta.createdAt,
    updated_at: meta.updatedAt,
    project_path: meta.projectPath,
    model_config_name: meta.modelConfigName,
    model_provider: meta.modelProvider ?? null,
    model_selection_key: meta.modelSelectionKey ?? null,
    model_id: meta.modelId ?? null,
    summary: meta.summary,
    title: meta.title ?? null,
    turn_count: meta.turnCount,
    compact_count: meta.compactCount,
    thinking_level: meta.thinkingLevel,
    child_sessions: meta.childSessions ?? null,
    entries: entries.map(entryToSnake),
  };

  const logFile = join(dir, "log.json");
  const tmp = logFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, logFile);

  // Write lightweight meta.json alongside log.json
  try {
    saveSessionMeta(dir, meta);
  } catch {
    // Best-effort
  }

  // Update project.json last_active_at
  try {
    updateProjectLastActive(dirname(dir), meta.updatedAt);
  } catch {
    // Best-effort
  }
}

export interface LoadLogResult {
  meta: LogSessionMeta;
  entries: LogEntry[];
  idAllocator: LogIdAllocator;
}

export function loadLog(dir: string): LoadLogResult {
  const logFile = join(dir, "log.json");
  const raw = JSON.parse(readFileSync(logFile, "utf-8"));

  const meta: LogSessionMeta = {
    version: raw.version ?? 2,
    sessionId: raw.session_id ?? "",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    projectPath: raw.project_path ?? "",
    modelConfigName: raw.model_config_name ?? "",
    modelProvider: raw.model_provider ?? undefined,
    modelSelectionKey: raw.model_selection_key ?? undefined,
    modelId: raw.model_id ?? undefined,
    summary: raw.summary ?? "",
    title: raw.title ?? undefined,
    turnCount: raw.turn_count ?? 0,
    compactCount: raw.compact_count ?? 0,
    thinkingLevel: raw.thinking_level ?? "",
    childSessions: Array.isArray(raw.child_sessions) ? raw.child_sessions as ChildSessionMetaRecord[] : undefined,
  };

  const rawEntries = (raw.entries ?? []) as Array<Record<string, unknown>>;
  const entries = rawEntries.map(entryFromSnake);

  // Validate entry ID uniqueness
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate entry ID detected: ${entry.id}`);
    }
    seenIds.add(entry.id);
  }

  // Restore ID allocator via full scan
  const idAllocator = new LogIdAllocator();
  idAllocator.restoreFrom(entries);

  return { meta, entries, idAllocator };
}

// ------------------------------------------------------------------
// validateAndRepairLog
// ------------------------------------------------------------------

export interface LogRepairResult {
  entries: LogEntry[];
  repaired: boolean;
  warnings: string[];
}

export function validateAndRepairLog(
  entries: LogEntry[],
): LogRepairResult {
  const warnings: string[] = [];
  let repaired = false;

  if (!entries || entries.length === 0) {
    return { entries: entries ?? [], repaired: false, warnings: [] };
  }

  // --- 1. Orphaned compactPhase entries (no compact_marker after them) ---
  {
    // Find the last compact_marker index
    let lastCompactMarkerIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "compact_marker" && !entries[i].discarded) {
        lastCompactMarkerIdx = i;
        break;
      }
    }
    // Mark compactPhase entries after the last compact_marker as discarded
    for (let i = lastCompactMarkerIdx + 1; i < entries.length; i++) {
      if (entries[i].meta?.compactPhase && !entries[i].discarded) {
        entries[i].discarded = true;
        warnings.push(`Discarded orphaned compactPhase entry ${entries[i].id}.`);
        repaired = true;
      }
    }
  }

  // --- 2. Fix orphaned tool_calls (missing tool_results) ---
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "tool_call" || entry.discarded) continue;
    if (entry.apiRole !== "assistant") continue;

    const toolCallId = entry.meta.toolCallId as string;
    // Check if there's a matching tool_result
    let hasResult = false;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].type === "tool_result" && entries[j].meta.toolCallId === toolCallId && !entries[j].discarded) {
        hasResult = true;
        break;
      }
    }
    if (!hasResult) {
      // Check if this is the last entry or near the end — likely a crash
      const isNearEnd = entries.length - i <= 5;
      if (isNearEnd) {
        const execState = entry.meta.toolExecState as string | undefined;
        const recoveredContent =
          execState === "running"
            ? "Session recovered. Tool execution was interrupted and may have caused partial or unknown real-world effects."
            : "Session recovered. Tool result unavailable due to abnormal termination.";
        // Add a recovered tool_result (we need an ID — use a predictable format)
        const recoveredId = `tr-recovered-${toolCallId}`;
        const recoveredEntry: LogEntry = {
          id: recoveredId,
          type: "tool_result",
          timestamp: Date.now(),
          turnIndex: entry.turnIndex,
          roundIndex: entry.roundIndex,
          tuiVisible: false,
          displayKind: null,
          display: "",
          apiRole: "tool_result",
          content: {
            toolCallId,
            toolName: entry.meta.toolName as string,
            content: recoveredContent,
            toolSummary: "(recovered)",
          },
          archived: false,
          meta: {
            toolCallId,
            toolName: entry.meta.toolName,
            isError: false,
            recovered: true,
            ...(entry.meta.contextId !== undefined ? { contextId: entry.meta.contextId } : {}),
          },
        };
        // Insert after the tool_call
        entries.splice(i + 1, 0, recoveredEntry);
        warnings.push(`Added recovered tool_result for tool_call ${entry.id} (${toolCallId}).`);
        repaired = true;
      }
    }
  }

  // --- 3. ask repair ---
  {
    // Build ask_request → ask_resolution mapping
    const askRequests = new Map<string, number>();
    const askResolutions = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.discarded) continue;
      if (e.type === "ask_request") {
        askRequests.set(e.meta.askId as string, i);
      } else if (e.type === "ask_resolution") {
        askResolutions.set(e.meta.askId as string, i);
      }
    }

    // Orphan ask_resolution (no matching ask_request) → discard
    for (const [askId, idx] of askResolutions) {
      if (!askRequests.has(askId)) {
        entries[idx].discarded = true;
        warnings.push(`Discarded orphan ask_resolution ${entries[idx].id} (askId=${askId}).`);
        repaired = true;
      }
    }

    // ask_resolution exists but no tool_result → add recovered tool_result
    for (const [askId, resIdx] of askResolutions) {
      if (entries[resIdx].discarded) continue;
      const reqIdx = askRequests.get(askId);
      if (reqIdx === undefined) continue;

      const reqEntry = entries[reqIdx];
      const toolCallId = reqEntry.meta.toolCallId as string;
      if (!toolCallId) continue;

      // Check if there's a tool_result for this toolCallId after the resolution
      let hasToolResult = false;
      for (let j = resIdx + 1; j < entries.length; j++) {
        if (entries[j].type === "tool_result" && entries[j].meta.toolCallId === toolCallId && !entries[j].discarded) {
          hasToolResult = true;
          break;
        }
      }
      if (!hasToolResult) {
        const recoveredId = `tr-askrecv-${toolCallId}`;
        const recoveredEntry: LogEntry = {
          id: recoveredId,
          type: "tool_result",
          timestamp: Date.now(),
          turnIndex: reqEntry.turnIndex,
          roundIndex: reqEntry.meta.roundIndex as number | undefined,
          tuiVisible: false,
          displayKind: null,
          display: "",
          apiRole: "tool_result",
          content: {
            toolCallId,
            toolName: reqEntry.meta.toolName ?? "ask",
            content: "Ask resolved. Session recovered from abnormal termination.",
            toolSummary: "(recovered)",
          },
          archived: false,
          meta: {
            toolCallId,
            toolName: reqEntry.meta.toolName ?? "ask",
            isError: false,
            recovered: true,
            ...(reqEntry.meta.contextId !== undefined ? { contextId: reqEntry.meta.contextId } : {}),
          },
        };
        entries.splice(resIdx + 1, 0, recoveredEntry);
        warnings.push(`Added recovered tool_result after ask_resolution ${entries[resIdx].id} (askId=${askId}).`);
        repaired = true;
      }
    }
  }

  return { entries, repaired, warnings };
}

// ------------------------------------------------------------------
// Archive window
// ------------------------------------------------------------------

export function archiveWindow(
  dir: string,
  windowIndex: number,
  entries: LogEntry[],
  windowStartIdx: number,
  windowEndIdx: number,
): void {
  const archiveDir = join(dir, "archive");
  mkdirSync(archiveDir, { recursive: true });

  const archived: Array<{ id: string; content: unknown }> = [];
  for (let i = windowStartIdx; i <= windowEndIdx && i < entries.length; i++) {
    const e = entries[i];
    if (e.content !== null && !e.archived) {
      archived.push({ id: e.id, content: e.content });
      e.content = null;
      e.archived = true;
    }
  }

  const archiveFile = join(archiveDir, `window-${windowIndex}.json.gz`);
  const json = JSON.stringify(archived);
  const compressed = gzipSync(Buffer.from(json));
  writeFileSync(archiveFile, compressed);
}

export function loadArchive(
  dir: string,
  windowIndex: number,
): Array<{ id: string; content: unknown }> {
  const archiveFile = join(dir, "archive", `window-${windowIndex}.json.gz`);
  const compressed = readFileSync(archiveFile);
  const json = gunzipSync(compressed).toString("utf-8");
  return JSON.parse(json);
}

/**
 * Restore archived content back into entries (in-memory only).
 */
export function restoreArchiveToEntries(
  entries: LogEntry[],
  archived: Array<{ id: string; content: unknown }>,
): void {
  const contentMap = new Map(archived.map((a) => [a.id, a.content]));
  for (const e of entries) {
    if (e.archived && contentMap.has(e.id)) {
      e.content = contentMap.get(e.id)!;
    }
  }
}

// ------------------------------------------------------------------
// fixStorage — repair missing project.json and meta.json
// ------------------------------------------------------------------

export interface FixStorageResult {
  projectsChecked: number;
  projectsFixed: number;
  sessionsChecked: number;
  sessionsFixed: number;
  warnings: string[];
}

export function fixStorage(baseDir?: string): FixStorageResult {
  const resolvedBase = resolvePreferredBaseDir(baseDir);
  const projectsDir = join(resolvedBase, "projects");

  const result: FixStorageResult = {
    projectsChecked: 0,
    projectsFixed: 0,
    sessionsChecked: 0,
    sessionsFixed: 0,
    warnings: [],
  };

  if (!existsSync(projectsDir)) return result;

  for (const projectName of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectName);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch { continue; }

    result.projectsChecked++;

    // Check / create project.json
    const projectJson = join(projectDir, "project.json");
    let projectData: Record<string, unknown>;
    if (!existsSync(projectJson)) {
      projectData = {
        original_path: "",
        created_at: nowTimestamps().utcIso,
        last_active_at: "",
      };
      writeFileSync(projectJson, JSON.stringify(projectData, null, 2));
      result.projectsFixed++;
      result.warnings.push(`Created missing project.json for ${projectName} (original_path unknown)`);
    } else {
      try {
        projectData = JSON.parse(readFileSync(projectJson, "utf-8"));
      } catch {
        result.warnings.push(`Could not parse project.json for ${projectName}`);
        continue;
      }
    }

    // Scan sessions and fix meta.json
    let latestActiveAt = "";
    for (const sessionName of readdirSync(projectDir)) {
      if (!sessionName.endsWith("_chat")) continue;
      const sessionDir = join(projectDir, sessionName);
      try {
        if (!statSync(sessionDir).isDirectory()) continue;
      } catch { continue; }

      result.sessionsChecked++;

      const metaFile = join(sessionDir, "meta.json");
      const logFile = join(sessionDir, "log.json");

      if (!existsSync(metaFile)) {
        if (existsSync(logFile)) {
          try {
            const raw = JSON.parse(readFileSync(logFile, "utf-8"));
            const payload: SessionMetaSummary = {
              created_at: raw.created_at ?? "",
              last_active_at: raw.updated_at ?? "",
              summary: raw.summary ?? "",
              title: raw.title ?? undefined,
              turn_count: raw.turn_count ?? 0,
            };
            const tmp = metaFile + ".tmp";
            writeFileSync(tmp, JSON.stringify(payload, null, 2));
            renameSync(tmp, metaFile);
            result.sessionsFixed++;

            if (payload.last_active_at > latestActiveAt) {
              latestActiveAt = payload.last_active_at;
            }
          } catch {
            result.warnings.push(`Could not parse log.json for ${projectName}/${sessionName}`);
          }
        } else {
          result.warnings.push(`No log.json or meta.json for ${projectName}/${sessionName}`);
        }
      } else {
        // meta.json exists — track latest for project-level update
        try {
          const raw = JSON.parse(readFileSync(metaFile, "utf-8"));
          const activeAt = raw.last_active_at ?? "";
          if (activeAt > latestActiveAt) {
            latestActiveAt = activeAt;
          }
        } catch { /* skip */ }
      }
    }

    // Update project.json last_active_at if missing or stale
    if (latestActiveAt && projectData.last_active_at !== latestActiveAt) {
      projectData.last_active_at = latestActiveAt;
      try {
        const tmp = projectJson + ".tmp";
        writeFileSync(tmp, JSON.stringify(projectData, null, 2));
        renameSync(tmp, projectJson);
        result.projectsFixed++;
      } catch { /* skip */ }
    }
  }

  return result;
}

// ------------------------------------------------------------------
// New settings API
// ------------------------------------------------------------------

/** Load global settings from ~/.fermi/settings.json (JSONC). */
export function loadGlobalSettings(homeDir?: string): FermiSettings {
  const dir = homeDir ?? getFermiHomeDir();
  const path = join(dir, SETTINGS_FILE);
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, "utf-8");
    return parseJsonc<FermiSettings>(text) ?? {};
  } catch {
    return {};
  }
}

/** Load project-local settings from {projectPath}/.fermi/settings.json (JSONC). */
export function loadLocalSettings(projectPath: string): FermiSettings {
  const path = join(projectPath, ".fermi", SETTINGS_FILE);
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, "utf-8");
    return parseJsonc<FermiSettings>(text) ?? {};
  } catch {
    return {};
  }
}

/**
 * Merge global + local settings.
 *
 * Rules:
 * - Scalars: local overrides global
 * - Objects (model_tiers, mcp_servers): per-key merge (local keys override)
 * - Arrays (disabled_skills): local replaces global
 * - `providers`: global only — local value is ignored
 */
export function mergeSettings(global: FermiSettings, local: FermiSettings): FermiSettings {
  const merged: FermiSettings = { ...global };

  // Scalars — local overrides if present
  if (local.default_model !== undefined) merged.default_model = local.default_model;
  if (local.thinking_level !== undefined) merged.thinking_level = local.thinking_level;
  if (local.context_ratio !== undefined) merged.context_ratio = local.context_ratio;
  if (local.accent_color !== undefined) merged.accent_color = local.accent_color;
  if (local.permission_mode !== undefined) merged.permission_mode = local.permission_mode;
  if (local.sub_agent_inherit_mcp !== undefined) merged.sub_agent_inherit_mcp = local.sub_agent_inherit_mcp;
  if (local.sub_agent_inherit_hooks !== undefined) merged.sub_agent_inherit_hooks = local.sub_agent_inherit_hooks;

  // Arrays — local replaces
  if (local.disabled_skills !== undefined) merged.disabled_skills = local.disabled_skills;

  // Objects — per-key merge
  if (local.model_tiers) {
    merged.model_tiers = { ...merged.model_tiers, ...local.model_tiers };
  }
  if (local.mcp_servers) {
    merged.mcp_servers = { ...merged.mcp_servers, ...local.mcp_servers };
  }
  if (local.agent_models) {
    merged.agent_models = { ...merged.agent_models, ...local.agent_models };
  }

  // providers: global only — do NOT merge local.providers
  return merged;
}

/** Load model selection state from state/model-selection.json. */
export function loadModelSelectionState(homeDir?: string): ModelSelectionState {
  const dir = homeDir ?? getFermiHomeDir();
  const path = join(dir, STATE_DIR, MODEL_SELECTION_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return {
      config_name: raw.config_name ?? undefined,
      provider: raw.provider ?? undefined,
      selection_key: raw.selection_key ?? undefined,
      model_id: raw.model_id ?? undefined,
      thinking_level: raw.thinking_level ?? undefined,
    };
  } catch {
    return {};
  }
}

/** Save model selection state to state/model-selection.json. Atomic write. */
export function saveModelSelectionState(state: ModelSelectionState, homeDir?: string): void {
  const dir = homeDir ?? getFermiHomeDir();
  const stateDir = join(dir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, MODEL_SELECTION_FILE);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/**
 * Save settings.json (global or local). Atomic write.
 * Only writes the fields that are defined — undefined fields are omitted.
 */
export function saveSettings(settings: FermiSettings, filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  // Build a clean object without undefined values
  const clean: Record<string, unknown> = {};
  if (settings.default_model !== undefined) clean.default_model = settings.default_model;
  if (settings.model_tiers !== undefined) clean.model_tiers = settings.model_tiers;
  if (settings.thinking_level !== undefined) clean.thinking_level = settings.thinking_level;
  if (settings.context_ratio !== undefined) clean.context_ratio = settings.context_ratio;
  if (settings.providers !== undefined) clean.providers = settings.providers;
  if (settings.accent_color !== undefined) clean.accent_color = settings.accent_color;
  if (settings.disabled_skills !== undefined) clean.disabled_skills = settings.disabled_skills;
  if (settings.mcp_servers !== undefined) clean.mcp_servers = settings.mcp_servers;
  if (settings.agent_models !== undefined) clean.agent_models = settings.agent_models;
  if (settings.sub_agent_inherit_mcp !== undefined) clean.sub_agent_inherit_mcp = settings.sub_agent_inherit_mcp;
  if (settings.sub_agent_inherit_hooks !== undefined) clean.sub_agent_inherit_hooks = settings.sub_agent_inherit_hooks;
  writeFileSync(tmp, JSON.stringify(clean, null, 2));
  renameSync(tmp, filePath);
}

/** Get the global settings.json path. */
export function globalSettingsPath(homeDir?: string): string {
  return join(homeDir ?? getFermiHomeDir(), SETTINGS_FILE);
}

/** Get the project-local settings.json path. */
export function localSettingsPath(projectPath: string): string {
  return join(projectPath, ".fermi", SETTINGS_FILE);
}

/**
 * Convert FermiSettings providers + mcp_servers into the formats
 * expected by Config and MCPClientManager.
 */
export function settingsToConfigInputs(settings: FermiSettings): {
  providerEnvVars: Record<string, string>;
  localProviders: Record<string, LocalProviderConfig>;
  mcpServers: MCPServerConfig[];
} {
  const providerEnvVars: Record<string, string> = {};
  const localProviders: Record<string, LocalProviderConfig> = {};

  if (settings.providers) {
    for (const [id, entry] of Object.entries(settings.providers)) {
      if (entry.api_key_env) {
        // Cloud provider
        providerEnvVars[id] = entry.api_key_env;
      } else if (entry.base_url && entry.model) {
        // Local provider
        localProviders[id] = {
          baseUrl: entry.base_url,
          model: entry.model,
          contextLength: entry.context_length ?? 128_000,
          apiKey: entry.api_key,
        };
      }
    }
  }

  const mcpServers: MCPServerConfig[] = [];
  if (settings.mcp_servers) {
    for (const [name, cfg] of Object.entries(settings.mcp_servers)) {
      if (!cfg || typeof cfg !== "object") continue;
      const env: Record<string, string> = {};
      if (cfg.env) {
        for (const [k, v] of Object.entries(cfg.env)) {
          // Resolve ${ENV_VAR} references
          if (typeof v === "string" && v.startsWith("${") && v.endsWith("}")) {
            const envName = v.slice(2, -1);
            const resolved = process.env[envName];
            if (resolved !== undefined) env[k] = resolved;
          } else {
            env[k] = v;
          }
        }
      }
      mcpServers.push({
        name,
        transport: cfg.transport ?? "stdio",
        command: cfg.command ?? "",
        args: cfg.args ?? [],
        url: cfg.url ?? "",
        env,
        envAllowlist: cfg.env_allowlist,
        sensitiveTools: cfg.sensitive_tools,
      });
    }
  }

  return { providerEnvVars, localProviders, mcpServers };
}
