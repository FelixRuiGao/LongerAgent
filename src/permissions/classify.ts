/**
 * Tool classification -- maps a tool call to a PermissionClass.
 *
 * Uses tree-sitter-bash for AST-accurate bash command parsing when available,
 * with a regex fallback for environments where tree-sitter is not loaded.
 *
 * Four bash risk tiers with git subcommand awareness:
 *   safe -> write_reversible -> write_potent -> write_danger -> catastrophic
 *
 * Safe command list synthesized from Claude Code, Codex CLI, and Fermi.
 */

import { statSync } from "node:fs";
import path from "node:path";
import type { InvocationAssessment, PermissionClass } from "./types.js";
import type { BashParseResult, ParsedBashCommand, ParsedBashSegment } from "./bash/types.js";
import { isTrackableBashMutation, parseTrackableBashMutation } from "../tools/basic.js";

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
    console.warn("tree-sitter bash parser unavailable, using regex fallback:", err);
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
]);

const WRITE_REVERSIBLE_TOOLS = new Set([
  "write_file", "edit_file",
]);

const SPAWN_TOOLS = new Set([
  "spawn",
]);

const WRITE_DANGER_TOOLS = new Set([
  "kill_shell", "kill_agent",
]);

// ------------------------------------------------------------------
// Bash safe-command whitelist (always auto-allowed)
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
]);

const BASH_REVERSIBLE_COMMANDS = new Set([
  "mkdir",
]);

// cp/mv are dynamically classified: write_reversible if target doesn't exist
// or is a file, write_potent if target is an existing directory.
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

// ------------------------------------------------------------------
// Process wrappers -- stripped before classification
// ------------------------------------------------------------------

const PROCESS_WRAPPERS = new Set([
  "timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin",
]);

// ------------------------------------------------------------------
// Git subcommand classification
// ------------------------------------------------------------------

const GIT_SAFE_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch",
  "rev-parse", "remote", "tag",
  "stash",
  "ls-files", "ls-tree", "ls-remote",
  "describe", "shortlog", "blame", "annotate",
  "config",
  "reflog",
  "name-rev", "rev-list",
  "cat-file", "hash-object",
  "count-objects", "fsck", "verify-pack",
  "for-each-ref",
  "worktree",
]);

const GIT_REVERSIBLE_SUBCOMMANDS = new Set([
  "add", "commit", "fetch", "pull",
  "stash",
  "switch",
  "checkout",
  "merge",
  "cherry-pick",
  "init",
]);

const GIT_DANGER_SUBCOMMANDS = new Set([
  "push", "reset", "clean", "rebase",
]);

const GIT_FORCE_FLAGS = new Set([
  "--force", "-f", "--force-with-lease", "--hard", "--no-preserve-root",
]);

const GIT_DELETE_FLAGS = new Set([
  "-D", "-d", "--delete",
]);

// ------------------------------------------------------------------
// Catastrophic patterns (regex -- checked before parsing)
// ------------------------------------------------------------------

const CATASTROPHIC_PATTERNS: Array<{ pattern: RegExp }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force\b|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/(\s|$)/ },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force\b|-[a-zA-Z]*f[a-zA-Z]*r)\s+"?\/"/ },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force\b|-[a-zA-Z]*f[a-zA-Z]*r)\s+~(\s|$)/ },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force\b|-[a-zA-Z]*f[a-zA-Z]*r)\s+\$HOME\b/ },
  { pattern: /\bdd\s+.*\bof\s*=\s*\/dev\// },
  { pattern: /\b(mkfs|fdisk|parted|wipefs|shred)\b/ },
  { pattern: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(000|777)\s+(\/\s*$|\/\s|~)/ },
  { pattern: /--no-preserve-root/ },
  { pattern: /\b(rm|del)\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--force\b)\s+\.\.\s*$/ },
];

// ------------------------------------------------------------------
// classifyTool -- main entry point
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
    const command = typeof toolArgs["command"] === "string" ? toolArgs["command"] : "";
    return classifyBashCommand(toolName, command);
  }

  return { permissionClass: "write_potent", toolName, canMemoize: true };
}

/**
 * Async classification that uses tree-sitter when available.
 * Falls back to sync regex classification.
 *
 * For cp/mv, performs a filesystem check on the target path:
 * if the target is an existing directory, upgrades to write_potent.
 */
