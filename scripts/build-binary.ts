#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const buildDir = join(root, "build");
const binaryName = process.platform === "win32" ? "fermi.exe" : "fermi";
const binaryPath = join(buildDir, binaryName);
const entrypoint = join(root, "opentui-src", "main.tsx");
const treeSitterWorkerEntrypoint = join(root, "opentui-src", "forked", "core", "lib", "tree-sitter", "parser.worker.ts");
const treeSitterWorkerDir = join(buildDir, "tree-sitter");
const assetDirs = ["agent_templates", "prompts", "skills"] as const;
const releaseArch = process.arch === "x64" ? "x64" : process.arch;
const releaseTarball = join(buildDir, `fermi-${process.platform}-${releaseArch}.tar.gz`);

function nativeLibName(): string {
  if (process.platform === "darwin") return "libopentui.dylib";
  if (process.platform === "win32") return "opentui.dll";
  return "libopentui.so";
}

function findNativeLibrary(): string {
  const packageName = `@opentui/core-${process.platform}-${process.arch}`;
  const candidates = [
    join(root, "node_modules", packageName, nativeLibName()),
    join(root, "opentui-src", "forked", "core", "zig", "zig-out", "lib", nativeLibName()),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Could not find ${nativeLibName()} for ${process.platform}-${process.arch}. Checked:\n` +
        candidates.map((candidate) => `  - ${candidate}`).join("\n"),
    );
  }
  return found;
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} exited with code ${code}`);
  }
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

await run([
  "bun",
  "build",
  "--compile",
  "--outfile",
  binaryPath,
  "--external",
  "youtube-transcript",
  "--external",
  "unzipper",
  entrypoint,
]);

mkdirSync(treeSitterWorkerDir, { recursive: true });
await run([
  "bun",
  "build",
  "--target",
  "bun",
  "--outdir",
  treeSitterWorkerDir,
  treeSitterWorkerEntrypoint,
]);

for (const dir of assetDirs) {
  cpSync(join(root, dir), join(buildDir, dir), {
    recursive: true,
    dereference: true,
    filter: (source) => basename(source) !== ".DS_Store",
  });
}

const nativeSource = findNativeLibrary();
const nativeTargetDir = join(buildDir, "native", `${process.platform}-${process.arch}`);
mkdirSync(nativeTargetDir, { recursive: true });
cpSync(nativeSource, join(nativeTargetDir, basename(nativeSource)), { dereference: true });

await run([
  "tar",
  "-czf",
  releaseTarball,
  "-C",
  buildDir,
  binaryName,
  "native",
  "tree-sitter",
  ...assetDirs,
]);

console.log(`Built ${binaryPath}`);
console.log(`Copied runtime assets to ${buildDir}`);
console.log(`Packaged ${releaseTarball}`);
