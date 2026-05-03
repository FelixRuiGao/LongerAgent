/**
 * Tool classification -- maps a tool call to a PermissionClass.
 *
 * Uses tree-sitter-bash exclusively for AST-accurate bash command parsing.
 * The sync classifyTool returns a conservative write_potent for bash;
 * all real bash classification goes through classifyToolAsync.
 *
 * Bash risk tiers with git subcommand awareness:
 *   safe -> write_reversible -> write_potent -> write_danger -> catastrophic
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { InvocationAssessment, PermissionClass } from "./types.js";
import type { ParsedBashCommand, ParsedBashSegment } from "./bash/types.js";
import { parseTrackableBashMutation } from "../tools/basic.js";
import { resolveCdContextParsed } from "./cd-context.js";

// ------------------------------------------------------------------
// Tree-sitter parser (lazy async init)
// ------------------------------------------------------------------

let parserReady: Promise<typeof import("./bash/parser.js")> | null = null;
let parserModule: typeof import("./bash/parser.js") | null = null;

export function initBashParser(): void {
  if (parserReady) return;
  parserReady = import("./bash/parser.js").then(async (mod) => {
    await mod.getParser();
    parserModule = mod;
    return mod;
  }).catch((err) => {
    console.warn("tree-sitter bash parser failed to load:", err);
    parserModule = null;
    return null as any;
  });
}

// ------------------------------------------------------------------
// Static tool classification
// ------------------------------------------------------------------

const READ_TOOLS = new Set([
  "read_file", "list_dir", "glob", "grep",
  "web_fetch", "web_search", "$web_search",
  "show_context", "summarize",
  "ask", "check_status", "await_event", "send",
  "bash_output", "skill", "time",
  "kill_shell",
]);

const WRITE_REVERSIBLE_TOOLS = new Set([
  "write_file", "edit_file",
]);

const SPAWN_TOOLS = new Set([
  "spawn",
]);

const WRITE_DANGER_TOOLS = new Set([
  "kill_agent",
]);

// ------------------------------------------------------------------
// Bash command sets
// ------------------------------------------------------------------

const BASH_SAFE_COMMANDS = new Set([
  "ls", "ll", "la", "dir", "cat", "head", "tail", "less", "more",
  "wc", "file", "stat", "readlink", "realpath", "basename", "dirname",
  "tree",
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "pwd", "whoami", "hostname", "uname", "arch", "id", "groups",
  "which", "where", "whence", "type", "command",
  "echo", "printf", "true", "false", "test", "[", "[[", "expr", "seq",
  "sort", "uniq", "cut", "tr", "paste", "nl", "rev", "fmt",
  "comm", "cmp", "diff",
  "jq", "yq",
  "date", "env", "printenv", "uptime", "ps", "df", "du", "free",
  "lsof", "pgrep", "tput",
  "md5sum", "sha256sum", "shasum", "base64",
  "sleep", "tee",
  "cd",
]);

const BASH_REVERSIBLE_COMMANDS = new Set(["mkdir"]);
const BASH_DYNAMIC_REVERSIBLE = new Set(["cp", "mv"]);

const BASH_DANGER_COMMANDS = new Set([
  "rm", "rmdir",
  "sudo", "su", "doas",
  "chmod", "chown", "chgrp",
  "kill", "killall", "pkill",
  "reboot", "shutdown", "halt", "poweroff", "init",
  "mount", "umount",
  "iptables", "ip6tables", "nft",
  "systemctl", "service", "launchctl",
  "useradd", "userdel", "usermod", "groupadd", "groupdel",
  "passwd",
  "crontab",
]);

const BASH_POTENT_COMMANDS = new Set([
  "touch", "ln",
  "npm", "npx", "pnpm", "yarn", "bun",
  "pip", "pip3", "uv",
  "cargo", "go",
  "python", "python3", "node", "deno",
  "ruby", "gem", "bundle",
  "java", "javac", "gradle", "mvn",
  "gcc", "g++", "clang", "clang++",
  "make", "cmake",
  "rustc",
  "docker", "podman", "kubectl",
  "bash", "sh", "zsh",
  "sed", "awk", "xargs",
  "curl", "wget",
  "tar", "gzip", "gunzip", "bzip2", "xz", "unzip", "zip",
  "scp", "rsync", "sftp",
  "tsc", "esbuild", "vite", "webpack", "rollup", "parcel",
  "jest", "vitest", "mocha", "pytest",
  "eslint", "prettier", "biome",
  "brew", "apt", "apt-get", "yum", "dnf", "pacman",
  "ssh-keygen",
  "openssl",
]);

const PROCESS_WRAPPERS = new Set([
  "timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin",
]);

// ------------------------------------------------------------------
// Git subcommand sets (only for commands NOT handled by classifyGitDetailed)
// ------------------------------------------------------------------

const GIT_SAFE_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show",
  "rev-parse",
  "ls-files", "ls-tree", "ls-remote",
  "describe", "shortlog", "blame", "annotate",
  "reflog",
  "name-rev", "rev-list",
  "cat-file", "hash-object",
  "count-objects", "fsck", "verify-pack",
  "for-each-ref",
]);

const GIT_REVERSIBLE_SUBCOMMANDS = new Set([
  "add", "commit", "fetch", "pull",
  "switch",
  "merge",
  "cherry-pick",
  "init",
]);

const GIT_DANGER_SUBCOMMANDS = new Set([
  "push", "rebase",
]);

const GIT_FORCE_FLAGS = new Set([
  "--force", "-f", "--force-with-lease", "--hard", "--no-preserve-root",
]);

const GIT_DELETE_FLAGS = new Set([
  "-D", "-d", "--delete",
]);

const CLASS_ORDER: Record<PermissionClass, number> = {
  read: 0,
  spawn: 1,
  write_reversible: 2,
  write_potent: 3,
  write_danger: 4,
  catastrophic: 5,
};

// ------------------------------------------------------------------
// classifyTool — sync entry point (non-bash only)
// ------------------------------------------------------------------

export function classifyTool(
  toolName: string,
  toolArgs: Record<string, unknown>,
): InvocationAssessment {
  if (toolName.startsWith("mcp__")) {
    return { permissionClass: "write_potent", toolName, canMemoize: true };
  }
  if (READ_TOOLS.has(toolName)) {
    return { permissionClass: "read", toolName };
  }
  if (WRITE_REVERSIBLE_TOOLS.has(toolName)) {
    return { permissionClass: "write_reversible", toolName, canMemoize: true };
  }
  if (SPAWN_TOOLS.has(toolName)) {
    return { permissionClass: "spawn", toolName };
  }
  if (WRITE_DANGER_TOOLS.has(toolName)) {
    return { permissionClass: "write_danger", toolName };
  }

  if (toolName === "bash" || toolName === "bash_background") {
    return { permissionClass: "write_potent", toolName, canMemoize: false };
  }

  return { permissionClass: "write_potent", toolName, canMemoize: true };
}

// ------------------------------------------------------------------
// classifyToolAsync — tree-sitter bash classification
// ------------------------------------------------------------------

export async function classifyToolAsync(
  toolName: string,
  toolArgs: Record<string, unknown>,
  projectRoot?: string,
): Promise<InvocationAssessment> {
  if (toolName !== "bash" && toolName !== "bash_background") {
    return classifyTool(toolName, toolArgs);
  }

  const command = typeof toolArgs["command"] === "string" ? toolArgs["command"] : "";
  if (!command.trim()) {
    return { permissionClass: "write_potent", toolName };
  }

  // Ensure parser is loaded (self-init on first use)
  if (!parserModule) {
    if (!parserReady) initBashParser();
    if (parserReady) await parserReady;
  }
  if (!parserModule) {
    return { permissionClass: "write_potent", toolName, canMemoize: false };
  }

  const result = await parserModule.parseBashCommand(command);
  if (result.kind === "unsupported") {
    return { permissionClass: "write_potent", toolName, canMemoize: false };
  }

  const bashCwd = typeof toolArgs["cwd"] === "string" ? toolArgs["cwd"] : undefined;
  const defaultCwd = projectRoot ? path.resolve(projectRoot) : process.cwd();
  const effectiveCwd = bashCwd
    ? path.resolve(defaultCwd, bashCwd)
    : defaultCwd;

  // Phase 1: cd context resolution on parsed AST
  let segments = result.segments as ParsedBashSegment[];
  let cdEffectiveCwd = effectiveCwd;
  let isExternal = false;

  if (projectRoot) {
    // Always check initial cwd externality (covers explicit cwd arg)
    const rel = path.relative(projectRoot, effectiveCwd);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      isExternal = true;
    }
    // cd context strips cd segments and tracks cwd changes
    if (segments.length > 1) {
      const cdCtx = resolveCdContextParsed(segments, projectRoot, effectiveCwd);
      segments = cdCtx.segments as ParsedBashSegment[];
      cdEffectiveCwd = cdCtx.effectiveCwd;
      if (cdCtx.isExternal) isExternal = true;
    }
  }

  // Phase 2: classify each segment, collect command names and max class
  let maxClass: PermissionClass = "read";
  const allCommandNames: string[] = [];
  const segmentClasses: PermissionClass[] = [];

  for (const segment of segments) {
    let segClass: PermissionClass = "read";
    for (const cmd of segment.commands) {
      const stripped = stripWrappersFromParsed(cmd);
      const cls = classifyParsedCommand(stripped);
      allCommandNames.push(stripped.name);
      if (CLASS_ORDER[cls] > CLASS_ORDER[segClass]) segClass = cls;
    }
    if (segment.hasFileWriteRedirect && CLASS_ORDER[segClass] < CLASS_ORDER["write_potent"]) {
      segClass = "write_potent";
    }
    segmentClasses.push(segClass);
    if (CLASS_ORDER[segClass] > CLASS_ORDER[maxClass]) maxClass = segClass;
  }

  // Phase 3: safe segment stripping — if only one non-read segment, keep it
  let effectiveSegments = segments;
  if (segments.length > 1) {
    const nonSafeIndices = segmentClasses
      .map((cls, i) => cls !== "read" ? i : -1)
      .filter(i => i >= 0);
    if (nonSafeIndices.length === 1) {
      effectiveSegments = [segments[nonSafeIndices[0]!]!];
    }
  }

  // Phase 4: memoize from effective segments
  const isSingleCommand = effectiveSegments.length === 1 &&
    effectiveSegments[0]!.commands.length === 1;
  let canMemoize = isSingleCommand && maxClass !== "catastrophic" && !isExternal;
  const canonicalPattern = canMemoize
    ? buildCanonicalPatternFromParsed(
        stripWrappersFromParsed(effectiveSegments[0]!.commands[0]!),
      )
    : undefined;

  const assessment: InvocationAssessment = {
    permissionClass: maxClass,
    toolName,
    commands: allCommandNames,
    canonicalPattern,
    canMemoize,
  };

  if (isExternal) {
    assessment.externalCwd = cdEffectiveCwd;
    assessment.canMemoize = false;
    assessment.canonicalPattern = undefined;
  }

  // Phase 5: dynamic cp/mv check (target is existing directory → write_potent)
  if (assessment.permissionClass === "write_reversible" &&
      allCommandNames.some(c => BASH_DYNAMIC_REVERSIBLE.has(c))) {
    for (const seg of effectiveSegments) {
      for (const cmd of seg.commands) {
        const stripped = stripWrappersFromParsed(cmd);
        if (!BASH_DYNAMIC_REVERSIBLE.has(stripped.name)) continue;
        const parsed = parseTrackableBashMutation(seg.text);
        if (!parsed) {
          assessment.permissionClass = "write_potent";
          break;
        }
        const rawTarget = parsed.args[parsed.args.length - 1];
        if (rawTarget) {
          const resolvedTarget = path.isAbsolute(rawTarget)
            ? path.resolve(rawTarget)
            : path.resolve(cdEffectiveCwd, rawTarget);
          try {
            if (statSync(resolvedTarget).isDirectory()) {
              assessment.permissionClass = "write_potent";
              break;
            }
          } catch { /* target doesn't exist — stays reversible */ }
        }
      }
      if (assessment.permissionClass === "write_potent") break;
    }
  }

  return assessment;
}