export async function classifyToolAsync(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<InvocationAssessment> {
  if (toolName !== "bash" && toolName !== "bash_background") {
    return classifyTool(toolName, toolArgs);
  }

  const command = typeof toolArgs["command"] === "string" ? toolArgs["command"] : "";
  if (!command.trim()) {
    return { permissionClass: "write_potent", toolName };
  }

  let assessment: InvocationAssessment;

  // Try tree-sitter (skip regex catastrophic — tree-sitter handles quoting correctly)
  if (parserModule) {
    const result = await parserModule.parseBashCommand(command);
    assessment = classifyFromParseResult(toolName, command, result);
  } else {
    // Regex fallback (includes catastrophic check)
    assessment = classifyBashCommand(toolName, command);
  }

  // Dynamic check for cp/mv: enforce classifier/tracker contract.
  // If the shared parser can't track the syntax, upgrade to write_potent.
  // If trackable but target is an existing directory, also upgrade.
  if (assessment.permissionClass === "write_reversible" && assessment.commands?.some(c => BASH_DYNAMIC_REVERSIBLE.has(c))) {
    const bashCwd = typeof toolArgs["cwd"] === "string" ? toolArgs["cwd"] : undefined;
    const effectiveCwd = bashCwd ? path.resolve(bashCwd) : process.cwd();

    const segments = splitCompoundCommandRegex(command);
    for (const seg of segments) {
      const lead = extractLeadCommandRegex(stripProcessWrappersRegex(seg));
      if (!BASH_DYNAMIC_REVERSIBLE.has(lead)) continue;

      const parsed = parseTrackableBashMutation(seg);
      if (!parsed) {
        assessment.permissionClass = "write_potent";
        break;
      }

      const rawTarget = parsed.args[parsed.args.length - 1];
      if (rawTarget) {
        const resolvedTarget = path.isAbsolute(rawTarget)
          ? path.resolve(rawTarget)
          : path.resolve(effectiveCwd, rawTarget);
        try {
          if (statSync(resolvedTarget).isDirectory()) {
            assessment.permissionClass = "write_potent";
            break;
          }
        } catch {
          // Target doesn't exist — stays write_reversible
        }
      }
    }
  }

  return assessment;
}

// ------------------------------------------------------------------
// Tree-sitter-based classification
// ------------------------------------------------------------------

function classifyFromParseResult(
  toolName: string,
  rawCommand: string,
  result: BashParseResult,
): InvocationAssessment {
  if (result.kind === "unsupported") {
    // Unsupported constructs (subshell, heredoc, etc.) -> potent + ask
    return {
      permissionClass: "write_potent",
      toolName,
      commands: [extractLeadCommandRegex(rawCommand)],
      canMemoize: false,
    };
  }

  let maxClass: PermissionClass = "read";
  const allCommandNames: string[] = [];

  for (const segment of result.segments) {
    for (const cmd of segment.commands) {
      const stripped = stripWrappersFromParsed(cmd);
      const cls = classifyParsedCommand(stripped);
      allCommandNames.push(stripped.name);
      if (CLASS_ORDER[cls] > CLASS_ORDER[maxClass]) {
        maxClass = cls;
      }
    }
  }

  const isSingleCommand = result.segments.length === 1 &&
    result.segments[0]!.commands.length === 1;
  const canMemoize = isSingleCommand && maxClass !== "catastrophic";
  const canonicalPattern = canMemoize
    ? buildCanonicalPatternFromParsed(result.segments[0]!.commands[0]!)
    : undefined;

  return {
    permissionClass: maxClass,
    toolName,
    commands: allCommandNames,
    canonicalPattern,
    canMemoize,
  };
}

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

  // --no-preserve-root anywhere
  if (cmd.argv.some((t) => t.value === "--no-preserve-root")) {
    return "catastrophic";
  }

  if (name === "git") {
    return classifyGitParsed(cmd);
  }

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

function classifyGitParsed(cmd: ParsedBashCommand): PermissionClass {
  // Find the subcommand (skip flags)
  let subcommand = "";
  for (const token of cmd.argv) {
    if (token.kind === "literal" && !token.value.startsWith("-")) {
      subcommand = token.value;
      break;
    }
  }

  if (!subcommand) return "write_potent";

  const hasForceFlag = cmd.argv.some(
    (t) => t.kind === "literal" && GIT_FORCE_FLAGS.has(t.value),
  );
  const hasDeleteFlag = cmd.argv.some(
    (t) => t.kind === "literal" && GIT_DELETE_FLAGS.has(t.value),
  );

  if (GIT_DANGER_SUBCOMMANDS.has(subcommand)) return "write_danger";
  if (subcommand === "branch" && hasDeleteFlag) return "write_danger";
  if (hasForceFlag) return "write_danger";
  if (GIT_REVERSIBLE_SUBCOMMANDS.has(subcommand)) return "write_reversible";
  if (GIT_SAFE_SUBCOMMANDS.has(subcommand)) return "read";

  return "write_potent";
}

/**
 * Strip process wrappers from a parsed command.
 * Returns a new ParsedBashCommand with the wrapper removed.
 */
function stripWrappersFromParsed(cmd: ParsedBashCommand): ParsedBashCommand {
  const name = cmd.name.split("/").pop() ?? cmd.name;

  // "env" prefix: skip env and any VAR=val args, take next literal as command
  if (name === "env") {
    let idx = 0;
    while (idx < cmd.argv.length) {
      const token = cmd.argv[idx]!;
      if (token.kind === "literal" && token.value.includes("=")) {
        idx++;
        continue;
      }
      if (token.kind === "literal" && token.value.startsWith("-")) {
        idx++;
        continue;
      }
      break;
    }
    if (idx < cmd.argv.length) {
      const newName = cmd.argv[idx]!;
      return {
        text: cmd.text,
        name: newName.value,
        nameToken: newName,
        argv: cmd.argv.slice(idx + 1),
      };
    }
  }

  if (!PROCESS_WRAPPERS.has(name)) return cmd;

  // Skip wrapper + its flags + one value arg for timeout/stdbuf
  let skip = 0;
  while (skip < cmd.argv.length && cmd.argv[skip]!.value.startsWith("-")) {
    skip++;
  }
  if ((name === "timeout" || name === "stdbuf") && skip < cmd.argv.length) {
    const next = cmd.argv[skip]!;
    if (!next.value.startsWith("-")) {
      skip++;
    }
  }
  if (skip < cmd.argv.length) {
    const newName = cmd.argv[skip]!;
    return {
      text: cmd.text,
      name: newName.value,
      nameToken: newName,
      argv: cmd.argv.slice(skip + 1),
    };
  }

  return cmd;
}

function buildCanonicalPatternFromParsed(cmd: ParsedBashCommand): string {
  const stripped = stripWrappersFromParsed(cmd);
  const name = stripped.name.split("/").pop() ?? stripped.name;

  const subcommandTools = new Set([
    "git", "npm", "npx", "pnpm", "yarn", "docker", "kubectl",
    "cargo", "go", "pip", "brew", "apt", "apt-get",
  ]);

  if (subcommandTools.has(name)) {
    for (const token of stripped.argv) {
      if (token.kind === "literal" && !token.value.startsWith("-")) {
        return `${name} ${token.value}`;
      }
    }
  }

  return name;
}

// ------------------------------------------------------------------
// Regex fallback (sync)
// ------------------------------------------------------------------

const CLASS_ORDER: Record<PermissionClass, number> = {
  read: 0,
  spawn: 1,
  write_reversible: 2,
  write_potent: 3,
  write_danger: 4,
  catastrophic: 5,
};

function classifyBashCommand(toolName: string, command: string): InvocationAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return { permissionClass: "write_potent", toolName };
  }

  for (const { pattern } of CATASTROPHIC_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        permissionClass: "catastrophic",
        toolName,
        commands: [extractLeadCommandRegex(trimmed)],
        canonicalPattern: trimmed,
        canMemoize: false,
      };
    }
  }

  const segments = splitCompoundCommandRegex(trimmed);
  let maxClass: PermissionClass = "read";

  for (const segment of segments) {
    const stripped = stripProcessWrappersRegex(segment);
    const cmd = extractLeadCommandRegex(stripped);
    const cls = classifySingleCommandRegex(cmd, stripped);
    if (CLASS_ORDER[cls] > CLASS_ORDER[maxClass]) {
      maxClass = cls;
    }
  }

  const leadCommand = extractLeadCommandRegex(stripProcessWrappersRegex(segments[0] ?? trimmed));
  const commands = segments.map((s) => extractLeadCommandRegex(stripProcessWrappersRegex(s)));
  const canMemoize = segments.length === 1 && maxClass !== "catastrophic";
  const canonicalPattern = canMemoize
    ? buildCanonicalPatternRegex(leadCommand, stripProcessWrappersRegex(segments[0] ?? trimmed))
    : undefined;

  return { permissionClass: maxClass, toolName, commands, canonicalPattern, canMemoize };
}

