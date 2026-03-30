import type { ToolCategory } from "./types.js";

export interface ToolDisplayProfile {
  category: ToolCategory;
  displayName: string;
  text(args: Record<string, unknown>): string;
  suffix?(resultMeta?: Record<string, unknown>): string;
  inlineResult: { maxLines: number } | false;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function truncateCmd(cmd: unknown, max = 60): string {
  const s = str(cmd);
  return s.length > max ? s.slice(0, max) + "..." : s;
}

export const TOOL_PROFILES: Record<string, ToolDisplayProfile> = {
  read_file: {
    category: "file-read",
    displayName: "Read",
    text: (args) => str(args.path),
    inlineResult: false,
  },
  list_dir: {
    category: "file-read",
    displayName: "List",
    text: (args) => str(args.path, "."),
    inlineResult: { maxLines: 8 },
  },
  glob: {
    category: "file-read",
    displayName: "Glob",
    text: (args) => str(args.pattern),
    inlineResult: { maxLines: 8 },
  },
  grep: {
    category: "file-read",
    displayName: "Search",
    text: (args) => {
      const pattern = str(args.pattern);
      const p = str(args.path);
      return p ? `"${pattern}" in ${p}` : `"${pattern}"`;
    },
    inlineResult: { maxLines: 8 },
  },
  edit_file: {
    category: "file-modify",
    displayName: "Edit",
    text: (args) => str(args.path),
    suffix: (meta) => {
      const added = meta?.linesAdded;
      const removed = meta?.linesRemoved;
      if (typeof added === "number" || typeof removed === "number") {
        return `(+${added ?? 0} -${removed ?? 0})`;
      }
      return "";
    },
    inlineResult: { maxLines: 20 },
  },
  write_file: {
    category: "file-modify",
    displayName: "Write",
    text: (args) => str(args.path),
    suffix: (meta) => {
      const lines = meta?.lineCount;
      return typeof lines === "number" ? `(${lines} lines)` : "";
    },
    inlineResult: { maxLines: 20 },
  },
  bash: {
    category: "execute",
    displayName: "Run",
    text: (args) => truncateCmd(args.command),
    suffix: (meta) => {
      const code = meta?.exitCode;
      return typeof code === "number" ? `(exit ${code})` : "";
    },
    inlineResult: { maxLines: 12 },
  },
  bash_background: {
    category: "execute",
    displayName: "Run",
    text: (args) => truncateCmd(args.command),
    inlineResult: false,
  },
  bash_output: {
    category: "execute",
    displayName: "Output",
    text: (args) => str(args.id),
    inlineResult: { maxLines: 12 },
  },
  kill_shell: {
    category: "execute",
    displayName: "Kill",
    text: (args) => {
      const ids = args.ids;
      if (Array.isArray(ids)) return `[${ids.length} shells]`;
      return str(args.id);
    },
    inlineResult: false,
  },
  web_search: {
    category: "web",
    displayName: "WebSearch",
    text: (args) => `"${str(args.query)}"`,
    inlineResult: { maxLines: 6 },
  },
  web_fetch: {
    category: "web",
    displayName: "Fetch",
    text: (args) => str(args.url),
    inlineResult: { maxLines: 8 },
  },
  spawn: {
    category: "orchestration",
    displayName: "Spawn",
    text: (args) => str(args.id),
    inlineResult: false,
  },
  spawn_file: {
    category: "orchestration",
    displayName: "Spawn",
    text: (args) => str(args.file),
    inlineResult: false,
  },
  kill_agent: {
    category: "orchestration",
    displayName: "Kill",
    text: (args) => {
      const ids = args.ids;
      if (Array.isArray(ids)) return `[${ids.length} agents]`;
      return str(args.id);
    },
    inlineResult: false,
  },
  send: {
    category: "orchestration",
    displayName: "Send",
    text: (args) => str(args.to),
    inlineResult: false,
  },
  ask: {
    category: "orchestration",
    displayName: "Ask",
    text: () => "",
    inlineResult: false,
  },
  show_context: {
    category: "internal",
    displayName: "Context",
    text: () => "",
    inlineResult: false,
  },
  distill_context: {
    category: "internal",
    displayName: "Distill",
    text: (args) => {
      const ops = args.operations;
      if (Array.isArray(ops)) return `[${ops.length} contexts]`;
      return "";
    },
    inlineResult: false,
  },
  check_status: {
    category: "internal",
    displayName: "Status",
    text: () => "",
    inlineResult: false,
  },
  time: {
    category: "internal",
    displayName: "Time",
    text: () => "",
    inlineResult: false,
  },
};

export const HIDDEN_TOOLS = new Set(["wait"]);

export function getToolProfile(toolName: string): ToolDisplayProfile {
  return TOOL_PROFILES[toolName] ?? {
    category: "internal" as const,
    displayName: `Using ${toolName}`,
    text: () => "",
    inlineResult: false,
  };
}
