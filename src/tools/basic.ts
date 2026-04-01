/**
 * Built-in tool definitions and executors.
 *
 * 13 tools: read_file, list_dir, glob, grep, edit_file, write_file,
 * bash, bash_background, bash_output, kill_shell,
 * time, web_search, web_fetch.
 */

import fs from "node:fs/promises";
import { existsSync, statSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ToolDef } from "../providers/base.js";
import { ToolResult } from "../providers/base.js";
import {
  safePath,
  SafePathError,
  type PathAccessKind,
} from "../security/path.js";
import { getSensitiveFileReadReason } from "../security/sensitive-files.js";
import {
  WEB_SEARCH,
  toolBuiltinWebSearchPassthrough,
} from "./web-search.js";
import { WEB_FETCH, toolWebFetch } from "./web-fetch.js";
import {
  isProjectedDocumentPath,
  loadProjectedDocumentView,
  projectedDocumentLabel,
} from "../document-projection.js";
import { classifyFile, IMAGE_MEDIA_TYPES } from "../file-attach.js";
import {
  type FileModifyDisplayData,
  type MatchInfo,
  inferLanguageByExt,
  countFileLines,
  buildHunkFromMatch,
  buildMultiEditHunks,
  buildAppendDisplayData,
  buildWriteDisplayData,
} from "../diff-hunk.js";

// ------------------------------------------------------------------
// Bash safety limits
// ------------------------------------------------------------------

const BASH_MAX_TIMEOUT = 600; // 10 minutes hard cap (seconds)
const BASH_DEFAULT_TIMEOUT = 60;
const BASH_MAX_OUTPUT_CHARS = 200_000; // ~200 KB text cap per stream
const BASH_TIMEOUT_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const BASH_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "USER",
  "LOGNAME",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
]);

// ------------------------------------------------------------------
// Read limits
// ------------------------------------------------------------------

const READ_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const READ_MAX_LINES = 1000;
const READ_MAX_CHARS = 50_000;
const READ_MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB limit for images

// ------------------------------------------------------------------
// Search safety limits
// ------------------------------------------------------------------

const SEARCH_MAX_RESULTS = 50;
const SEARCH_MAX_DEPTH = 6;
const SEARCH_MAX_FILES = 2_000;
const SEARCH_MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB per file
const SEARCH_MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MB total scanned text
const SEARCH_MAX_PATTERN_LENGTH = 300;
const SEARCH_MAX_DURATION_MS = 2_000;

// ------------------------------------------------------------------
// File write safety (Phase 5)
// ------------------------------------------------------------------

const FILE_WRITE_LOCKS = new Map<string, Promise<void>>();

// ======================================================================
// Tool definitions (provider-agnostic JSON Schema)
// ======================================================================

const READ: ToolDef = {
  name: "read_file",
  description:
    "Read the contents of a text file (max 50 MB). " +
    "Some document formats such as PDF, DOCX, and XLSX are returned as an auto-extracted Markdown view of the original file. " +
    "Returns line window plus file metadata (including mtime_ms) for optional optimistic concurrency checks. " +
    "Each call returns at most 1000 lines and 50000 characters. " +
    "If the file exceeds these limits, the output is truncated with a notice. " +
    "Use start_line / end_line to navigate large files in multiple calls. " +
    "If both are omitted, reads from the beginning up to the limit.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative file path",
      },
      start_line: {
        type: "integer",
        description: "First line to read (1-indexed, inclusive). Defaults to 1.",
      },
      end_line: {
        type: "integer",
        description:
          "Last line to read (1-indexed, inclusive). " +
          "Use -1 to read to the end of the file.",
      },
    },
    required: ["path"],
  },
  summaryTemplate: "{agent} is reading {path}",
};

const LIST: ToolDef = {
  name: "list_dir",
  description: "List files and directories. Returns a tree up to 2 levels deep.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path (default: current directory)",
        default: ".",
      },
    },
    required: [],
  },
  summaryTemplate: "{agent} is listing {path}",
};


const EDIT: ToolDef = {
  name: "edit_file",
  description:
    "Apply a patch to an existing file. " +
    "Provide edits array with one or more replacements (each old_str must appear exactly once, edits must not overlap). " +
    "To append: use append_str (can be combined with edits — all replacements execute first, append last).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      edits: {
        type: "array",
        description:
          "One or more replacements applied in a single atomic write. " +
          "Each item has old_str (must be unique in file) and new_str.",
        items: {
          type: "object",
          properties: {
            old_str: { type: "string", description: "Exact string to find (must be unique)" },
            new_str: { type: "string", description: "Replacement string" },
          },
          required: ["old_str", "new_str"],
        },
      },
      append_str: {
        type: "string",
        description:
          "Content to append to the end of the file. " +
          "Can be used alone or combined with edits (append always executes last).",
      },
      expected_mtime_ms: {
        type: "integer",
        description:
          "Optional optimistic concurrency guard. " +
          "If provided, edit is rejected when the file mtime differs (milliseconds since epoch).",
      },
      intent: {
        type: "string",
        enum: ["spawn"],
        description: "Display intent — consumed by UI layer to hide intermediate writes.",
      },
    },
    required: ["path"],
  },
  summaryTemplate: "{agent} is editing {path}",
};

const WRITE: ToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Parent directories are created automatically.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Full file content" },
      expected_mtime_ms: {
        type: "integer",
        description:
          "Optional optimistic concurrency guard for overwrites. " +
          "If provided, write is rejected when the existing file mtime differs (milliseconds since epoch).",
      },
      intent: {
        type: "string",
        enum: ["spawn"],
        description: "Display intent — consumed by UI layer to hide intermediate writes.",
      },
    },
    required: ["path", "content"],
  },
  summaryTemplate: "{agent} is writing to {path}",
};

const BASH: ToolDef = {
  name: "bash",
  description: "Execute a shell command and return stdout, stderr, and exit code.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: {
        type: "integer",
        description: `Timeout in seconds (default: ${BASH_DEFAULT_TIMEOUT}, max: ${BASH_MAX_TIMEOUT})`,
        default: BASH_DEFAULT_TIMEOUT,
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the command (default: current directory)",
      },
    },
    required: ["command"],
  },
  summaryTemplate: "{agent} is running a shell command",
};

const TIME: ToolDef = {
  name: "time",
  description:
    "Return the current local time of the runtime environment, including timezone and UTC offset.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  summaryTemplate: "{agent} is checking current time",
};

// ------------------------------------------------------------------
// Glob tool
// ------------------------------------------------------------------

const GLOB_MAX_RESULTS = 200;
const GLOB_MAX_FILES_SCANNED = 10_000;
const GLOB_MAX_DEPTH = 10;

const GLOB: ToolDef = {
  name: "glob",
  description:
    "Find files by name pattern. Returns matching paths sorted by modification time.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match (e.g. \"**/*.ts\", \"src/**/*.test.tsx\")",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: current directory)",
        default: ".",
      },
    },
    required: ["pattern"],
  },
  summaryTemplate: "{agent} is finding files matching '{pattern}'",
};

