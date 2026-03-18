import { ensureOpenTuiWorkerPatch } from "./ensure-opentui-worker-patch.js";

interface ParsedArgs {
  templates?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { verbose: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    if (arg === "--templates") {
      parsed.templates = argv[index + 1];
      index += 1;
    }
  }

  return parsed;
}

async function main(): Promise<void> {
  ensureOpenTuiWorkerPatch();

  const React = await import("react");
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { bootstrapOpenTuiRuntime } = await import("./bootstrap.js");
  const { OpenTuiApp } = await import("./app.js");

  process.env.OPENTUI_FORCE_EXPLICIT_WIDTH = "false";
  const args = parseArgs(process.argv.slice(2));
  const runtime = await bootstrapOpenTuiRuntime(args);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useConsole: false,
    backgroundColor: "transparent",
  });

  const root = createRoot(renderer);

  const exit = async () => {
    try {
      root.unmount();
    } catch {
      // ignore
    }
    try {
      await runtime.session.close();
    } catch {
      // ignore
    }
    renderer.destroy();
  };

  root.render(
    React.createElement(OpenTuiApp, {
      session: runtime.session,
      commandRegistry: runtime.commandRegistry,
      store: runtime.store,
      verbose: runtime.verbose,
      onExit: exit,
    }),
  );

  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve());
  });
}

main().catch((err) => {
  console.error("Fatal OpenTUI error:", err);
  process.exit(1);
});
