/**
 * Tool classification — maps a tool call to a PermissionClass.
 *
 * Static classification for built-in tools, plus bash command analysis
 * with catastrophic pattern detection and safe-command whitelist.
 *
 * The bash analysis is intentionally simple (regex-based). The interface
 * (InvocationAssessment) supports upgrading to a full parser later —
 * only the internals of classifyBashCommand() need to change.
 */

import type { InvocationAssessment, PermissionClass } from "./types.js";

// ------------------------------------------------------------------
// Static tool classification
// ------------------------------------------------------------------

const READ_TOOLS = new Set([
  "read_file", "list_dir", "glob", "grep",
  "web_fetch", "web_search", "$web_search",
  "show_context", "distill_context",
  "ask", "check_status", "wait", "send",
  "bash_output", "skill", "time",
]);

const WRITE_REVERSIBLE_TOOLS = new Set([
  "write_file", "edit_file",
]);

const SPAWN_TOOLS = new Set([
  "spawn", "spawn_file",
]);

const WRITE_DANGER_TOOLS = new Set([
  "kill_shell", "kill_agent",
]);

// ------------------------------------------------------------------
// Bash safe-command whitelist
// ------------------------------------------------------------------

const BASH_SAFE_COMMANDS = new Set([
  // Read-only inspection
  "ls", "ll", "la", "dir", "tree", "find", "locate",
  "cat", "head", "tail", "less", "more", "wc", "file",
  "stat", "readlink", "realpath", "basename", "dirname",
  "pwd", "whoami", "hostname", "uname", "arch", "date",
  "which", "where", "whence", "type", "command",
  "echo", "printf",
  "env", "printenv", "set",
  "id", "groups",
  "df", "du", "free", "uptime", "ps", "top",
  // Version/help
  "node", "deno", "bun", "python", "python3", "ruby", "go", "java", "javac",
  "rustc", "cargo", "gcc", "g++", "clang", "clang++", "make", "cmake",
  // Package managers (read/install — not global)
  "npm", "npx", "pnpm", "yarn", "pip", "pip3", "uv",
  "gem", "bundle", "composer", "brew",
  "cargo", "go",
  // VCS
  "git", "hg", "svn",
  // Build/test runners
  "tsc", "esbuild", "vite", "webpack", "rollup", "parcel",
  "jest", "vitest", "mocha", "pytest", "unittest",
  "eslint", "prettier", "biome", "oxlint",
  // Containers (inspect)
  "docker", "podman", "kubectl",
  // Text processing
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "sed", "awk", "cut", "sort", "uniq", "tr", "diff", "patch",
  "jq", "yq", "xmllint", "xsltproc",
  // Network (read)
  "curl", "wget", "ping", "dig", "nslookup", "host",
  // Misc safe
  "true", "false", "test", "[", "[[",
  "sleep", "seq", "yes", "tee", "xargs",
  "tar", "gzip", "gunzip", "bzip2", "xz", "unzip", "zip",
  "md5sum", "sha256sum", "shasum", "openssl",
  "ssh-keygen",
]);

// ------------------------------------------------------------------
// Bash danger-command list (not catastrophic, but risky)
// ------------------------------------------------------------------

const BASH_DANGER_COMMANDS = new Set([
  "kill", "killall", "pkill",
  "reboot", "shutdown", "halt", "poweroff", "init",
  "mount", "umount",
  "iptables", "ip6tables", "nft",
  "systemctl", "service", "launchctl",
  "useradd", "userdel", "usermod", "groupadd", "groupdel",
  "passwd", "chown", "chgrp",
  "crontab",
  "scp", "rsync", "sftp",
  "sudo", "su", "doas",
]);

// ------------------------------------------------------------------
// Bash catastrophic patterns
// ------------------------------------------------------------------

const CATASTROPHIC_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force\b|-[a-zA-Z]*f[a-zA-Z]*r)\s+.*(\s+\/\s*$|\s+\/\s|\s+"\/")/, reason: "rm -rf targeting root" },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force\b|-[a-zA-Z]*f[a-zA-Z]*r)\s+~\s*$/, reason: "rm -rf targeting home" },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force\b|-[a-zA-Z]*f[a-zA-Z]*r)\s+\$HOME\b/, reason: "rm -rf targeting $HOME" },
  { pattern: /\bdd\s+.*\bof\s*=\s*\/dev\//, reason: "dd writing to device" },
  { pattern: /\b(mkfs|fdisk|parted|wipefs|shred)\b/, reason: "disk formatting/destruction tool" },
  { pattern: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(000|777)\s+(\/\s*$|\/\s|~)/, reason: "recursive chmod on root/home" },
  { pattern: /--no-preserve-root/, reason: "--no-preserve-root flag" },
  { pattern: /\b(rm|del)\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--force\b)\s+\.\.\s*$/, reason: "rm -rf targeting parent directory" },
];