// ------------------------------------------------------------------
// Grep tool (enhanced search)
// ------------------------------------------------------------------

const GREP: ToolDef = {
  name: "grep",
  description:
    "Search file contents using regex. Supports context lines, glob filtering, and multiple output modes.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description: "Directory or file to search in (default: current directory)",
        default: ".",
      },
      glob: {
        type: "string",
        description: "Glob pattern to filter files (e.g. \"*.ts\", \"*.{ts,tsx}\")",
      },
      type: {
        type: "string",
        description: "File type filter by extension (e.g. \"js\", \"py\", \"ts\")",
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description:
          "Output mode: \"content\" (matching lines with context), " +
          "\"files_with_matches\" (file paths only, default), " +
          "\"count\" (match counts per file)",
      },
      "-A": {
        type: "integer",
        description: "Lines to show after each match (content mode only)",
      },
      "-B": {
        type: "integer",
        description: "Lines to show before each match (content mode only)",
      },
      "-C": {
        type: "integer",
        description: "Lines to show before and after each match (content mode only)",
      },
      "-i": {
        type: "boolean",
        description: "Case insensitive search",
      },
      "-n": {
        type: "boolean",
        description: "Show line numbers (default true for content mode)",
      },
      head_limit: {
        type: "integer",
        description: "Limit output to first N entries",
      },
    },
    required: ["pattern"],
  },
  summaryTemplate: "{agent} is searching for '{pattern}'",
};

// ------------------------------------------------------------------
// Background shell tools (tracked by Session)
// ------------------------------------------------------------------

export const BASH_BACKGROUND_TOOL: ToolDef = {
  name: "bash_background",
  description:
    "Start a background shell command tracked by the Session. " +
    "Use for dev servers, watchers, and long-running commands whose output you want to inspect later.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute in the background." },
      cwd: { type: "string", description: "Optional working directory for the command." },
      id: {
        type: "string",
        description: "Optional stable shell ID. If omitted, the Session generates one.",
      },
    },
    required: ["command"],
  },
  summaryTemplate: "{agent} is starting a background shell",
};

export const BASH_OUTPUT_TOOL: ToolDef = {
  name: "bash_output",
  description:
    "Read output from a tracked background shell. " +
    "By default, returns unread output since the last bash_output call for that shell. " +
    "Use tail_lines to inspect recent output without advancing the unread cursor.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Tracked shell ID." },
      tail_lines: {
        type: "integer",
        description: "Optional: return the last N lines without advancing unread state.",
      },
      max_chars: {
        type: "integer",
        description: "Optional max characters to return (default 8000).",
      },
    },
    required: ["id"],
  },
  summaryTemplate: "{agent} is reading background shell output",
};

export const KILL_SHELL_TOOL: ToolDef = {
  name: "kill_shell",
  description:
    "Terminate one or more tracked background shells. " +
    "Use when a watcher or dev server is no longer needed, or a command is stuck.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Tracked shell IDs to terminate.",
      },
      signal: {
        type: "string",
        description: "Optional signal name (default TERM).",
      },
    },
    required: ["ids"],
  },
  summaryTemplate: "{agent} is terminating background shells",
};

// ------------------------------------------------------------------
// Exports: tool lists
// ------------------------------------------------------------------

export const BASIC_TOOLS: ToolDef[] = [
  READ,
  LIST,
  GLOB,
  GREP,
  EDIT,
  WRITE,
  BASH,
  BASH_BACKGROUND_TOOL,
  BASH_OUTPUT_TOOL,
  KILL_SHELL_TOOL,
  TIME,
  WEB_SEARCH,
  WEB_FETCH,
];

export const BASIC_TOOLS_MAP: Record<string, ToolDef> = Object.fromEntries(
  BASIC_TOOLS.map((t) => [t.name, t]),
);

// ======================================================================
// Tool executors
// ======================================================================

// ------------------------------------------------------------------
// read_file
// ------------------------------------------------------------------

