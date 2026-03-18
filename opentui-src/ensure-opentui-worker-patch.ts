import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const BROKEN_IMPORT = 'import("web-tree-sitter/tree-sitter.wasm", {';
const FIXED_IMPORT = 'import("web-tree-sitter/web-tree-sitter.wasm", {';

export function ensureOpenTuiWorkerPatch(): void {
  const require = createRequire(import.meta.url);
  const coreEntry = require.resolve("@opentui/core");
  const workerPath = join(dirname(coreEntry), "parser.worker.js");
  const source = readFileSync(workerPath, "utf8");

  if (!source.includes(BROKEN_IMPORT)) {
    return;
  }

  writeFileSync(workerPath, source.replace(BROKEN_IMPORT, FIXED_IMPORT), "utf8");
}
