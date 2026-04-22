#!/usr/bin/env bun
import { rmSync, chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const DIST = resolve(ROOT, "dist");
const DYLIB = resolve(ROOT, "opentui-src", "core", "zig", "lib", "aarch64-macos", "libopentui.dylib");

if (!existsSync(DYLIB)) {
  console.error(`fatal: native dylib missing at ${DYLIB}`);
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });

execSync("npx tsc -p tsconfig.build.json", { cwd: ROOT, stdio: "inherit" });

chmodSync(resolve(DIST, "cli.js"), 0o755);

console.log("Build complete: dist/ (tsc emit) + opentui-src/ (shipped as TS source)");