async function toolReadFile(
  filePath: string,
  startLine?: number,
  endLine?: number,
  artifactsDir?: string,
  supportsMultimodal?: boolean,
): Promise<string | ToolResult> {
  const sensitiveReason = getSensitiveFileReadReason(filePath);
  if (sensitiveReason) {
    return `ERROR: Access to sensitive file is blocked by default: ${filePath} (${sensitiveReason}).`;
  }

  if (!existsSync(filePath)) {
    return `ERROR: File not found: ${filePath}`;
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!stat.isFile()) {
    return `ERROR: Not a file: ${filePath}`;
  }

  // --- Image file handling ---
  const [isImage] = classifyFile(filePath);
  if (isImage) {
    if (!supportsMultimodal) {
      return `ERROR: Cannot read image file: current model does not support multimodal input. File: ${filePath}`;
    }
    if (stat.size > READ_MAX_IMAGE_SIZE) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      return `ERROR: Image too large (${sizeMB} MB, limit ${READ_MAX_IMAGE_SIZE / 1024 / 1024} MB).`;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "application/octet-stream";
    try {
      const raw = readFileSync(filePath);
      const b64Data = raw.toString("base64");
      const sizeFmt = stat.size < 1024
        ? `${stat.size} B`
        : stat.size < 1024 * 1024
          ? `${(stat.size / 1024).toFixed(1)} KB`
          : `${(stat.size / (1024 * 1024)).toFixed(1)} MB`;
      const description = `[Image: ${path.basename(filePath)} | ${mediaType} | ${sizeFmt}]`;
      return new ToolResult({
        content: description,
        contentBlocks: [
          { type: "text", text: description },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: b64Data,
            },
          },
        ],
      });
    } catch (e) {
      return `ERROR: Failed to read image: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (stat.size > READ_MAX_FILE_SIZE) {
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    return `ERROR: File too large (${sizeMB} MB, limit ${READ_MAX_FILE_SIZE / 1024 / 1024} MB).`;
  }

  const isProjectedDocument = isProjectedDocumentPath(filePath);

  let text: string;
  let mtimeMs = Math.trunc(stat.mtimeMs);
  let sizeBytes = stat.size;
  let headerPrefix = "";
  try {
    if (isProjectedDocument) {
      const view = await loadProjectedDocumentView(filePath, artifactsDir);
      text = view.text;
      mtimeMs = view.mtimeMs;
      sizeBytes = view.sizeBytes;
      headerPrefix =
        `[Auto-extracted Markdown view of ${path.basename(filePath)} (${projectedDocumentLabel(filePath)} source) | ` +
        `original_path=${filePath}]` + "\n";
    } else {
      text = readFileSync(filePath, { encoding: "utf-8" });
    }
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }

  const lines = text.split(/\r?\n/);
  // Keep trailing newline semantics: if file ends with \n the last split
  // element is "" but that represents "no extra line".
  const total = lines.length;
  let start = startLine ?? 1;
  let end = endLine == null || endLine === -1 ? total : endLine;

  if (start < 1) return `ERROR: start_line must be >= 1, got ${start}.`;
  if (start > total) return `ERROR: start_line ${start} exceeds total lines (${total}).`;
  if (end > total) end = total;
  if (end < start) return `ERROR: end_line (${end}) < start_line (${start}).`;

  // Apply line limit
  if (end - start + 1 > READ_MAX_LINES) {
    end = start + READ_MAX_LINES - 1;
  }

  let selected = lines.slice(start - 1, end);

  // Apply character limit
  let charCount = 0;
  let truncatedAtLine: number | null = null;
  for (let i = 0; i < selected.length; i++) {
    charCount += selected[i].length + 1; // +1 for newline
    if (charCount > READ_MAX_CHARS) {
      selected = selected.slice(0, i);
      truncatedAtLine = start + i; // 1-indexed line that exceeded the limit
      end = start + i - 1; // last fully included line
      break;
    }
  }

  let result =
    headerPrefix +
    `[Lines ${start}-${end} of ${total} | mtime_ms=${mtimeMs} | size_bytes=${sizeBytes}]\n` +
    selected.join("\n");

  if (truncatedAtLine !== null) {
    result +=
      `\n\n[WARNING: Reached ${READ_MAX_CHARS.toLocaleString()} character limit at line ` +
      `${truncatedAtLine}. Showing lines ${start}-${end} ` +
      `(${end - start + 1} complete lines). ` +
      `Use start_line=${end + 1} to continue reading${isProjectedDocument ? " the extracted Markdown view of the same source path" : ""}.]`;
  } else if (end < total) {
    result +=
      `\n\n[Output truncated at ${READ_MAX_LINES} lines. ` +
      `Use start_line=${end + 1} to continue reading${isProjectedDocument ? " the extracted Markdown view of the same source path" : ""}.]`;
  }

  return result;
}

// ------------------------------------------------------------------
// list_dir
// ------------------------------------------------------------------

async function toolListDir(dirPath = "."): Promise<string> {
  if (!existsSync(dirPath)) {
    return `ERROR: Directory not found: ${dirPath}`;
  }
  const stat = statSync(dirPath);
  if (!stat.isDirectory()) {
    return `ERROR: Not a directory: ${dirPath}`;
  }

  const lines: string[] = [];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    // Sort: directories first, then files, alphabetical
    const withStats = (await Promise.all(
      entries
        .filter(
          (name) =>
            !name.startsWith(".") &&
            name !== "node_modules" &&
            name !== "__pycache__",
        )
        .map(async (name) => {
          const full = path.join(dir, name);
          let isDir = false;
          try {
            isDir = (await fs.stat(full)).isDirectory();
          } catch {
            // skip inaccessible
          }
          return { name, full, isDir };
        }),
    )).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of withStats) {
      const marker = entry.isDir ? "[DIR] " : "";
      lines.push(`${prefix}${marker}${entry.name}`);
      if (entry.isDir) {
        await walk(entry.full, prefix + "  ", depth + 1);
      }
    }
  }

  await walk(dirPath, "", 0);
  return lines.length > 0 ? lines.join("\n") : "(empty directory)";
}


interface FileVersionSnapshot {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
  ino?: number;
  dev?: number;
  mode?: number;
}

class FileVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileVersionConflictError";
  }
}

function getFileVersionSnapshot(filePath: string): FileVersionSnapshot {
  if (!existsSync(filePath)) return { exists: false };
  const st = statSync(filePath);
  return {
    exists: true,
    mtimeMs: Math.trunc(st.mtimeMs),
    size: st.size,
    ino: typeof st.ino === "number" ? st.ino : undefined,
    dev: typeof st.dev === "number" ? st.dev : undefined,
    mode: st.mode,
  };
}

function sameFileVersion(a: FileVersionSnapshot, b: FileVersionSnapshot): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists && !b.exists) return true;
  return (
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.ino === b.ino &&
    a.dev === b.dev
  );
}

function validateExpectedMtime(
  filePath: string,
  expectedMtimeMs: number | undefined,
  current: FileVersionSnapshot,
): void {
  if (expectedMtimeMs == null) return;
  if (!current.exists) return; // new file — mtime guard is meaningless
  if (current.size === 0) return; // empty file — nothing to protect
  if (current.mtimeMs !== expectedMtimeMs) {
    throw new FileVersionConflictError(
      `File changed since last read (mtime conflict): ${filePath} ` +
      `(expected ${expectedMtimeMs}, current ${current.mtimeMs}).`,
    );
  }
}

function fileWriteLockKey(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function withFileWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = fileWriteLockKey(filePath);
  const previous = FILE_WRITE_LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  FILE_WRITE_LOCKS.set(key, chain);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (FILE_WRITE_LOCKS.get(key) === chain) {
      FILE_WRITE_LOCKS.delete(key);
    }
  }
}

// ------------------------------------------------------------------
// edit_file
// ------------------------------------------------------------------

async function toolEditFileAppend(
  filePath: string,
  appendStr: string,
  expectedMtimeMs?: number,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    if (!existsSync(filePath)) {
      return `ERROR: File not found: ${filePath}`;
    }

    let initialVersion: FileVersionSnapshot;
    try {
      initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    let before: string;
    try {
      before = readFileSync(filePath, { encoding: "utf-8" });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const totalLineCount = countFileLines(before);
    const finalContent = before + appendStr;

    const beforeLines = before.length > 0 ? before.split("\n") : [];
    const afterLines = finalContent.length > 0 ? finalContent.split("\n") : [];
    const diffPreview = buildUnifiedDiffPreview(
      simpleUnifiedDiff(beforeLines, afterLines, filePath, filePath),
    );

    const fileModifyData = buildAppendDisplayData(filePath, appendStr, totalLineCount);

    try {
      await atomicWriteTextFile(filePath, finalContent, initialVersion.mode, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const newMtimeMs = Math.trunc(statSync(filePath).mtimeMs);
    return new ToolResult({
      content: `OK: Appended ${appendStr.length} characters to ${filePath} [mtime_ms=${newMtimeMs}]`,
      metadata: {
        path: filePath,
        isAppend: true,
        lineCount: afterLines.length,
        tui_preview: {
          kind: "diff",
          text: diffPreview.text,
          truncated: diffPreview.truncated,
        },
        fileModifyData,
      },
    });
  });
}

// ------------------------------------------------------------------
// edit_file multi-edit
// ------------------------------------------------------------------

async function toolEditFileMulti(
  filePath: string,
  edits: Array<{ old_str: string; new_str: string }>,
  expectedMtimeMs?: number,
  appendStr?: string,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    if (!existsSync(filePath)) {
      return `ERROR: File not found: ${filePath}`;
    }

    let initialVersion: FileVersionSnapshot;
    try {
      initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    let content: string;
    try {
      content = readFileSync(filePath, { encoding: "utf-8" });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Find all matches, validate uniqueness
    const matches: MatchInfo[] = [];
    for (const edit of edits) {
      const count = content.split(edit.old_str).length - 1;
      if (count === 0) {
        const snippet = edit.old_str.length > 60
          ? edit.old_str.slice(0, 60) + "..."
          : edit.old_str;
        return `ERROR: old_str not found in file: ${JSON.stringify(snippet)}`;
      }
      if (count > 1) {
        const snippet = edit.old_str.length > 60
          ? edit.old_str.slice(0, 60) + "..."
          : edit.old_str;
        return `ERROR: old_str appears ${count} times (must be unique): ${JSON.stringify(snippet)}`;
      }
      matches.push({
        index: content.indexOf(edit.old_str),
        oldStr: edit.old_str,
        newStr: edit.new_str,
      });
    }

    // Sort by offset ascending for overlap check
    matches.sort((a, b) => a.index - b.index);

    // Check overlaps
    for (let i = 1; i < matches.length; i++) {
      const prev = matches[i - 1];
      if (prev.index + prev.oldStr.length > matches[i].index) {
        return `ERROR: edits overlap at offset ${matches[i].index}`;
      }
    }

    // Apply replacements from bottom to top (reverse offset order)
    let newContent = content;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      newContent = newContent.slice(0, m.index) + m.newStr + newContent.slice(m.index + m.oldStr.length);
    }

    // Append always executes last, after all replacements
    if (appendStr) {
      newContent += appendStr;
    }

    const totalLineCount = countFileLines(content);
    const hunks = buildMultiEditHunks(content, matches);

    // If append, add an append hunk at the end
    if (appendStr) {
      const appendStartLine = countFileLines(newContent) - countFileLines(appendStr) + 1;
      hunks.push({
        startLine: appendStartLine,
        contextBefore: [],
        deletions: [],
        additions: appendStr.split("\n"),
        contextAfter: [],
      });
    }

    const diffPreview = buildUnifiedDiffPreview(
      simpleUnifiedDiff(
        content.split("\n"),
        newContent.split("\n"),
        filePath,
        filePath,
      ),
    );

    const fileModifyData: FileModifyDisplayData = {
      filePath,
      language: inferLanguageByExt(filePath),
      mode: "replace",
      totalLineCount,
      hunks,
    };

    try {
      await atomicWriteTextFile(filePath, newContent, initialVersion.mode, initialVersion);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    const parts = [`${edits.length} edits applied`];
    if (appendStr) parts.push(`${appendStr.length} chars appended`);
    const newMtimeMs = Math.trunc(statSync(filePath).mtimeMs);
    return new ToolResult({
      content: `OK: ${parts.join(", ")}. [mtime_ms=${newMtimeMs}]`,
      metadata: {
        path: filePath,
        tui_preview: {
          kind: "diff",
          text: diffPreview.text,
          truncated: diffPreview.truncated,
        },
        fileModifyData,
      },
    });
  });
}

// ------------------------------------------------------------------
// write_file
// ------------------------------------------------------------------

async function toolWriteFile(
  filePath: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<string | ToolResult> {
  return withFileWriteLock(filePath, async () => {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const initialVersion = getFileVersionSnapshot(filePath);
      validateExpectedMtime(filePath, expectedMtimeMs, initialVersion);
      const mode = initialVersion.mode;
      const before = initialVersion.exists
        ? readFileSync(filePath, { encoding: "utf-8" })
        : "";

      const beforeLines = before.length > 0 ? before.split("\n") : [];
      const afterLines = content.length > 0 ? content.split("\n") : [];
      const diffPreview = buildUnifiedDiffPreview(
        simpleUnifiedDiff(
          beforeLines,
          afterLines,
          filePath,
          filePath,
        ),
      );

      const originalTotalLineCount = countFileLines(before);
      const fileModifyData = buildWriteDisplayData(filePath, content, originalTotalLineCount);

      await atomicWriteTextFile(filePath, content, mode, initialVersion);

      const newMtimeMs = Math.trunc(statSync(filePath).mtimeMs);
      const tuiPreview: Record<string, unknown> = {
        kind: "diff",
        text: diffPreview.text,
        truncated: diffPreview.truncated,
        newContent: content,
      };
      return new ToolResult({
        content: `OK: Wrote ${content.length} characters to ${filePath} [mtime_ms=${newMtimeMs}]`,
        metadata: {
          path: filePath,
          isNewFile: !initialVersion.exists,
          lineCount: afterLines.length,
          tui_preview: tuiPreview,
          fileModifyData,
        },
      });
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
}

async function atomicWriteTextFile(
  filePath: string,
  content: string,
  mode?: number,
  expectedVersion?: FileVersionSnapshot,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${randomUUID()}`,
  );

  let tmpExists = false;
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf-8" });
    tmpExists = true;

    if (mode !== undefined) {
      try {
        await fs.chmod(tmpPath, mode);
      } catch {
        // Best-effort permission preservation
      }
    }

    if (expectedVersion) {
      const currentVersion = getFileVersionSnapshot(filePath);
      if (!sameFileVersion(expectedVersion, currentVersion)) {
        throw new FileVersionConflictError(
          `File changed during write (mtime conflict): ${filePath}. Please re-read and retry.`,
        );
      }
    }

    await fs.rename(tmpPath, filePath);
    tmpExists = false;
  } finally {
    if (tmpExists) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

// ------------------------------------------------------------------
// bash
// ------------------------------------------------------------------

function truncateOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const omitted = text.length - limit;
  return (
    text.slice(0, half) +
    `\n\n... [truncated ${omitted.toLocaleString()} chars] ...\n\n` +
    text.slice(-half)
  );
}

