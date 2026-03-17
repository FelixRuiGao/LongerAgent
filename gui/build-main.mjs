/**
 * Build the Electron main process using esbuild.
 *
 * Bundles gui/main/main.ts + all src/ dependencies into a single file
 * at gui/dist-main/main.js, externalizing only electron and Node builtins.
 */

import { build } from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build main process
await build({
  entryPoints: [resolve(__dirname, "main/main.ts")],
  outfile: resolve(__dirname, "dist-main/main.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  // Resolve packages from the root project's node_modules
  nodePaths: [resolve(__dirname, "..", "node_modules")],
  external: [
    "electron",
    // Node builtins
    "node:*",
    "fs", "path", "os", "crypto", "child_process", "http", "https", "net",
    "tls", "url", "util", "events", "stream", "buffer", "string_decoder",
    "zlib", "querystring", "assert", "readline", "worker_threads",
    // Native modules that can't be bundled
    "fsevents",
    // Optional peer deps
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    // Optional deps of markitdown-ts
    "youtube-transcript",
    "unzipper",
  ],
  alias: {
    "ink": resolve(__dirname, "main/stubs/ink-stub.ts"),
    "marked-terminal": resolve(__dirname, "main/stubs/marked-terminal-stub.ts"),
  },
  banner: {
    js: `
import { createRequire as _createRequire } from "module";
import { fileURLToPath as _fileURLToPath } from "url";
import { dirname as _dirname } from "path";
const __filename = _fileURLToPath(import.meta.url);
const __dirname = _dirname(__filename);
const require = _createRequire(import.meta.url);
`,
  },
  logLevel: "info",
});

// Build preload script (separate file, loaded by BrowserWindow)
await build({
  entryPoints: [resolve(__dirname, "main/preload.ts")],
  outfile: resolve(__dirname, "dist-main/preload.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",  // preload scripts must be CJS for contextBridge
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
});
