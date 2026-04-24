/**
 * ToolRuntime — the three-layer tool execution pipeline.
 *
 * Separates three concerns that were previously interleaved in Session:
 *
 *   Catalog  — what tools does the model see?
 *   Gate     — can this specific call execute? (permissions hook)
 *   Executor — the actual tool implementations
 *
 * Session creates a ToolRuntime and delegates tool management to it.
 * The Gate layer is the insertion point for the future permissions system.
 */

import type { ToolDef } from "./providers/base.js";
import { ToolResult } from "./providers/base.js";
import type { ToolExecutor, ToolExecutorContext } from "./tools/executor-types.js";
import type { ToolPreflightContext, ToolPreflightDecision } from "./agents/tool-loop.js";
import {
  SPAWN_TOOL,
  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  WAIT_TOOL,
  SHOW_CONTEXT_TOOL,
  DISTILL_CONTEXT_TOOL,
  ASK_TOOL,
  SEND_TOOL,
} from "./tools/comm.js";
import {
  executeTool,
} from "./tools/basic.js";
import type { SessionCapabilities } from "./session-capabilities.js";
import type { SkillMeta } from "./skills/loader.js";
import type { MCPClientManager } from "./mcp-client.js";
import type { Agent } from "./agents/agent.js";

// ------------------------------------------------------------------
// Gate types
// ------------------------------------------------------------------

export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; question: string; toolCallId: string };

export interface GateAdvisor {
  evaluate(ctx: ToolPreflightContext): GateDecision | Promise<GateDecision>;
}

// ------------------------------------------------------------------
// Catalog — what tools the model sees
// ------------------------------------------------------------------

export interface CatalogDeps {
  capabilities: SessionCapabilities;
  skills: ReadonlyMap<string, SkillMeta>;
  disabledSkills: ReadonlySet<string>;
}

/**
 * Build the skill meta-tool definition from available skills.
 * Returns null if no skills are available for model invocation.
 */
export function buildSkillToolDef(
  skills: ReadonlyMap<string, SkillMeta>,
): ToolDef | null {
  const available = [...skills.values()].filter(
    (s) => !s.disableModelInvocation,
  );
  if (available.length === 0) return null;

  const listing = available
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");

  return {
    name: "skill",
    description:
      "Invoke a skill by name. The skill's full instructions are returned for you to follow.\n\n" +
      "Available skills:\n" +
      listing,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The skill name to invoke.",
        },
        arguments: {
          type: "string",
          description:
            "Arguments to pass to the skill (e.g. file path, module name). " +
            "Referenced via $ARGUMENTS in the skill instructions.",
        },
      },
      required: ["name"],
    },
    summaryTemplate: "{agent} is invoking skill {name}",
    tuiPolicy: { partialReveal: { completeArgs: ["name"] } },
  };
}

/**
 * Ensure comm tools are present in the tools array based on capabilities.
 * Mutates the provided array in place.
 */
export function ensureCommTools(
  tools: ToolDef[],
  capabilities: SessionCapabilities,
): void {
  const existing = new Set(tools.map((t) => t.name));
  const wanted: ToolDef[] = [];
  if (capabilities.includeSpawnTool) wanted.push(SPAWN_TOOL);
  if (capabilities.includeKillTool) wanted.push(KILL_AGENT_TOOL);
  if (capabilities.includeCheckStatusTool) wanted.push(CHECK_STATUS_TOOL);
  if (capabilities.includeWaitTool) wanted.push(WAIT_TOOL);
  if (capabilities.includeShowContextTool) wanted.push(SHOW_CONTEXT_TOOL);
  if (capabilities.includeDistillContextTool) wanted.push(DISTILL_CONTEXT_TOOL);
  if (capabilities.includeAskTool) wanted.push(ASK_TOOL);
  for (const toolDef of wanted) {
    if (!existing.has(toolDef.name)) {
      tools.push(toolDef);
    }
  }
}

/**
 * Ensure the skill tool is present/absent based on capabilities and available skills.
 * Mutates the provided array in place by reference (filter+push pattern requires reassignment).
 * Returns the new tools array.
 */
export function ensureSkillTool(
  tools: ToolDef[],
  capabilities: SessionCapabilities,
  skills: ReadonlyMap<string, SkillMeta>,
): ToolDef[] {
  if (!capabilities.includeSkillTools) {
    return tools.filter((t) => t.name !== "skill");
  }
  const filtered = tools.filter((t) => t.name !== "skill");
  const skillDef = buildSkillToolDef(skills);
  if (skillDef) {
    filtered.push(skillDef);
  }
  return filtered;
}

// ------------------------------------------------------------------
// Executor builder — constructs the name→executor dict
// ------------------------------------------------------------------

export interface ExecutorDeps {
  projectRoot: string;
  getSessionArtifactsDir: () => string;
  supportsMultimodal: boolean;
  /** Session-owned executors for comm tools (execAsk, execSpawn, etc.) */
  commExecutors: Record<string, ToolExecutor>;
  /** Additional overrides (e.g. from constructor opts) */
  overrides?: Record<string, ToolExecutor>;
  /** Called after a file write to check if AGENTS.md was modified */
  onFileWrite?: (filePath: string) => void;
  /** Called after a file write to check if plan.md was modified */
  isPlanFile?: (filePath: string) => boolean;
  onPlanFileWrite?: () => void;
}