export function buildBashEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (BASH_ENV_ALLOWLIST.has(key) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }
  // Keep a usable PATH even if parent PATH is missing.
  if (!env["PATH"]) {
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin";
  }
  return env;
}

async function toolBash(
  command: string,
  timeout = BASH_DEFAULT_TIMEOUT,
  cwd = "",
): Promise<string> {
  // Enforce timeout bounds
  if (typeof timeout !== "number" || timeout < 1) {
    timeout = BASH_DEFAULT_TIMEOUT;
  }
  timeout = Math.min(timeout, BASH_MAX_TIMEOUT);

  // Resolve working directory
  let runCwd: string | undefined;
  if (cwd) {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return `ERROR: Working directory does not exist or is not a directory: ${cwd}`;
    }
    runCwd = cwd;
  }

  return new Promise<string>((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd: runCwd,
      env: buildBashEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    const maxBuffer = 10 * 1024 * 1024; // 10 MB
    let killed = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLen < maxBuffer) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen < maxBuffer) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(BASH_TIMEOUT_KILL_SIGNAL as NodeJS.Signals); } catch {}
    }, timeout * 1000);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killed || signal === "SIGTERM" || signal === BASH_TIMEOUT_KILL_SIGNAL) {
        resolve(
          `ERROR: Command timed out after ${timeout}s (max allowed: ${BASH_MAX_TIMEOUT}s). ` +
          `Shell process was terminated (${BASH_TIMEOUT_KILL_SIGNAL}); child-process tree termination is best-effort.`
        );
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const parts: string[] = [];
      if (stdout) {
        parts.push(`STDOUT:\n${truncateOutput(stdout, BASH_MAX_OUTPUT_CHARS)}`);
      }
      if (stderr) {
        parts.push(`STDERR:\n${truncateOutput(stderr, BASH_MAX_OUTPUT_CHARS)}`);
      }
      parts.push(`EXIT CODE: ${code ?? 1}`);
      resolve(parts.join("\n"));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`ERROR: ${err.message}`);
    });
  });
}

