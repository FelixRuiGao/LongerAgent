import { describe, expect, it, vi } from "vitest";
import { buildDefaultRegistry, type CommandContext } from "../src/commands.js";

function makeContext(
  registry: ReturnType<typeof buildDefaultRegistry>,
  session: Record<string, unknown>,
): CommandContext {
  return {
    session,
    showMessage: vi.fn(),
    autoSave: vi.fn(),
    resetUiState: vi.fn(),
    commandRegistry: registry,
  };
}

describe("/mcp command", () => {
  it("connects MCP servers before listing tools", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/mcp");
    expect(cmd).toBeTruthy();

    const tools: Array<{ name: string }> = [];
    const ensureMcpReady = vi.fn(async () => {
      tools.push({ name: "mcp__sqlite__query" });
      tools.push({ name: "mcp__sqlite__schema" });
    });
    const session = {
      ensureMcpReady,
      mcpManager: {
        getAllTools: () => tools,
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "");

    expect(ensureMcpReady).toHaveBeenCalledTimes(1);
    const rendered = (ctx.showMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(rendered).toContain("sqlite");
    expect(rendered).toContain("query");
  });
});
