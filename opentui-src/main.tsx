import { ensureOpenTuiWorkerPatch } from "./ensure-opentui-worker-patch.js";
import {
  getLongerAgentAssistantRenderer,
  getLongerAgentOpenTuiDiagPath,
  isLongerAgentMarkdownPatchDisabled,
  isLongerAgentOpenTuiDiagEnabled,
  resetLongerAgentOpenTuiDiagLog,
  writeLongerAgentOpenTuiDiag,
} from "./forked/core/lib/diagnostic.js";

interface ParsedArgs {
  templates?: string;
  verbose: boolean;
}

const SESSION_CLOSE_TIMEOUT_MS = 150;

function resolveRendererThreadSetting(): boolean {
  const override = process.env.LONGERAGENT_OPENTUI_USE_THREAD?.trim().toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;

  // Native render threading has been unstable on macOS in LongerAgent's
  // high-frequency streaming UI. Prefer the single-threaded renderer there
  // unless the user explicitly opts back in.
  return process.platform !== "darwin";
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
  if (isLongerAgentOpenTuiDiagEnabled()) {
    resetLongerAgentOpenTuiDiagLog({
      cwd: process.cwd(),
      diagPath: getLongerAgentOpenTuiDiagPath(),
      platform: process.platform,
      assistantRenderer: getLongerAgentAssistantRenderer(),
      markdownPatchDisabled: isLongerAgentMarkdownPatchDisabled(),
    });
  }
  const runtime = await bootstrapOpenTuiRuntime(args);
  const useThread = resolveRendererThreadSetting();
  writeLongerAgentOpenTuiDiag("main.bootstrap", {
    verbose: args.verbose,
    templates: args.templates ?? null,
    useThread,
  });
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useConsole: false,
    backgroundColor: "transparent",
    useThread,
  });

  const root = createRoot(renderer);
  let exiting = false;
  let fatalCleaningUp = false;

  const cleanupTerminalAfterFatal = () => {
    if (fatalCleaningUp) return;
    fatalCleaningUp = true;

    try {
      root.unmount();
    } catch {
      // ignore
    }

    try {
      renderer.destroy();
    } catch {
      // ignore
    }
  };

  const handleFatal = (err: unknown) => {
    writeLongerAgentOpenTuiDiag("main.fatal", {
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });
    cleanupTerminalAfterFatal();
    console.error("Fatal OpenTUI error:", err);
    process.exit(1);
  };

  process.on("uncaughtException", handleFatal);
  process.on("unhandledRejection", handleFatal);

  const exit = async (farewell?: string) => {
    if (exiting) return;
    exiting = true;
    writeLongerAgentOpenTuiDiag("main.exit", {
      farewell: farewell ?? null,
    });

    // 1. Restore terminal immediately
    try {
      root.unmount();
    } catch {
      // ignore
    }

    try {
      renderer.destroy();
    } catch {
      // ignore
    }

    if (farewell) {
      try {
        process.stdout.write(`\n${farewell}\n`);
      } catch {
        console.log(farewell);
      }
    }

    // 2. Best-effort session cleanup, then exit no matter what
    runtime.session.close().catch(() => {});
    process.exit(0);
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

  process.off("uncaughtException", handleFatal);
  process.off("unhandledRejection", handleFatal);
}

main().catch((err) => {
  writeLongerAgentOpenTuiDiag("main.catch", {
    error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
  });
  console.error("Fatal OpenTUI error:", err);
  process.exit(1);
});
