import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../src/persistence.js";
import { Session } from "../src/session.js";
import { ToolResult } from "../src/providers/base.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(projectRoot: string): Session {
  const primaryAgent = {
    name: "Primary",
    systemPrompt: "You are a test agent.",
    tools: [],
    modelConfig: {
      model: "test-model",
      contextLength: 8192,
      supportsMultimodal: false,
    },
  } as any;

  const store = new SessionStore({ baseDir: projectRoot, projectPath: projectRoot });
  store.createSession();
  const config = {
    mcpServerConfigs: [],
    getModel: () => ({ model: "test" }),
  } as any;

  return new Session({
    primaryAgent,
    config,
    store,
  });
}

describe("background shell tools", () => {
  it("tracks shell lifecycle and exposes output via bash_output", async () => {
    const root = makeTempDir("fermi-shell-root-");
    const session = makeSession(root);
    try {
      const started = (session as any)._shellManager.execBashBackground({
        id: "demo",
        command: "printf 'hello\\n'; sleep 0.2; printf 'done\\n'",
      }) as ToolResult;
      expect(started.content).toContain("Started background shell 'demo'");

      const waited = await (session as any)._execAwaitEvent({ seconds: 15 }) as ToolResult;
      // await_event wakes on system_notice (shell exit) and/or shell-state racers; shell lines use
      // _buildShellReport() which does not prefix "# Shell" (that header is show_context only).
      expect(waited.content).toMatch(/Waited —/);
      expect(waited.content).toContain("[demo]");
      expect(waited.content).toContain("exited");

      const output = (session as any)._shellManager.execBashOutput({ id: "demo" }) as ToolResult;
      expect(output.content).toContain("hello");
      expect(output.content).toContain("done");
      expect(output.content).toContain("status:");
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("truncates unread shell output and advances the unread cursor", async () => {
    const root = makeTempDir("fermi-shell-trunc-root-");
    const session = makeSession(root);
    try {
      const command = "i=1; while [ $i -le 120 ]; do printf 'line-%03d\\n' \"$i\"; i=$((i+1)); done";
      (session as any)._shellManager.execBashBackground({ id: "burst", command });
      await (session as any)._execAwaitEvent({ seconds: 15 });

      const first = (session as any)._shellManager.execBashOutput({ id: "burst", max_chars: 120 }) as ToolResult;
      expect(first.content).toContain("line-001");
      expect(first.content).toContain("[Truncated here because unread output exceeded");

      const second = (session as any)._shellManager.execBashOutput({ id: "burst", max_chars: 120 }) as ToolResult;
      expect(second.content).toContain("(No new output since the last read.)");
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
