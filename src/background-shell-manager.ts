/**
 * Background shell lifecycle manager.
 *
 * Owns spawning, tracking, reading output from, and killing
 * background shell processes.  Extracted from Session to keep
 * the god-file smaller and the responsibility boundary clear.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { ToolResult } from "./providers/base.js";
import { SafePathError, safePath } from "./security/path.js";
import { buildBashEnv } from "./tools/basic.js";
import {
  argOptionalInteger,
  argOptionalString,
  argRequiredString,
  argRequiredStringArray,
  toolArgError,
} from "./tools/arg-helpers.js";
import type { MessageEnvelope } from "./session-tree-types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface BackgroundShellEntry {
  id: string;
  process: ChildProcess;
  command: string;
  cwd: string;
  logPath: string;
  startTime: number;
  status: "running" | "exited" | "failed" | "killed";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  readOffset: number;
  recentOutput: string[];
  explicitKill: boolean;
}

export interface BackgroundShellManagerDeps {
  projectRoot: string;
  getSessionArtifactsDir: () => string;
  deliverMessage: (msg: MessageEnvelope) => void;
}

// ── Manager ──────────────────────────────────────────────────────────

export class BackgroundShellManager {
  private _activeShells = new Map<string, BackgroundShellEntry>();
  private _shellCounter = 0;

  private readonly _projectRoot: string;
  private readonly _getSessionArtifactsDir: () => string;
  private readonly _deliverMessage: (msg: MessageEnvelope) => void;

  constructor(deps: BackgroundShellManagerDeps) {
    this._projectRoot = deps.projectRoot;
    this._getSessionArtifactsDir = deps.getSessionArtifactsDir;
    this._deliverMessage = deps.deliverMessage;
  }

  // ── Public queries ─────────────────────────────────────────────────

  hasTrackedShells(): boolean {
    return this._activeShells.size > 0;
  }

  hasRunningShells(): boolean {
    for (const entry of this._activeShells.values()) {
      if (entry.status === "running") return true;
    }
    return false;
  }

  buildShellReport(): string {
    if (this._activeShells.size === 0) {
      return "No shells tracked.";
    }

    const lines: string[] = [];
    for (const [id, entry] of this._activeShells) {
      const elapsedSec = ((performance.now() - entry.startTime) / 1000).toFixed(1);
      let line = `- [${id}] ${entry.status} (${elapsedSec}s)`;
      if (entry.status === "exited" || entry.status === "failed") {
        line += ` | exit=${entry.exitCode ?? "?"}`;
      } else if (entry.status === "killed") {
        line += ` | signal=${entry.signal ?? "TERM"}`;
      }
      line += ` | log: ${entry.logPath}`;
      if (entry.recentOutput.length > 0) {
        line += `\n    recent: ${entry.recentOutput.join(" → ")}`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  /**
   * Best-effort SIGTERM + clear for all tracked shells.
   * Also resets the shell counter.
   */
  forceKillAll(): void {
    for (const entry of this._activeShells.values()) {
      if (entry.status === "running") {
        entry.explicitKill = true;
        try {
          entry.process.kill("SIGTERM");
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    this._activeShells.clear();
  }

  /**
   * Reset the shell counter (called when transient state is cleared).
   */
  resetCounter(): void {
    this._shellCounter = 0;
  }

  // ── Tool executors ─────────────────────────────────────────────────

  execBashBackground(args: Record<string, unknown>): ToolResult {
    const commandArg = argRequiredString("bash_background", args, "command", { nonEmpty: true });
    if (commandArg instanceof ToolResult) return commandArg;
    const cwdArg = argOptionalString("bash_background", args, "cwd");
    if (cwdArg instanceof ToolResult) return cwdArg;
    const idArg = argOptionalString("bash_background", args, "id");
    if (idArg instanceof ToolResult) return idArg;

    const shellId = idArg
      ? this._normalizeShellId(idArg)
      : `shell-${++this._shellCounter}`;
    if (!shellId) {
      return toolArgError("bash_background", "'id' must contain only letters, numbers, '.', '_' or '-'.");
    }
    if (this._activeShells.has(shellId)) {
      return new ToolResult({ content: `Error: shell '${shellId}' is already tracked.` });
    }

    const cwd = this._resolveShellCwd("bash_background", cwdArg);
    if (cwd instanceof ToolResult) return cwd;

    const logPath = join(this._getShellsDir(), `${shellId}.log`);
    writeFileSync(logPath, "", "utf-8");

    let child: ChildProcess;
    try {
      child = spawn("sh", ["-lc", commandArg], {
        cwd,
        env: buildBashEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return new ToolResult({ content: `Error: failed to start background shell: ${e}` });
    }

    const entry: BackgroundShellEntry = {
      id: shellId,
      process: child,
      command: commandArg,
      cwd,
      logPath,
      startTime: performance.now(),
      status: "running",
      exitCode: null,
      signal: null,
      readOffset: 0,
      recentOutput: [],
      explicitKill: false,
    };
    this._activeShells.set(shellId, entry);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      this._recordShellChunk(entry, text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      this._recordShellChunk(entry, text);
    });
    child.on("error", (error) => {
      entry.status = "failed";
      entry.exitCode = 1;
      entry.signal = null;
      this._deliverMessage({
        type: "system_notice", sender: "system", timestamp: Date.now(),
        content: `Background shell '${shellId}' failed to start: ${error}. Use \`bash_output(id="${shellId}")\` to inspect ${logPath}.`,
      });
    });
    child.on("close", (code, signal) => {
      entry.exitCode = code;
      entry.signal = signal;
      if (entry.explicitKill) {
        entry.status = "killed";
      } else if (code === 0) {
        entry.status = "exited";
      } else {
        entry.status = "failed";
      }
      // Skip notification for explicit kills — the kill_shell tool result
      // already reports the outcome synchronously.
      if (entry.explicitKill) return;
      const statusText = entry.status === "exited"
        ? "completed successfully"
        : `failed (exit ${code ?? 1})`;
      this._deliverMessage({
        type: "system_notice", sender: "system", timestamp: Date.now(),
        content: `Background shell '${shellId}' ${statusText}. Use \`bash_output(id="${shellId}")\` to inspect logs at ${logPath}.`,
      });
    });

    return new ToolResult({
      content:
        `Started background shell '${shellId}'.\n` +
        `cwd: ${cwd}\n` +
        `log: ${logPath}\n` +
        `Use \`bash_output(id="${shellId}")\` to inspect logs and \`wait(shell="${shellId}", seconds=60)\` to wait for exit.`,
    });
  }

  execBashOutput(args: Record<string, unknown>): ToolResult {
    const idArg = argRequiredString("bash_output", args, "id", { nonEmpty: true });
    if (idArg instanceof ToolResult) return idArg;
    const tailLinesArg = argOptionalInteger("bash_output", args, "tail_lines");
    if (tailLinesArg instanceof ToolResult) return tailLinesArg;
    const maxCharsArg = argOptionalInteger("bash_output", args, "max_chars");
    if (maxCharsArg instanceof ToolResult) return maxCharsArg;

    const entry = this._activeShells.get(idArg);
    if (!entry) {
      return new ToolResult({ content: `Error: shell '${idArg}' not found.` });
    }

    const maxChars = Math.max(500, Math.min(50_000, maxCharsArg ?? 8_000));
    const fullText = existsSync(entry.logPath) ? readFileSync(entry.logPath, "utf-8") : "";
    let body = "";

    if (tailLinesArg !== undefined) {
      const lines = fullText.split("\n");
      body = lines.slice(-Math.max(1, tailLinesArg)).join("\n").trimEnd();
    } else {
      const fullBuffer = Buffer.from(fullText, "utf-8");
      const unread = fullBuffer.subarray(entry.readOffset).toString("utf-8");
      entry.readOffset = fullBuffer.length;
      if (!unread.trim()) {
        body = "(No new output since the last read.)";
      } else if (unread.length > maxChars) {
        const visible = unread.slice(0, maxChars);
        const omittedChars = unread.length - visible.length;
        const omittedLines = unread.slice(visible.length).split("\n").filter(Boolean).length;
        body =
          `${visible.trimEnd()}\n\n` +
          `[Truncated here because unread output exceeded ${maxChars} chars; skipped ${omittedChars.toLocaleString()} chars` +
          (omittedLines > 0 ? ` / ${omittedLines.toLocaleString()} lines` : "") +
          `. Full log: ${entry.logPath}]`;
      } else {
        body = unread.trimEnd();
      }
    }

    return new ToolResult({
      content:
        `# Shell Output\n` +
        `id: ${entry.id}\n` +
        `status: ${entry.status}\n` +
        `log: ${entry.logPath}\n\n` +
        `${body || "(No output yet.)"}`,
    });
  }

  async execKillShell(args: Record<string, unknown>): Promise<ToolResult> {
    const idsArg = argRequiredStringArray("kill_shell", args, "ids");
    if (idsArg instanceof ToolResult) return idsArg;
    const signalArg = argOptionalString("kill_shell", args, "signal");
    if (signalArg instanceof ToolResult) return signalArg;
    const rawSignal = (signalArg?.trim() || "SIGTERM").toUpperCase();
    const signal = (rawSignal.startsWith("SIG") ? rawSignal : `SIG${rawSignal}`) as NodeJS.Signals;

    const KILL_WAIT_MS = 3_000;
    const parts: string[] = [];
    const waitPromises: Promise<void>[] = [];

    for (const id of idsArg) {
      const entry = this._activeShells.get(id);
      if (!entry) {
        parts.push(`'${id}': not found.`);
        continue;
      }
      if (entry.status !== "running") {
        parts.push(`'${id}': already ${entry.status}.`);
        continue;
      }
      entry.explicitKill = true;
      try {
        entry.process.kill(signal);
      } catch (e) {
        parts.push(`'${id}': failed to send ${signal} (${e}).`);
        continue;
      }
      // Wait for exit or timeout, then SIGKILL if still alive.
      const idx = parts.length;
      parts.push(""); // placeholder
      waitPromises.push(
        new Promise<void>((resolve) => {
          if (entry.status !== "running") {
            parts[idx] = `'${id}': ${entry.status} (exit ${entry.exitCode ?? entry.signal ?? "?"}).`;
            resolve();
            return;
          }
          const onClose = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            entry.process.removeListener("close", onClose);
            try { entry.process.kill("SIGKILL"); } catch { /* best effort */ }
            parts[idx] = `'${id}': SIGKILL after ${KILL_WAIT_MS}ms timeout.`;
            // Wait briefly for SIGKILL to take effect
            entry.process.once("close", () => resolve());
            setTimeout(resolve, 500); // fallback if close never fires
          }, KILL_WAIT_MS);
          entry.process.once("close", () => {
            clearTimeout(timer);
            parts[idx] = `'${id}': ${entry.status} (${entry.signal ?? `exit ${entry.exitCode}`}).`;
            resolve();
          });
        }),
      );
    }

    await Promise.all(waitPromises);
    return new ToolResult({ content: parts.join(" ") || "No shells specified." });
  }

  // ── Private helpers ────────────────────────────────────────────────

  private _getShellsDir(): string {
    const dir = join(this._getSessionArtifactsDir(), "shells");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private _normalizeShellId(id: string): string | null {
    const trimmed = id.trim();
    if (!trimmed) return null;
    return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
  }

  private _recordShellChunk(entry: BackgroundShellEntry, chunk: string): void {
    if (!chunk) return;
    appendFileSync(entry.logPath, chunk, "utf-8");
    const lines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      entry.recentOutput.push(line);
      if (entry.recentOutput.length > 3) entry.recentOutput.shift();
    }
  }

  private _resolveShellCwd(toolName: string, requested?: string): string | ToolResult {
    const trimmed = (requested ?? "").trim();
    if (!trimmed) {
      return this._projectRoot;
    }

    try {
      return safePath({
        baseDir: this._projectRoot,
        requestedPath: trimmed,
        cwd: this._projectRoot,
        mustExist: true,
        expectDirectory: true,
        accessKind: "list",
      }).safePath!;
    } catch (err) {
      if (!(err instanceof SafePathError)) throw err;
      try {
        return safePath({
          baseDir: this._getSessionArtifactsDir(),
          requestedPath: trimmed,
          cwd: this._getSessionArtifactsDir(),
          mustExist: true,
          expectDirectory: true,
          accessKind: "list",
        }).safePath!;
      } catch (inner) {
        if (inner instanceof SafePathError) {
          return new ToolResult({
            content: `Error: invalid arguments for ${toolName}: cwd must stay within the project root or SESSION_ARTIFACTS.`,
          });
        }
        throw inner;
      }
    }
  }
}
