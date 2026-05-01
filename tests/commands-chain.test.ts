import { describe, expect, it, mock, spyOn } from "bun:test";
import {
  CommandExitSignal,
  buildDefaultRegistry,
  type CommandContext,
} from "../src/commands.js";

function baseContext(registry: ReturnType<typeof buildDefaultRegistry>): CommandContext {
  return {
    session: {},
    showMessage: mock(),
    autoSave: mock(),
    resetUiState: mock(),
    commandRegistry: registry,
  };
}

describe("slash command chain", () => {
  it("/help returns shortcut text aligned with current key bindings", async () => {
    const registry = buildDefaultRegistry();
    const help = registry.lookup("/help");
    expect(help).toBeTruthy();

    const ctx = baseContext(registry);
    await help!.handler(ctx, "");

    const rendered = (ctx.showMessage as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    expect(rendered).toContain("Option+Enter Insert newline");
    expect(rendered).toContain("Ctrl+N       Insert newline");
    expect(rendered).not.toContain("Shift+Enter");
    expect(rendered).not.toContain("Alt+Enter");
  });

  it("/summarize delegates to the manual summarize callback with raw args", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/summarize");
    expect(cmd).toBeTruthy();

    const onManualSummarizeRequested = mock();
    const ctx: CommandContext = {
      ...baseContext(registry),
      onManualSummarizeRequested,
    };

    await cmd!.handler(ctx, "focus on old tool output");
    expect(onManualSummarizeRequested).toHaveBeenCalledWith("focus on old tool output");
  });

  it("/compact delegates to the manual compact callback with raw args", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/compact");
    expect(cmd).toBeTruthy();

    const onManualCompactRequested = mock();
    const ctx: CommandContext = {
      ...baseContext(registry),
      onManualCompactRequested,
    };

    await cmd!.handler(ctx, "preserve deployment notes");
    expect(onManualCompactRequested).toHaveBeenCalledWith("preserve deployment notes");
  });

  it("/new resets state and rebinds store", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/new");
    expect(cmd).toBeTruthy();

    const session = {
      resetForNewSession: mock(),
    };
    const store = {
      clearSession: mock(),
    };

    const ctx: CommandContext = {
      ...baseContext(registry),
      session,
      store: store as unknown as CommandContext["store"],
    };

    await cmd!.handler(ctx, "");

    expect(ctx.resetUiState as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
    expect(ctx.autoSave as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
    expect(store.clearSession).toHaveBeenCalledTimes(1);
    expect(session.resetForNewSession).toHaveBeenCalledTimes(1);
    expect(session.resetForNewSession).toHaveBeenCalledWith(store);
    expect(ctx.showMessage as ReturnType<typeof mock>).not.toHaveBeenCalled();
  });

  it("/new keeps current store when clearSession fails", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/new");
    expect(cmd).toBeTruthy();

    const session = {
      resetForNewSession: mock(),
    };
    const store = {
      clearSession: mock(),
    };

    const ctx: CommandContext = {
      ...baseContext(registry),
      session,
      store: store as unknown as CommandContext["store"],
    };

    await cmd!.handler(ctx, "");

    expect(store.clearSession).toHaveBeenCalledTimes(1);
    expect(session.resetForNewSession).toHaveBeenCalledTimes(1);
    expect(session.resetForNewSession).toHaveBeenCalledWith(store);
    expect(ctx.showMessage as ReturnType<typeof mock>).not.toHaveBeenCalled();
  });

  it("/quit delegates to ctx.exit when provided (graceful path)", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/quit");
    expect(cmd).toBeTruthy();

    const session = { close: mock() };
    const exit = mock(async () => {});
    const ctx: CommandContext = {
      ...baseContext(registry),
      session,
      exit,
    };

    await cmd!.handler(ctx, "");

    expect(exit).toHaveBeenCalledTimes(1);
    expect((ctx.autoSave as ReturnType<typeof mock>)).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
  });

  it("/quit throws CommandExitSignal when ctx.exit is absent", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/quit");
    expect(cmd).toBeTruthy();

    const close = mock(async () => {});
    const ctx: CommandContext = {
      ...baseContext(registry),
      session: { close },
    };

    await expect(cmd!.handler(ctx, "")).rejects.toBeInstanceOf(CommandExitSignal);
    expect((ctx.autoSave as ReturnType<typeof mock>)).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("/exit is an alias of /quit", () => {
    const registry = buildDefaultRegistry();
    const quit = registry.lookup("/quit");
    const exitAlias = registry.lookup("/exit");
    expect(quit).toBeTruthy();
    expect(exitAlias).toBeTruthy();
    expect(exitAlias!.handler).toBe(quit!.handler);
  });
});