function classifySingleCommandRegex(cmd: string, fullSegment: string): PermissionClass {
  if (!cmd) return "write_potent";

  if (cmd === "git") return classifyGitCommandRegex(fullSegment);

  if (cmd === "find") {
    if (/-(exec|execdir|delete|ok)\b/.test(fullSegment)) return "write_potent";
    return "read";
  }

  if (BASH_DANGER_COMMANDS.has(cmd)) return "write_danger";
  if (BASH_REVERSIBLE_COMMANDS.has(cmd)) return "write_reversible";
  if (BASH_DYNAMIC_REVERSIBLE.has(cmd)) return "write_reversible";
  if (BASH_SAFE_COMMANDS.has(cmd)) return "read";
  if (BASH_POTENT_COMMANDS.has(cmd)) return "write_potent";

  return "write_potent";
}

function classifyGitCommandRegex(segment: string): PermissionClass {
  const parts = segment.trim().split(/\s+/);
  let subIdx = 1;
  while (subIdx < parts.length && parts[subIdx]!.startsWith("-")) subIdx++;
  const subcommand = parts[subIdx] ?? "";
  if (!subcommand) return "write_potent";

  const hasForceFlag = parts.some((p) => GIT_FORCE_FLAGS.has(p));
  const hasDeleteFlag = parts.some((p) => GIT_DELETE_FLAGS.has(p));

  if (GIT_DANGER_SUBCOMMANDS.has(subcommand)) return "write_danger";
  if (subcommand === "branch" && hasDeleteFlag) return "write_danger";
  if (hasForceFlag) return "write_danger";
  if (GIT_REVERSIBLE_SUBCOMMANDS.has(subcommand)) return "write_reversible";
  if (GIT_SAFE_SUBCOMMANDS.has(subcommand)) return "read";

  return "write_potent";
}

