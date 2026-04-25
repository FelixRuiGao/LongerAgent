/**
 * Hook command runner.
 *
 * Spawns a hook command, writes the event payload as JSON to stdin,
 * reads JSON output from stdout, enforces timeout.
 */

import { spawn } from "node:child_process";
import type { HookManifest, HookPayload, HookOutput } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface HookRunResult {
  success: boolean;
  output: HookOutput;
  error?: string;
  durationMs: number;
}

/**
 * Execute a hook command and parse its JSON output.
 */
export async function runHookCommand(
  manifest: HookManifest,
  payload: HookPayload,
): Promise<HookRunResult> {
  const startMs = Date.now();
  const timeoutMs = manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<HookRunResult>((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ...manifest.env };
    let child;
    try {
      child = spawn(manifest.command, manifest.args ?? [], {
        env,
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs,
      });
    } catch (e) {
      resolve({
        success: false,
        output: {},
        error: `Failed to spawn: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: Date.now() - startMs,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: HookRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      settle({
        success: false,
        output: {},
        error: `Hook "${manifest.name}" timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - startMs,
      });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;

      if (code !== 0) {
        settle({
          success: false,
          output: {},
          error: `Hook "${manifest.name}" exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
          durationMs,
        });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        settle({ success: true, output: {}, durationMs });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const output: HookOutput = {};

        if (parsed["decision"] === "allow" || parsed["decision"] === "deny") {
          output.decision = parsed["decision"] as "allow" | "deny";
        }
        if (typeof parsed["updatedInput"] === "object" && parsed["updatedInput"] !== null) {
          output.updatedInput = parsed["updatedInput"] as Record<string, unknown>;
        }
        if (typeof parsed["additionalContext"] === "string") {
          output.additionalContext = parsed["additionalContext"];
        }
        if (typeof parsed["reason"] === "string") {
          output.reason = parsed["reason"];
        }

        settle({ success: true, output, durationMs });
      } catch {
        settle({
          success: false,
          output: {},
          error: `Hook "${manifest.name}" returned invalid JSON: ${trimmed.slice(0, 100)}`,
          durationMs,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        success: false,
        output: {},
        error: `Hook "${manifest.name}" error: ${err.message}`,
        durationMs: Date.now() - startMs,
      });
    });

    // Write payload to stdin
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // stdin may already be closed if process exited immediately
    }
  });
}
