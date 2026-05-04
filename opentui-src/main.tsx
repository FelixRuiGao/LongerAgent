import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  configOverrides: string[];
  verbose: boolean;
}

const SESSION_CLOSE_TIMEOUT_MS = 150;

async function prewarmCompiledOpenTuiCore(): Promise<void> {
  if (!fileURLToPath(import.meta.url).includes("$bunfs")) return;

  // Bun's compiled bundler can initialize @opentui/react before async
  // @opentui/core re-exports settle. Import the concrete modules first so
  // React receives initialized renderable constructors from the package barrel.
  await Promise.all([
    import("./forked/core/Renderable.js"),
    import("./forked/core/renderer.js"),
    import("./forked/core/animation/Timeline.js"),
    import("./forked/core/renderables/ASCIIFont.js"),
    import("./forked/core/renderables/Box.js"),
    import("./forked/core/renderables/Code.js"),
    import("./forked/core/renderables/Diff.js"),
    import("./forked/core/renderables/Input.js"),
    import("./forked/core/renderables/LineNumberRenderable.js"),
    import("./forked/core/renderables/Markdown.js"),
    import("./forked/core/renderables/ScrollBox.js"),
    import("./forked/core/renderables/Select.js"),
    import("./forked/core/renderables/TabSelect.js"),
    import("./forked/core/renderables/Text.js"),
    import("./forked/core/renderables/Textarea.js"),
    import("./forked/core/renderables/TextNode.js"),
    import("./forked/core/renderables/TimeToFirstDraw.js"),
  ]);
}

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
  const parsed: ParsedArgs = { configOverrides: [], verbose: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    if (arg === "--templates") {
      parsed.templates = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      if (argv[index + 1]) {
        parsed.configOverrides.push(argv[index + 1]!);
        index += 1;
      }
      continue;
    }
  }

  return parsed;
}

export async function launchTui(): Promise<void> {
  await prewarmCompiledOpenTuiCore();

  const React = await import("react");
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { bootstrapOpenTuiRuntime } = await import("./bootstrap.js");
  const { OpenTuiApp } = await import("./app.js");
  const { parseSettingsOverrides } = await import("../src/persistence.js");

  process.env.OPENTUI_FORCE_EXPLICIT_WIDTH = "false";
  const args = parseArgs(process.argv.slice(2));
  // Validate -c overrides before bootstrap so a bad value fails with a
  // clean stderr line rather than a fatal stack trace from inside bootstrap.
  try {
    parseSettingsOverrides(args.configOverrides);
  } catch (err) {
    process.stderr.write(`fermi: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
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

  // If `fermi --resume <id>` set this in cli.ts, restore the session log
  // into the freshly bootstrapped runtime before the TUI renders.
  const resumeDir = process.env["FERMI_RESUME_SESSION_DIR"];
  if (resumeDir) {
    delete process.env["FERMI_RESUME_SESSION_DIR"];
    const { applySessionRestore } = await import("../src/session-resume.js");
    const result = applySessionRestore(runtime.session, runtime.store, resumeDir);
    if (!result.ok && result.error) {
      console.error(result.error);
      process.exit(1);
    }
    for (const w of result.warnings) console.warn(w);
  }

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

  // Resolve effective theme mode BEFORE mounting React so the first frame
  // already uses the correct palette. With a transparent background, rendering
  // the wrong palette on the wrong terminal would be unreadable, so we must
  // never paint contents in an unresolved state.
  const { resolveThemeMode } = await import("./resolve-theme-mode.js");
  const resolved = await resolveThemeMode(renderer, runtime.themeModePref);
  writeFermiOpenTuiDiag("main.theme", {
    pref: resolved.pref,
    mode: resolved.mode,
    source: resolved.source,
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

    // Resume hint — only if a log was actually written for this session
    // (i.e. the user sent at least one message). New sessions that never
    // got past the prompt don't have a log.json, so there's nothing to resume.
    const sessionDir = runtime.store.sessionDir;
    if (sessionDir && existsSync(join(sessionDir, "log.json"))) {
      try {
        process.stdout.write(`\nTo continue this session, run \nfermi --resume ${basename(sessionDir)}\n`);
      } catch {
        // ignore
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
      themeMode: resolved.mode,
      themeModePref: resolved.pref,
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

// Subcommands handled by the Commander-based CLI in src/cli.ts.
// The compiled binary uses main.tsx as its entry, so we route these
// argv prefixes through cli.ts which knows the full command surface
// (init, oauth, fix, update, --help, etc.). Bare `fermi` (no args, or
// only options like --verbose / -c) goes straight to launchTui below.
const CLI_SUBCOMMANDS = new Set([
  "init",
  "oauth",
  "fix",
  "update",
  "--help",
  "-h",
  "help",
]);

if (isDirectEntry()) {
  const firstArg = process.argv[2];
  if (firstArg === "--version" || firstArg === "-v") {
    void import("../src/version.js").then(({ VERSION }) => {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    });
  } else if (firstArg && CLI_SUBCOMMANDS.has(firstArg)) {
    void import("../src/cli.js")
      .then(({ main }) => main())
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
  } else {
    launchTui().catch((err) => {
      writeFermiOpenTuiDiag("main.catch", {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      console.error("Fatal OpenTUI error:", err);
      process.exit(1);
    });
  }
}