function splitCompoundCommandRegex(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (ch === "\\" && !inSingle && i + 1 < command.length) { current += ch + command[i + 1]; i++; continue; }

    if (!inSingle && !inDouble) {
      if (ch === "&" && command[i + 1] === "&") { if (current.trim()) segments.push(current.trim()); current = ""; i++; continue; }
      if (ch === "|" && command[i + 1] === "|") { if (current.trim()) segments.push(current.trim()); current = ""; i++; continue; }
      if (ch === ";" || ch === "|" || (ch === "&" && command[i + 1] !== "&")) { if (current.trim()) segments.push(current.trim()); current = ""; continue; }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.length > 0 ? segments : [command.trim()];
}

function stripProcessWrappersRegex(command: string): string {
  let result = command.trim();
  result = result.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");

  if (/^env\s/.test(result)) {
    result = result.replace(/^env\s+/, "");
    result = result.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
  }

  let changed = true;
  while (changed) {
    changed = false;
    const parts = result.split(/\s+/);
    if (parts.length >= 2 && PROCESS_WRAPPERS.has(parts[0]!)) {
      let skip = 1;
      while (skip < parts.length && parts[skip]!.startsWith("-")) skip++;
      if ((parts[0] === "timeout" || parts[0] === "stdbuf") && skip < parts.length && !parts[skip]!.startsWith("-")) skip++;
      if (skip < parts.length) { result = parts.slice(skip).join(" "); changed = true; }
    }
  }
  return result.trim();
}

function extractLeadCommandRegex(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const first = trimmed.split(/\s+/)[0] ?? "";
  return first.split("/").pop() ?? first;
}

function buildCanonicalPatternRegex(leadCommand: string, fullCommand: string): string {
  const parts = fullCommand.trim().split(/\s+/);
  if (parts.length <= 1) return leadCommand;

  const subcommandTools = new Set([
    "git", "npm", "npx", "pnpm", "yarn", "docker", "kubectl",
    "cargo", "go", "pip", "brew", "apt", "apt-get",
  ]);
  if (subcommandTools.has(leadCommand) && parts.length >= 2) {
    return `${leadCommand} ${parts[1]}`;
  }

  return leadCommand;
}