// ------------------------------------------------------------------
// classifyTool — main entry point
// ------------------------------------------------------------------

export function classifyTool(
  toolName: string,
  toolArgs: Record<string, unknown>,
): InvocationAssessment {
  // MCP tools — default to potent
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

  // Unknown tool — default to potent
  return { permissionClass: "write_potent", toolName, canMemoize: true };
}

// ------------------------------------------------------------------
// Bash command classification
// ------------------------------------------------------------------

function classifyBashCommand(toolName: string, command: string): InvocationAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return { permissionClass: "write_potent", toolName };
  }

  // Check catastrophic patterns first
  for (const { pattern, reason } of CATASTROPHIC_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        permissionClass: "catastrophic",
        toolName,
        commands: [extractLeadCommand(trimmed)],
        canonicalPattern: trimmed,
        canMemoize: false,
      };
    }
  }

  // Extract the lead command for classification
  const leadCommand = extractLeadCommand(trimmed);
  const commands = extractAllCommands(trimmed);

  // If ANY command in a pipeline/chain is danger, escalate
  let maxClass: PermissionClass = "read";
  for (const cmd of commands) {
    const cls = classifySingleCommand(cmd);
    if (CLASS_ORDER[cls] > CLASS_ORDER[maxClass]) {
      maxClass = cls;
    }
  }

  // Build canonical pattern for memoization
  const canMemoize = commands.length === 1 && maxClass !== "catastrophic";
  const canonicalPattern = canMemoize ? buildCanonicalPattern(leadCommand, trimmed) : undefined;

  return {
    permissionClass: maxClass,
    toolName,
    commands,
    canonicalPattern,
    canMemoize,
  };
}

const CLASS_ORDER: Record<PermissionClass, number> = {
  read: 0,
  spawn: 1,
  write_reversible: 2,
  write_potent: 3,
  write_danger: 4,
  catastrophic: 5,
};

function classifySingleCommand(cmd: string): PermissionClass {
  if (BASH_SAFE_COMMANDS.has(cmd)) return "read";
  if (BASH_DANGER_COMMANDS.has(cmd)) return "write_danger";
  // rm without -rf is danger (not catastrophic — catastrophic caught above)
  if (cmd === "rm" || cmd === "rmdir") return "write_danger";
  if (cmd === "mv" || cmd === "cp") return "write_potent";
  if (cmd === "chmod" || cmd === "chown") return "write_potent";
  if (cmd === "ln") return "write_potent";
  if (cmd === "mkdir") return "read"; // creating dirs is generally safe
  if (cmd === "touch") return "read";
  return "write_potent";
}

// ------------------------------------------------------------------
// Command extraction helpers
// ------------------------------------------------------------------

function extractLeadCommand(command: string): string {
  // Skip env var assignments at the start (VAR=value cmd ...)
  const withoutEnv = command.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
  const first = withoutEnv.trim().split(/\s+/)[0] ?? "";
  // Strip path prefix (e.g. /usr/bin/git → git)
  const base = first.split("/").pop() ?? first;
  return base;
}

function extractAllCommands(command: string): string[] {
  // Split on pipes, &&, ||, ; to get individual commands
  const parts = command.split(/\s*(?:\|{1,2}|&&|;)\s*/);
  const cmds: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const cmd = extractLeadCommand(trimmed);
    if (cmd) cmds.push(cmd);
  }
  return cmds.length > 0 ? cmds : [extractLeadCommand(command)];
}

function buildCanonicalPattern(leadCommand: string, fullCommand: string): string {
  // For simple single-word commands, use the command name
  // For commands with meaningful first argument, include it
  const parts = fullCommand.trim().split(/\s+/);
  if (parts.length <= 1) return leadCommand;

  // git <subcommand>, npm <subcommand>, docker <subcommand>
  const subcommandTools = new Set(["git", "npm", "npx", "pnpm", "yarn", "docker", "kubectl", "cargo", "go", "pip", "brew"]);
  if (subcommandTools.has(leadCommand) && parts.length >= 2) {
    return `${leadCommand} ${parts[1]}`;
  }

  return leadCommand;
}
