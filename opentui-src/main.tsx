import {
  getFermiAssistantRenderer,
  getFermiOpenTuiDiagPath,
  isFermiMarkdownPatchDisabled,
  isFermiOpenTuiDiagEnabled,
  resetFermiOpenTuiDiagLog,
  writeFermiOpenTuiDiag,
} from "./forked/core/lib/diagnostic.js";

interface ParsedArgs {
  templates?: string;
  verbose: boolean;
}

const SESSION_CLOSE_TIMEOUT_MS = 150;

function resolveRendererThreadSetting(): boolean {
  const override = process.env.FERMI_OPENTUI_USE_THREAD?.trim().toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;

  // Native render threading has been unstable on macOS in Fermi's
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

export async function launchTui(): Promise<void> {
  const React = await import("react");
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { bootstrapOpenTuiRuntime } = await import("./bootstrap.js");
  const { OpenTuiApp } = await import("./app.js");

  process.env.OPENTUI_FORCE_EXPLICIT_WIDTH = "false";
  const args = parseArgs(process.argv.slice(2));
  if (isFermiOpenTuiDiagEnabled()) {
    resetFermiOpenTuiDiagLog({
      cwd: process.cwd(),
      diagPath: getFermiOpenTuiDiagPath(),
      platform: process.platform,
      assistantRenderer: getFermiAssistantRenderer(),
      markdownPatchDisabled: isFermiMarkdownPatchDisabled(),
    });
  }
  const runtime = await bootstrapOpenTuiRuntime(args);
  const useThread = resolveRendererThreadSetting();
  writeFermiOpenTuiDiag("main.bootstrap", {
    verbose: args.verbose,
    templates: args.templates ?? null,
    useThread,
  });
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    consoleMode: "disabled",
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
    writeFermiOpenTuiDiag("main.fatal", {
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
    writeFermiOpenTuiDiag("main.exit", {
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

// Only auto-invoke when this module is executed directly (e.g. `bun run
// opentui-src/main.tsx`). When it is imported by `src/cli.ts`, the CLI calls
// `launchTui()` itself and we must not start a second instance here.
function isDirectEntry(): boolean {
  // Bun exposes `import.meta.main` for direct-script detection.
  const metaMain = (import.meta as { main?: boolean }).main;
  if (typeof metaMain === "boolean") return metaMain;

  // Node fallback: compare the module URL to process.argv[1].
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const { realpathSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const moduleFile = fileURLToPath(import.meta.url);
    const entryFile = resolve(entry);
    try {
      return realpathSync(moduleFile) === realpathSync(entryFile);
    } catch {
      return moduleFile === entryFile;
    }
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  launchTui().catch((err) => {
    writeFermiOpenTuiDiag("main.catch", {
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });
    console.error("Fatal OpenTUI error:", err);
    process.exit(1);
  });
}