// ------------------------------------------------------------------
// Per-command classification (tree-sitter)
// ------------------------------------------------------------------

function classifyParsedCommand(cmd: ParsedBashCommand): PermissionClass {
  const name = cmd.name.split("/").pop() ?? cmd.name;

  // Catastrophic: disk tools
  if (["mkfs", "fdisk", "parted", "wipefs", "shred", "dd"].includes(name)) {
    if (name === "dd") {
      const hasDevTarget = cmd.argv.some(
        (t) => t.kind === "literal" && /^of=\/dev\//.test(t.value),
      );
      if (hasDevTarget) return "catastrophic";
    } else {
      return "catastrophic";
    }
  }

  // Catastrophic: rm -rf targeting root/home
  if (name === "rm") {
    const hasRecursiveForce = cmd.argv.some(
      (t) => t.kind === "literal" && /^-[a-zA-Z]*r[a-zA-Z]*f|^-[a-zA-Z]*f[a-zA-Z]*r|^--force$/.test(t.value),
    );
    if (hasRecursiveForce) {
      const targetsDangerousPath = cmd.argv.some((t) => {
        if (t.value.startsWith("-")) return false;
        return t.value === "/" || t.value === "~" || t.kind === "home_reference"
          || t.value === ".." || t.value === "$HOME";
      });
      if (targetsDangerousPath) return "catastrophic";
    }
  }

  if (cmd.argv.some((t) => t.value === "--no-preserve-root")) {
    return "catastrophic";
  }

  if (name === "git") return classifyGitDetailed(cmd);

  if (name === "find") {
    const hasDangerous = cmd.argv.some(
      (t) => t.kind === "literal" && /^-(exec|execdir|delete|ok)$/.test(t.value),
    );
    return hasDangerous ? "write_potent" : "read";
  }

  if (BASH_DANGER_COMMANDS.has(name)) return "write_danger";
  if (BASH_REVERSIBLE_COMMANDS.has(name)) return "write_reversible";
  if (BASH_DYNAMIC_REVERSIBLE.has(name)) return "write_reversible";
  if (BASH_SAFE_COMMANDS.has(name)) return "read";
  if (BASH_POTENT_COMMANDS.has(name)) return "write_potent";

  return "write_potent";
}