// ------------------------------------------------------------------
// diff preview helpers (used by edit_file / write_file)
// ------------------------------------------------------------------

function buildUnifiedDiffPreview(
  diff: string,
): { text: string; truncated: boolean } {
  if (!diff) {
    return { text: "(No textual changes.)", truncated: false };
  }

  type PreviewLine = {
    raw: string;
    oldLine?: number;
    newLine?: number;
  };

  const parsedLines: PreviewLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      parsedLines.push({ raw });
      continue;
    }

    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      parsedLines.push({ raw });
      continue;
    }

    if (raw.startsWith("-")) {
      parsedLines.push({ raw, oldLine });
      oldLine += 1;
      continue;
    }

    if (raw.startsWith("+")) {
      parsedLines.push({ raw, newLine });
      newLine += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      parsedLines.push({ raw, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    parsedLines.push({ raw });
  }

  const displayLineFor = (line: PreviewLine): number | undefined => {
    if (line.raw.startsWith("-")) return line.oldLine;
    if (line.raw.startsWith("+")) return line.newLine;
    if (line.raw.startsWith(" ")) return line.newLine;
    return undefined;
  };

  const maxLineNumber = parsedLines.reduce((max, line) => {
    return Math.max(max, displayLineFor(line) ?? 0);
  }, 0);
  const numberWidth = Math.max(String(maxLineNumber || 0).length, 2);

  const formatLine = (line: PreviewLine): string => {
    const displayLine = displayLineFor(line);
    const lineCol = displayLine == null ? "".padStart(numberWidth, " ") : String(displayLine).padStart(numberWidth, " ");
    return `${lineCol} ${line.raw}`;
  };

  // Keep every changed line in the preview. Context omission is already handled
  // upstream by the unified diff hunking logic, which limits unchanged lines
  // around each change instead of globally truncating the rendered preview.
  const text = parsedLines.map(formatLine).join("\n");
  return { text, truncated: false };
}

/**
 * Minimal unified diff: generates a unified diff string from two line arrays.
 */
function simpleUnifiedDiff(
  a: string[],
  b: string[],
  labelA: string,
  labelB: string,
): string {
  // Use a simple LCS-based approach
  const n = a.length;
  const m = b.length;

  // For very large files, fall back to a simpler comparison
  if (n * m > 10_000_000) {
    // Too large for full LCS, just show stats
    return (
      `--- ${labelA}\n+++ ${labelB}\n` +
      `(Files differ: ${n} lines vs ${m} lines, diff too large to compute)`
    );
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find edit script
  const ops: Array<{ type: "equal" | "delete" | "insert"; line: string }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "equal", line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "insert", line: b[j - 1] });
      j--;
    } else {
      ops.push({ type: "delete", line: a[i - 1] });
      i--;
    }
  }
  ops.reverse();

  // Group into hunks with context
  const contextLines = 3;
  const hunks: string[] = [];
  let hunkStart = -1;
  let hunkLines: string[] = [];
  let aLine = 0;
  let bLine = 0;
  let aStart = 0;
  let bStart = 0;
  let aCount = 0;
  let bCount = 0;
  let lastChangeIdx = -contextLines - 1;

  function flushHunk(): void {
    if (hunkLines.length > 0) {
      hunks.push(
        `@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@\n` +
        hunkLines.join("\n"),
      );
      hunkLines = [];
    }
  }

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    const isChange = op.type !== "equal";

    if (isChange) {
      if (hunkStart === -1 || idx - lastChangeIdx > contextLines * 2) {
        // Start a new hunk
        flushHunk();
        hunkStart = idx;
        aStart = aLine;
        bStart = bLine;
        aCount = 0;
        bCount = 0;
        // Add leading context
        const ctxStart = Math.max(0, idx - contextLines);
        // We need to recount from ctxStart -- but for simplicity, just
        // include context from current position
      }
      lastChangeIdx = idx;
    }

    if (hunkStart !== -1 && idx - lastChangeIdx <= contextLines) {
      if (op.type === "equal") {
        hunkLines.push(` ${op.line}`);
        aCount++;
        bCount++;
      } else if (op.type === "delete") {
        hunkLines.push(`-${op.line}`);
        aCount++;
      } else {
        hunkLines.push(`+${op.line}`);
        bCount++;
      }
    }

    if (op.type === "equal" || op.type === "delete") aLine++;
    if (op.type === "equal" || op.type === "insert") bLine++;
  }

  flushHunk();

  if (hunks.length === 0) return "";
  return `--- ${labelA}\n+++ ${labelB}\n${hunks.join("\n")}`;
}

function formatUtcOffset(date: Date): string {
  // getTimezoneOffset returns minutes behind UTC; invert for UTC±HH:MM.
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function toolTime(): string {
  const now = new Date();
  const tzIana = Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
  const tzName =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value || "Unknown";
  const offset = formatUtcOffset(now);
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const iso = `${local.replace(" ", "T")}${offset}`;
  return [
    `Current local time: ${local}`,
    `Timezone: ${tzIana} (${tzName}, UTC${offset})`,
    `ISO 8601: ${iso}`,
  ].join("\n");
}

// ======================================================================
// Dispatcher
// ======================================================================

type ToolExecutor = (args: Record<string, unknown>) => Promise<string | ToolResult> | string | ToolResult;

export interface ExecuteToolContext {
  projectRoot?: string;
  externalPathAllowlist?: string[];
  sessionArtifactsDir?: string;
  supportsMultimodal?: boolean;
}

class ToolArgValidationError extends Error {
  toolName: string;
  field: string;

  constructor(toolName: string, field: string, message: string) {
    super(message);
    this.name = "ToolArgValidationError";
    this.toolName = toolName;
    this.field = field;
  }
}

function toolRoot(ctx?: ExecuteToolContext): string {
  return path.resolve(ctx?.projectRoot ?? process.cwd());
}

function formatToolError(toolName: string, err: unknown): string {
  if (err instanceof ToolArgValidationError) {
    return `ERROR: Invalid arguments for ${toolName}: ${err.message}`;
  }
  if (err instanceof SafePathError) {
    const p = err.details.resolvedPath || err.details.requestedPath;
    switch (err.code) {
      case "PATH_OUTSIDE_SCOPE":
        return `ERROR: ${toolName} path is outside the project root boundary: ${err.details.requestedPath}`;
      case "PATH_SYMLINK_ESCAPES_SCOPE":
        return `ERROR: ${toolName} path escapes the project root via a symbolic link: ${err.details.requestedPath}`;
      case "PATH_NOT_FOUND":
        return `ERROR: Path not found: ${p}`;
      case "PATH_NOT_FILE":
        return `ERROR: Not a file: ${p}`;
      case "PATH_NOT_DIRECTORY":
        return `ERROR: Not a directory: ${p}`;
      case "PATH_INVALID_INPUT":
        return `ERROR: ${err.message}`;
      default:
        return `ERROR: ${err.message}`;
    }
  }
  return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
}

function expectArgsObject(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolArgValidationError(toolName, "(root)", "arguments must be an object.");
  }
  return args;
}

function requiredStringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  opts?: { nonEmpty?: boolean; maxLen?: number },
): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a string.`);
  }
  if (opts?.nonEmpty && !v.trim()) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a non-empty string.`);
  }
  if (opts?.maxLen !== undefined && v.length > opts.maxLen) {
    throw new ToolArgValidationError(
      toolName,
      key,
      `'${key}' exceeds max length (${opts.maxLen}).`,
    );
  }
  return v;
}

function optionalStringArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = args[key];
  if (v == null) return fallback;
  if (typeof v !== "string") {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be a string.`);
  }
  return v;
}

function optionalIntegerArg(
  toolName: string,
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ToolArgValidationError(toolName, key, `'${key}' must be an integer.`);
  }
  return v;
}

function scopedPath(
  requestedPath: string,
  accessKind: PathAccessKind,
  ctx: ExecuteToolContext | undefined,
  opts: {
    mustExist?: boolean;
    allowCreate?: boolean;
    expectFile?: boolean;
    expectDirectory?: boolean;
  },
): string {
  const baseDir = toolRoot(ctx);
  const attempt = (scopeBaseDir: string): string => safePath({
    baseDir: scopeBaseDir,
    requestedPath,
    cwd: baseDir,
    accessKind,
    mustExist: opts.mustExist,
    allowCreate: opts.allowCreate,
    expectFile: opts.expectFile,
    expectDirectory: opts.expectDirectory,
  }).safePath!;

  try {
    return attempt(baseDir);
  } catch (err) {
    if (!(err instanceof SafePathError)) throw err;
    if (err.code !== "PATH_OUTSIDE_SCOPE" && err.code !== "PATH_SYMLINK_ESCAPES_SCOPE") {
      throw err;
    }

    const allowlist = ctx?.externalPathAllowlist ?? [];
    for (const allowedRoot of allowlist) {
      try {
        return attempt(allowedRoot);
      } catch (inner) {
        if (inner instanceof SafePathError &&
            (inner.code === "PATH_OUTSIDE_SCOPE" || inner.code === "PATH_SYMLINK_ESCAPES_SCOPE")) {
          continue;
        }
        throw inner;
      }
    }
    throw err;
  }
}

// ------------------------------------------------------------------
// glob executor
// ------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: `*` (any non-slash), `**` (any including slash), `?` (single char),
 * `{a,b}` (alternatives), and literal characters.
 */
function globToRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches anything including slashes
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?"; // **/ matches zero or more directories
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const alts = pattern.slice(i + 1, close).split(",").map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        re += `(?:${alts})`;
        i = close + 1;
      } else {
        re += "\\{";
        i++;
      }
    } else if (".+^$|()[]\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

const GLOB_SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".next", ".nuxt",
  "dist", ".tox", ".mypy_cache", ".pytest_cache", ".venv", "venv",
]);

async function toolGlob(pattern: string, searchPath: string): Promise<string> {
  if (!existsSync(searchPath)) {
    return `ERROR: Path not found: ${searchPath}`;
  }

  const regex = globToRegex(pattern);

  const results: Array<{ path: string; mtime: number }> = [];
  let filesScanned = 0;

  async function walk(dir: string, depth: number, relPrefix: string): Promise<void> {
    if (depth > GLOB_MAX_DEPTH) return;
    if (results.length >= GLOB_MAX_RESULTS) return;
    if (filesScanned >= GLOB_MAX_FILES_SCANNED) return;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (results.length >= GLOB_MAX_RESULTS) return;
      if (filesScanned >= GLOB_MAX_FILES_SCANNED) return;

      if (GLOB_SKIP_DIRS.has(name)) continue;
      if (name.startsWith(".") && name !== ".") continue;

      const full = path.join(dir, name);
      const rel = relPrefix ? relPrefix + "/" + name : name;

      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        await walk(full, depth + 1, rel);
      } else if (stat.isFile()) {
        filesScanned++;
        if (regex.test(rel)) {
          results.push({ path: full, mtime: stat.mtimeMs });
        }
      }
    }
  }

  await walk(searchPath, 0, "");

  if (results.length === 0) {
    return "No files found matching the pattern.";
  }

  // Sort by mtime descending (most recently modified first)
  results.sort((a, b) => b.mtime - a.mtime);

  const lines = results.map((r) => r.path);
  let output = lines.join("\n");
  if (results.length >= GLOB_MAX_RESULTS) {
    output += `\n... (truncated at ${GLOB_MAX_RESULTS} results)`;
  }
  return output;
}

// ------------------------------------------------------------------
// grep executor (enhanced search)
// ------------------------------------------------------------------

interface GrepOptions {
  glob?: string;
  fileType?: string;
  outputMode: "content" | "files_with_matches" | "count";
  afterContext: number;
  beforeContext: number;
  caseInsensitive: boolean;
  showLineNumbers: boolean;
  headLimit: number;
}

/** Check if a filename matches a simple glob pattern (e.g. "*.ts", "*.{ts,tsx}") */
function matchFileGlob(filename: string, globPattern: string): boolean {
  const regex = globToRegex(globPattern);
  return regex.test(filename);
}

/** Check if file extension matches a type filter */
function matchFileType(filename: string, typeFilter: string): boolean {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ext === typeFilter.toLowerCase();
}

async function toolGrep(pattern: string, searchPath: string, options: GrepOptions): Promise<string> {
  if (!existsSync(searchPath)) {
    return `ERROR: Path not found: ${searchPath}`;
  }

  if (!pattern) {
    return "ERROR: pattern must be a non-empty string.";
  }
  if (pattern.length > SEARCH_MAX_PATTERN_LENGTH) {
    return (
      `ERROR: Regex pattern too long (${pattern.length} chars, ` +
      `limit ${SEARCH_MAX_PATTERN_LENGTH}).`
    );
  }
  // Catastrophic backtracking check
  if (/(^|[^\\])\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    return "ERROR: Regex appears too complex/risky (nested quantified group).";
  }

  let regex: RegExp;
  try {
    const flags = options.caseInsensitive ? "i" : "";
    regex = new RegExp(pattern, flags);
  } catch (e) {
    return `ERROR: Invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }

  const startedAt = Date.now();
  const stats = {
    filesScanned: 0,
    bytesScanned: 0,
    skippedLargeFiles: 0,
    skippedSensitiveFiles: 0,
    depthLimitHits: 0,
    maxFilesHit: false,
    maxBytesHit: false,
    timeoutHit: false,
  };

  // Results storage depends on output mode
  const fileMatches: Array<{ file: string; matches: Array<{ line: number; text: string }>; count: number }> = [];
  let totalEntries = 0;

  function shouldStop(): boolean {
    if (options.headLimit > 0 && totalEntries >= options.headLimit) return true;
    if (stats.maxFilesHit || stats.maxBytesHit || stats.timeoutHit) return true;
    if (Date.now() - startedAt > SEARCH_MAX_DURATION_MS) {
      stats.timeoutHit = true;
      return true;
    }
    return false;
  }

  function shouldIncludeFile(filename: string): boolean {
    if (options.glob && !matchFileGlob(filename, options.glob)) return false;
    if (options.fileType && !matchFileType(filename, options.fileType)) return false;
    return true;
  }

  async function processFile(filePath: string): Promise<void> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(filePath);
    } catch {
      return;
    }
    // Skip binary files
    const header = raw.subarray(0, 8192);
    if (header.includes(0)) return;

    const text = raw.toString("utf-8");
    const lines = text.split("\n");
    const matchingLines: Array<{ line: number; text: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      if (regex.global || regex.sticky) regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        matchingLines.push({ line: i + 1, text: lines[i].trimEnd() });
      }
    }

    if (matchingLines.length > 0) {
      fileMatches.push({
        file: filePath,
        matches: matchingLines,
        count: matchingLines.length,
      });
      totalEntries++;
    }
  }

  async function walkForGrep(dir: string, depth: number): Promise<void> {
    if (shouldStop()) return;
    if (depth > SEARCH_MAX_DEPTH) {
      stats.depthLimitHits += 1;
      return;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (shouldStop()) return;
      if (name.startsWith(".") || name === "__pycache__" || name === "node_modules") continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        await walkForGrep(full, depth + 1);
      } else if (stat.isFile()) {
        if (!shouldIncludeFile(name)) continue;
        if (getSensitiveFileReadReason(full)) {
          stats.skippedSensitiveFiles += 1;
          continue;
        }
        if (stats.filesScanned >= SEARCH_MAX_FILES) {
          stats.maxFilesHit = true;
          return;
        }
        stats.filesScanned += 1;

        if (stat.size > SEARCH_MAX_FILE_SIZE) {
          stats.skippedLargeFiles += 1;
          continue;
        }
        if (stats.bytesScanned + stat.size > SEARCH_MAX_TOTAL_BYTES) {
          stats.maxBytesHit = true;
          return;
        }
        stats.bytesScanned += stat.size;

        await processFile(full);
      }
    }
  }

  // Handle single file path
  const pathStat = statSync(searchPath);
  if (pathStat.isFile()) {
    if (shouldIncludeFile(path.basename(searchPath))) {
      await processFile(searchPath);
    }
  } else {
    await walkForGrep(searchPath, 0);
  }

  // Format output based on mode
  let output = "";
  const { outputMode } = options;

  if (fileMatches.length === 0) {
    output = "No matches found.";
  } else if (outputMode === "files_with_matches") {
    const lines = fileMatches.map((f) => f.file);
    output = lines.join("\n");
  } else if (outputMode === "count") {
    const lines = fileMatches.map((f) => `${f.file}:${f.count}`);
    output = lines.join("\n");
  } else {
    // content mode — show matching lines with optional context
    const parts: string[] = [];
    const beforeCtx = options.beforeContext;
    const afterCtx = options.afterContext;
    const showNumbers = options.showLineNumbers;

    for (const fm of fileMatches) {
      if (options.headLimit > 0 && parts.length >= options.headLimit) break;

      if (beforeCtx > 0 || afterCtx > 0) {
        // Need to re-read file for context lines
        let fileLines: string[];
        try {
          fileLines = (await fs.readFile(fm.file, "utf-8")).split("\n");
        } catch {
          continue;
        }

        for (const m of fm.matches) {
          if (options.headLimit > 0 && parts.length >= options.headLimit) break;
          const startL = Math.max(0, m.line - 1 - beforeCtx);
          const endL = Math.min(fileLines.length, m.line + afterCtx);

          for (let li = startL; li < endL; li++) {
            const isMatch = li === m.line - 1;
            const prefix = isMatch ? ">" : " ";
            const lineText = fileLines[li].trimEnd();
            if (showNumbers) {
              parts.push(`${fm.file}:${li + 1}:${prefix} ${lineText}`);
            } else {
              parts.push(`${fm.file}:${prefix} ${lineText}`);
            }
          }
          parts.push("--");
        }
      } else {
        // No context — just matching lines
        for (const m of fm.matches) {
          if (options.headLimit > 0 && parts.length >= options.headLimit) break;
          if (showNumbers) {
            parts.push(`${fm.file}:${m.line}: ${m.text}`);
          } else {
            parts.push(`${fm.file}: ${m.text}`);
          }
        }
      }
    }
    output = parts.join("\n");
  }

  // Append notices
  const notices: string[] = [];
  if (stats.skippedLargeFiles > 0) {
    notices.push(`Skipped ${stats.skippedLargeFiles} large file(s) over ${Math.round(SEARCH_MAX_FILE_SIZE / 1024)} KB.`);
  }
  if (stats.skippedSensitiveFiles > 0) {
    notices.push(`Skipped ${stats.skippedSensitiveFiles} sensitive file(s).`);
  }
  if (stats.depthLimitHits > 0) {
    notices.push(`Depth limit reached in ${stats.depthLimitHits} director${stats.depthLimitHits === 1 ? "y" : "ies"} (max depth ${SEARCH_MAX_DEPTH}).`);
  }
  if (stats.maxFilesHit) {
    notices.push(`Stopped after scanning ${SEARCH_MAX_FILES} files.`);
  }
  if (stats.maxBytesHit) {
    notices.push(`Stopped after scanning ${Math.round(SEARCH_MAX_TOTAL_BYTES / 1024 / 1024)} MB.`);
  }
  if (stats.timeoutHit) {
    notices.push(`Stopped after ${SEARCH_MAX_DURATION_MS}ms time limit.`);
  }
  if (notices.length > 0) {
    output += "\n\n[Search notices]\n" + notices.map((n) => `- ${n}`).join("\n");
  }
  return output;
}