export function buildToolExecutors(deps: ExecutorDeps): Record<string, ToolExecutor> {
  const {
    projectRoot,
    getSessionArtifactsDir,
    supportsMultimodal,
    commExecutors,
    overrides = {},
    onFileWrite,
    isPlanFile,
    onPlanFileWrite,
  } = deps;

  const scopedBuiltin = (toolName: string): ToolExecutor =>
    (args, rtCtx) => executeTool(toolName, args, {
      projectRoot,
      externalPathAllowlist: [getSessionArtifactsDir()],
      sessionArtifactsDir: getSessionArtifactsDir(),
      supportsMultimodal,
      signal: rtCtx?.signal,
    });

  const writeFileWithReload: ToolExecutor = (args, rtCtx) => {
    const result = scopedBuiltin("write_file")(args, rtCtx);
    const filePath = String((args as Record<string, unknown>)["path"] ?? "");
    if (filePath && onFileWrite) {
      onFileWrite(filePath);
    }
    return result;
  };

  const withPlanHook = (inner: ToolExecutor): ToolExecutor => {
    return (args, rtCtx) => {
      const filePath = String((args as Record<string, unknown>)["path"] ?? "");
      const isPlan = filePath && isPlanFile?.(filePath);
      const result = inner(args, rtCtx);
      if (!isPlan) return result;

      const finalize = (r: ToolResult | string): ToolResult => {
        onPlanFileWrite?.();
        if (r instanceof ToolResult) {
          r.metadata.planFileOperation = true;
          return r;
        }
        return new ToolResult({ content: String(r), metadata: { planFileOperation: true } });
      };

      if (result instanceof Promise) {
        return result.then(finalize);
      }
      return finalize(result as ToolResult | string);
    };
  };

  return {
    read_file: scopedBuiltin("read_file"),
    list_dir: scopedBuiltin("list_dir"),
    glob: scopedBuiltin("glob"),
    grep: scopedBuiltin("grep"),
    edit_file: withPlanHook(scopedBuiltin("edit_file")),
    write_file: withPlanHook(writeFileWithReload),
    web_fetch: (args, rtCtx) => executeTool("web_fetch", args, { signal: rtCtx?.signal }),
    bash: (args, rtCtx) => executeTool("bash", args, {
      projectRoot,
      externalPathAllowlist: [getSessionArtifactsDir()],
      signal: rtCtx?.signal,
    }),
    ...commExecutors,
    ...overrides,
  };
}

// ------------------------------------------------------------------
// MCP tool registration
// ------------------------------------------------------------------

export async function registerMcpTools(
  mcpManager: MCPClientManager,
  executors: Record<string, ToolExecutor>,
  agents: Agent[],
): Promise<boolean> {
  try {
    await mcpManager.connectAll();
    const mcpTools = mcpManager.getAllTools();

    for (const tool of mcpTools) {
      if (tool.name in executors) continue;
      const capturedName = tool.name;
      executors[capturedName] = async (args: Record<string, unknown>) => {
        return mcpManager.callTool(capturedName, args);
      };
    }

    const seenAgents = new Set<Agent>();
    for (const agent of agents) {
      if (seenAgents.has(agent)) continue;
      seenAgents.add(agent);

      const spec = (agent as any)._mcpToolsSpec;
      if (!spec || spec === "none") continue;

      let selectedTools: ToolDef[];
      if (spec === "all") {
        selectedTools = mcpTools;
      } else if (Array.isArray(spec)) {
        const prefixes = (spec as string[]).map((s) => `mcp__${s}__`);
        selectedTools = mcpTools.filter((t) =>
          prefixes.some((p) => t.name.startsWith(p)),
        );
      } else {
        selectedTools = [];
      }

      if (!selectedTools.length) continue;

      const existingToolNames = new Set(agent.tools.map((t) => t.name));
      for (const tool of selectedTools) {
        if (existingToolNames.has(tool.name)) continue;
        agent.tools.push(tool);
        existingToolNames.add(tool.name);
      }
    }

    return mcpTools.length > 0;
  } catch (e) {
    console.error("Failed to connect MCP servers:", e);
    return false;
  }
}

// ------------------------------------------------------------------
// Gate — permission checking pipeline
// ------------------------------------------------------------------

export class ToolGate {
  private _advisors: GateAdvisor[] = [];

  addAdvisor(advisor: GateAdvisor): void {
    this._advisors.push(advisor);
  }

  removeAdvisor(advisor: GateAdvisor): void {
    const idx = this._advisors.indexOf(advisor);
    if (idx >= 0) this._advisors.splice(idx, 1);
  }

  /**
   * Evaluate a tool call against all advisors.
   * First deny or ask wins. If all allow (or no advisors), allow.
   */
  async evaluate(ctx: ToolPreflightContext): Promise<GateDecision> {
    for (const advisor of this._advisors) {
      const decision = await advisor.evaluate(ctx);
      if (decision.kind !== "allow") return decision;
    }
    return { kind: "allow" };
  }

  /**
   * Create a BeforeToolExecuteCallback compatible with tool-loop.ts.
   * This is the bridge between the new Gate system and the existing
   * tool loop's preflight mechanism.
   */
  asBeforeToolExecute(): (ctx: ToolPreflightContext) => Promise<ToolPreflightDecision | void> {
    return async (ctx: ToolPreflightContext): Promise<ToolPreflightDecision | void> => {
      const decision = await this.evaluate(ctx);
      switch (decision.kind) {
        case "allow":
          return undefined;
        case "deny":
          return { kind: "deny", message: decision.message };
        case "ask":
          // Future: hook into ask system for approval
          // For now, treat as allow (no permissions configured = allow all)
          return undefined;
      }
    };
  }
}