// ------------------------------------------------------------------
// Git detailed subcommand classification
// ------------------------------------------------------------------

function classifyGitDetailed(cmd: ParsedBashCommand): PermissionClass {
  const positionals: string[] = [];
  const flags = new Set<string>();

  for (const token of cmd.argv) {
    if (token.kind !== "literal") continue;
    if (token.value.startsWith("-")) {
      flags.add(token.value);
    } else {
      positionals.push(token.value);
    }
  }

  const sub = positionals[0] ?? "";
  const sub2 = positionals[1] ?? "";
  if (!sub) return "write_potent";

  // Global flag escalation
  if (flags.has("--force") || flags.has("-f") || flags.has("--force-with-lease")) return "write_danger";
  if (flags.has("--hard")) return "write_danger";

  switch (sub) {
    case "stash": {
      if (!sub2 || sub2 === "push" || sub2 === "save") return "write_reversible";
      if (sub2 === "list" || sub2 === "show") return "read";
      if (sub2 === "pop" || sub2 === "apply") return "write_reversible";
      if (sub2 === "drop" || sub2 === "clear") return "write_danger";
      return "write_reversible";
    }
    case "checkout": {
      if (flags.has("--")) return "write_danger";
      // `git checkout .` or `git checkout <file>` without -b → danger
      // Heuristic: if there's a positional that looks like a file path and no -b flag
      if (!flags.has("-b") && !flags.has("-B") && positionals.length >= 2) {
        const target = positionals[1]!;
        if (target === "." || target === "./" || target.includes("/") || target.includes(".")) {
          return "write_danger";
        }
      }
      return "write_reversible";
    }
    case "reset": {
      // --hard already caught by global flag check above
      return "write_reversible";
    }
    case "clean": {
      if (flags.has("-n") || flags.has("--dry-run")) return "read";
      return "write_danger";
    }
    case "branch": {
      if (flags.has("-D") || flags.has("-d") || flags.has("--delete")) return "write_danger";
      if (positionals.length <= 1) return "read";
      return "write_reversible";
    }
    case "tag": {
      if (flags.has("-d") || flags.has("--delete")) return "write_danger";
      if (positionals.length <= 1) return "read";
      return "write_reversible";
    }
    case "remote": {
      if (!sub2 || sub2 === "show" || sub2 === "get-url") return "read";
      if (sub2 === "add" || sub2 === "rename" || sub2 === "set-url") return "write_reversible";
      if (sub2 === "remove" || sub2 === "rm") return "write_danger";
      return "write_potent";
    }
    case "worktree": {
      if (!sub2 || sub2 === "list") return "read";
      if (sub2 === "add") return "write_reversible";
      if (sub2 === "remove" || sub2 === "prune") return "write_danger";
      return "write_potent";
    }
    case "config": {
      if (flags.has("--unset") || flags.has("--remove-section")) return "write_potent";
      // 1 positional (key) = read, 2+ (key value) = write
      if (positionals.length <= 2) return "read";
      return "write_potent";
    }
    default: break;
  }

  if (GIT_DANGER_SUBCOMMANDS.has(sub)) return "write_danger";
  if (GIT_REVERSIBLE_SUBCOMMANDS.has(sub)) return "write_reversible";
  if (GIT_SAFE_SUBCOMMANDS.has(sub)) return "read";

  return "write_potent";
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function stripWrappersFromParsed(cmd: ParsedBashCommand): ParsedBashCommand {
  const name = cmd.name.split("/").pop() ?? cmd.name;

  if (name === "env") {
    let idx = 0;
    while (idx < cmd.argv.length) {
      const token = cmd.argv[idx]!;
      if (token.kind === "literal" && token.value.includes("=")) { idx++; continue; }
      if (token.kind === "literal" && token.value.startsWith("-")) { idx++; continue; }
      break;
    }
    if (idx < cmd.argv.length) {
      const newName = cmd.argv[idx]!;
      return { text: cmd.text, name: newName.value, nameToken: newName, argv: cmd.argv.slice(idx + 1) };
    }
  }

  if (!PROCESS_WRAPPERS.has(name)) return cmd;

  let skip = 0;
  while (skip < cmd.argv.length && cmd.argv[skip]!.value.startsWith("-")) skip++;
  if ((name === "timeout" || name === "stdbuf") && skip < cmd.argv.length) {
    if (!cmd.argv[skip]!.value.startsWith("-")) skip++;
  }
  if (skip < cmd.argv.length) {
    const newName = cmd.argv[skip]!;
    return { text: cmd.text, name: newName.value, nameToken: newName, argv: cmd.argv.slice(skip + 1) };
  }

  return cmd;
}

function buildCanonicalPatternFromParsed(cmd: ParsedBashCommand): string {
  const name = cmd.name.split("/").pop() ?? cmd.name;

  const subcommandTools = new Set([
    "git", "npm", "npx", "pnpm", "yarn", "docker", "kubectl",
    "cargo", "go", "pip", "brew", "apt", "apt-get",
  ]);

  if (subcommandTools.has(name)) {
    for (const token of cmd.argv) {
      if (token.kind === "literal" && !token.value.startsWith("-")) {
        return `${name} ${token.value}`;
      }
    }
  }

  return name;
}