function createDispatch(ctx?: ExecuteToolContext): Record<string, ToolExecutor> {
  return {
    read_file: (args) => {
      try {
        const a = expectArgsObject("read_file", args);
        const requestedPath = requiredStringArg("read_file", a, "path", { nonEmpty: true });
        const startLine = optionalIntegerArg("read_file", a, "start_line");
        const endLine = optionalIntegerArg("read_file", a, "end_line");
        const filePath = scopedPath(
          requestedPath,
          "read",
          ctx,
          { mustExist: true, expectFile: true },
        );
        return toolReadFile(
          filePath,
          startLine,
          endLine,
          ctx?.sessionArtifactsDir,
          ctx?.supportsMultimodal,
        );
      } catch (e) {
        return formatToolError("read_file", e);
      }
    },
    list_dir: async (args) => {
      try {
        const a = expectArgsObject("list_dir", args);
        const requestedPath = optionalStringArg("list_dir", a, "path", ".");
        const dirPath = scopedPath(
          requestedPath,
          "list",
          ctx,
          { mustExist: true, expectDirectory: true },
        );
        return await toolListDir(dirPath);
      } catch (e) {
        return formatToolError("list_dir", e);
      }
    },
    edit_file: (args) => {
      try {
        const a = expectArgsObject("edit_file", args);
        const requestedPath = requiredStringArg("edit_file", a, "path", { nonEmpty: true });
        const expectedMtimeMs = optionalIntegerArg("edit_file", a, "expected_mtime_ms");
        const appendStr = optionalStringArg("edit_file", a, "append_str", "");
        const editsRaw = a.edits;

        // Validate edits array
        const edits: Array<{ old_str: string; new_str: string }> = [];
        if (Array.isArray(editsRaw)) {
          for (const item of editsRaw) {
            if (!item || typeof item !== "object") {
              return "ERROR: Each item in edits must be an object with old_str and new_str.";
            }
            const obj = item as Record<string, unknown>;
            if (typeof obj.old_str !== "string" || !obj.old_str) {
              return "ERROR: Each item in edits must have a non-empty old_str.";
            }
            if (typeof obj.new_str !== "string") {
              return "ERROR: Each item in edits must have a new_str.";
            }
            edits.push({ old_str: obj.old_str, new_str: obj.new_str });
          }
          if (edits.length === 0) {
            return "ERROR: edits array must not be empty.";
          }
        }

        if (edits.length === 0 && !appendStr) {
          return "ERROR: edit_file requires edits array and/or append_str.";
        }

        const filePath = scopedPath(
          requestedPath,
          "write",
          ctx,
          { mustExist: true, expectFile: true },
        );

        // Append-only (no replacements)
        if (edits.length === 0) {
          return toolEditFileAppend(filePath, appendStr, expectedMtimeMs);
        }

        // Edits (possibly combined with append)
        return toolEditFileMulti(filePath, edits, expectedMtimeMs, appendStr || undefined);
      } catch (e) {
        return formatToolError("edit_file", e);
      }
    },
    write_file: (args) => {
      try {
        const a = expectArgsObject("write_file", args);
        const requestedPath = requiredStringArg("write_file", a, "path", { nonEmpty: true });
        const content = requiredStringArg("write_file", a, "content");
        const expectedMtimeMs = optionalIntegerArg("write_file", a, "expected_mtime_ms");
        const filePath = scopedPath(
          requestedPath,
          "write",
          ctx,
          { allowCreate: true, expectFile: true },
        );
        return toolWriteFile(filePath, content, expectedMtimeMs);
      } catch (e) {
        return formatToolError("write_file", e);
      }
    },
    bash: async (args) => {
      try {
        const a = expectArgsObject("bash", args);
        const command = requiredStringArg("bash", a, "command", { nonEmpty: true, maxLen: 20_000 });
        const timeout = optionalIntegerArg("bash", a, "timeout");
        const cwdArg = optionalStringArg("bash", a, "cwd", "");
        let cwd = "";
        if (cwdArg.trim()) {
          cwd = scopedPath(
            cwdArg,
            "list",
            ctx,
            { mustExist: true, expectDirectory: true },
          );
        }
        return await toolBash(command, timeout ?? BASH_DEFAULT_TIMEOUT, cwd);
      } catch (e) {
        return formatToolError("bash", e);
      }
    },
    time: (args) => {
      try {
        expectArgsObject("time", args);
        return toolTime();
      } catch (e) {
        return formatToolError("time", e);
      }
    },
    glob: async (args) => {
      try {
        const a = expectArgsObject("glob", args);
        const pattern = requiredStringArg("glob", a, "pattern", { nonEmpty: true });
        const requestedPath = optionalStringArg("glob", a, "path", ".");
        const globPath = scopedPath(
          requestedPath,
          "search",
          ctx,
          { mustExist: true, expectDirectory: true },
        );
        return await toolGlob(pattern, globPath);
      } catch (e) {
        return formatToolError("glob", e);
      }
    },
    grep: async (args) => {
      try {
        const a = expectArgsObject("grep", args);
        const pattern = requiredStringArg("grep", a, "pattern", { nonEmpty: true, maxLen: SEARCH_MAX_PATTERN_LENGTH });
        const requestedPath = optionalStringArg("grep", a, "path", ".");
        const searchPath = scopedPath(
          requestedPath,
          "search",
          ctx,
          { mustExist: true },
        );
        const globFilter = optionalStringArg("grep", a, "glob", "");
        const fileType = optionalStringArg("grep", a, "type", "");
        const outputMode = optionalStringArg("grep", a, "output_mode", "files_with_matches") as "content" | "files_with_matches" | "count";
        const afterCtx = optionalIntegerArg("grep", a, "-A") ?? 0;
        const beforeCtx = optionalIntegerArg("grep", a, "-B") ?? 0;
        const contextCtx = optionalIntegerArg("grep", a, "-C") ?? 0;
        const caseInsensitive = a["-i"] === true;
        const showLineNumbers = a["-n"] !== false; // default true
        const headLimit = optionalIntegerArg("grep", a, "head_limit") ?? 0;
        return await toolGrep(pattern, searchPath, {
          glob: globFilter || undefined,
          fileType: fileType || undefined,
          outputMode,
          afterContext: contextCtx > 0 ? contextCtx : afterCtx,
          beforeContext: contextCtx > 0 ? contextCtx : beforeCtx,
          caseInsensitive,
          showLineNumbers,
          headLimit,
        });
      } catch (e) {
        return formatToolError("grep", e);
      }
    },
    web_fetch: async (args) => {
      try {
        const a = expectArgsObject("web_fetch", args);
        const url = requiredStringArg("web_fetch", a, "url", { nonEmpty: true });
        const prompt = optionalStringArg("web_fetch", a, "prompt", "");
        return toolWebFetch(url, prompt || undefined);
      } catch (e) {
        return formatToolError("web_fetch", e);
      }
    },
    $web_search: (args) => toolBuiltinWebSearchPassthrough(args as Record<string, unknown>),
  };
}

/**
 * Execute a tool by name and return a `ToolResult`.
 *
 * Tool functions may return either a plain `string` (wrapped automatically)
 * or a `ToolResult` with optional action hints, tags, and metadata.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ExecuteToolContext,
): Promise<ToolResult> {
  const fn = createDispatch(ctx)[name];
  if (!fn) {
    return new ToolResult({ content: `ERROR: Unknown tool '${name}'` });
  }
  try {
    const raw = await fn(args);
    if (raw instanceof ToolResult) {
      return raw;
    }
    return new ToolResult({ content: raw });
  } catch (e) {
    return new ToolResult({
      content: `ERROR executing ${name}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
