import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const BROKEN_IMPORT = 'import("web-tree-sitter/tree-sitter.wasm", {';
const FIXED_IMPORT = 'import("web-tree-sitter/web-tree-sitter.wasm", {';

export function ensureOpenTuiWorkerPatch(): void {
  const require = createRequire(import.meta.url);
  const coreEntry = require.resolve("@opentui/core");
  const candidatePaths = [
    join(dirname(coreEntry), "parser.worker.js"),
    join(dirname(coreEntry), "lib", "tree-sitter", "parser.worker.ts"),
    join(dirname(coreEntry), "lib", "tree-sitter", "parser.worker.js"),
  ];

  for (const workerPath of candidatePaths) {
    if (!existsSync(workerPath)) {
      continue;
    }
    const source = readFileSync(workerPath, "utf8");
    if (!source.includes(BROKEN_IMPORT)) {
      continue;
    }
    writeFileSync(workerPath, source.replace(BROKEN_IMPORT, FIXED_IMPORT), "utf8");
  }
}
