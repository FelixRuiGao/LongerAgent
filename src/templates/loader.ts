/**
 * Agent template loader with multi-file prompt assembly.
 *
 * Provides `loadTemplate` / `loadTemplates` for agent templates.
 *
 * Template folder layout:
 *
 *   agent_templates/
 *   +-- main/
 *   |   +-- agent.yaml          # required
 *   |   +-- system_prompt.md    # referenced by system_prompt_file
 *   |   +-- knowledge/          # optional -- files appended to system prompt
 *   |       +-- style_guide.md
 *   +-- executor/
 *       +-- agent.yaml
 *       +-- system_prompt.md
 *
 * Prompt assembly pipeline (per template):
 *
 *   1. Read core system prompt from system_prompt.md
 *   2. Assemble tool prompts from prompts/tools/{name}.md
 *      (ordered by TOOL_PROMPT_ORDER, filtered by template's declared tools)
 *   3. Assemble section prompts from prompts/sections/{name}.md
 *      (controlled by template's prompt_sections field)
 *   4. Append knowledge/ files (existing mechanism)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as yaml from "js-yaml";

import { Agent } from "../agents/agent.js";
import type { Config } from "../config.js";
import type { ToolDef } from "../providers/base.js";
import { BASIC_TOOLS, BASIC_TOOLS_MAP } from "../tools/basic.js";
import type { MCPClientManager } from "../mcp-client.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const AGENT_YAML = "agent.yaml";
const REQUIRED_TEMPLATE_TYPE = "agent";
const MIN_TEMPLATE_MAX_TOOL_ROUNDS = 100;

/**
 * Canonical ordering for tool prompt assembly.
 * Tools not in this list are appended alphabetically after these.
 */
export const TOOL_PROMPT_ORDER: string[] = [
  // File I/O
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  // Shell
  "bash",
  "bash_background",
  "bash_output",
  "kill_shell",
  "time",
  // Web
  "web_search",
  "web_fetch",
  // Orchestration
  "spawn",
  "spawn_file",
  "wait",
  "kill_agent",
  "check_status",
  // Context
  "show_context",
  "distill_context",
  // Interaction
  "ask",
  "skill",
];

/**
 * Paired tool dependencies.
 * If a tool (key) is in the list, all its required companions (value) must also be present.
 */
export const TOOL_REQUIRES: Record<string, string[]> = {
  bash_output: ["bash_background"],
  kill_shell: ["bash_background"],
  bash_background: ["bash_output"],
};

/**
 * Tool packs — named groups of related tools.
 * Used in agent.yaml `tools` field: `tools: [read, shell, util]`
 * Pack names and individual tool names can be freely mixed.
 */
export const TOOL_PACKS: Record<string, string[]> = {
  read:  ["read_file", "list_dir", "glob", "grep"],
  edit:  ["write_file", "edit_file"],
  shell: ["bash", "bash_background", "bash_output", "kill_shell"],
  util:  ["time", "web_search", "web_fetch"],
};

/**
 * Default tools for custom templates that omit `tools` in agent.yaml.
 * Same set as the executor template — all packs.
 */
export const EXECUTOR_DEFAULT_TOOLS: string[] = [
  ...TOOL_PACKS.read,
  ...TOOL_PACKS.edit,
  ...TOOL_PACKS.shell,
  ...TOOL_PACKS.util,
];

/**
 * Recipe for dynamic system prompt reassembly.
 * Stored on Agent so Session can re-run the assembly pipeline at each API call.
 */
export interface PromptRecipe {
  templateDir: string;
  spec: Record<string, unknown>;
  promptsDirs: string[];
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Load a single agent template from `templateDir`.
 *
 * @param templateDir  Path to the template folder (must contain `agent.yaml`).
 * @param config       Global Config instance (provides model resolution).
 * @param nameOverride If given, replaces the `name` field from the YAML.
 * @param mcpManager   Optional MCP client manager for MCP tool resolution.
 * @param promptsDirs  Ordered list of `prompts/` directories (user override first, bundled second).
 *                     If omitted or empty, no tool/section prompts are assembled.
 * @returns            Fully constructed Agent, ready to use.
 */
/**
 * Assemble a system prompt from a template recipe.
 *
 * This is the core assembly pipeline, extracted so it can be re-run
 * at each API call for dynamic prompt updates (new skills, prompt edits,
 * software updates, etc.).
 */
export function assembleSystemPrompt(recipe: PromptRecipe): string {
  const { templateDir, spec, promptsDirs } = recipe;

  // --- 1. Resolve core system prompt ---
  let systemPrompt = resolveSystemPrompt(spec, templateDir);

  // --- 2. Assemble tool prompts ---
  const toolsPromptFile = spec["tools_prompt_file"] as string | undefined;
  if (toolsPromptFile) {
    // Per-agent unified tools file — preferred path
    const toolsPath = join(templateDir, toolsPromptFile);
    if (existsSync(toolsPath)) {
      const toolsContent = readFileSync(toolsPath, "utf-8").trimEnd();
      if (toolsContent) {
        systemPrompt = systemPrompt.trimEnd() + "\n\n---\n\n# Tools\n\n" + toolsContent;
      }
    }
  } else if (promptsDirs.length > 0) {
    // Fallback: per-tool assembly for custom/legacy templates
    const toolNames = resolveToolNames(spec);
    validateToolDependencies(toolNames);
    const toolPrompts = assembleToolPrompts(toolNames, promptsDirs);
    if (toolPrompts) {
      systemPrompt = systemPrompt.trimEnd() + "\n\n---\n\n# Tools\n\n" + toolPrompts;
    }
  }

  // --- 3. Assemble section prompts ---
  if (promptsDirs.length > 0) {
    const sections = resolveSections(spec);
    const sectionPrompts = assembleSectionPrompts(sections, promptsDirs);
    if (sectionPrompts) {
      systemPrompt = systemPrompt.trimEnd() + "\n\n" + sectionPrompts;
    }
  }

  // --- 4. Append knowledge files (if any) ---
  const knowledgeDir = join(templateDir, "knowledge");
  if (existsSync(knowledgeDir) && statSync(knowledgeDir).isDirectory()) {
    const knowledgeParts: string[] = [];
    const entries = readdirSync(knowledgeDir).sort();
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(knowledgeDir, entry);
      try {
        if (!statSync(fullPath).isFile()) continue;
      } catch {
        continue;
      }
      knowledgeParts.push(readFileSync(fullPath, "utf-8"));
    }
    if (knowledgeParts.length > 0) {
      systemPrompt =
        systemPrompt.trimEnd() + "\n\n" + knowledgeParts.join("\n\n");
    }
  }

  return systemPrompt;
}

export function loadTemplate(
  templateDir: string,
  config: Config,
  nameOverride?: string,
  mcpManager?: MCPClientManager,
  promptsDirs?: string[],
): Agent {
  const yamlPath = join(templateDir, AGENT_YAML);
  if (!existsSync(yamlPath)) {
    throw new Error(`Template config not found: ${yamlPath}`);
  }

  const raw = readFileSync(yamlPath, "utf-8");
  const spec = (yaml.load(raw) as Record<string, unknown>) ?? {};
  const typeError = validateTemplateType(spec);
  if (typeError) {
    throw new Error(typeError);
  }

  const name =
    nameOverride ??
    (spec["name"] as string | undefined) ??
    basename(templateDir);
  const model = spec["model"] as string | undefined;

  const resolvedPromptsDirs = promptsDirs && promptsDirs.length > 0
    ? promptsDirs
    : [];

  const recipe: PromptRecipe = { templateDir, spec, promptsDirs: resolvedPromptsDirs };
  const systemPrompt = assembleSystemPrompt(recipe);

  const agent = buildAgent(
    spec,
    name,
    model,
    systemPrompt,
    config,
    mcpManager,
  );

  // Store recipe for dynamic reassembly
  agent.promptRecipe = recipe;

  return agent;
}

/**
 * Scan template directories and load all templates with layered override.
 *
 * Three-layer template loading with layered override:
 *
 * 1. **Bundled** — always loaded from the package.
 * 2. **User-global** (`~/.vigil/agent_templates/`) — adds new templates only;
 *    cannot override bundled templates (their prompt assembly assumes a specific format).
 * 3. **Project-local** (`{project}/.vigil/agent_templates/`) — highest priority;
 *    CAN override both bundled and user-global templates.
 *
 * @param bundledRoot  Bundled templates root (always available from the package).
 * @param config       Global Config instance.
 * @param mcpManager   Optional MCP client manager.
 * @param promptsDirs  Ordered prompts directories (user first, bundled second).
 * @param userRoot     Optional user override templates root (~/.vigil/agent_templates/).
 * @param projectRoot  Optional project-local templates root ({project}/.vigil/agent_templates/).
 * @returns `{ name: agent }` record.
 */
export function loadTemplates(
  bundledRoot: string,
  config: Config,
  mcpManager?: MCPClientManager,
  promptsDirs?: string[],
  userRoot?: string,
  projectRoot?: string,
): Record<string, Agent> {
  if (!existsSync(bundledRoot) || !statSync(bundledRoot).isDirectory()) {
    throw new Error(`Bundled templates root not found: ${bundledRoot}`);
  }

  // Pass 1: bundled templates (base layer)
  const templateDirs: Record<string, string> = {};
  const bundledNames = new Set<string>();
  for (const child of readdirSync(bundledRoot).sort()) {
    const childPath = join(bundledRoot, child);
    if (isTemplateDir(childPath)) {
      templateDirs[child] = childPath;
      bundledNames.add(child);
    }
  }

  // Pass 2: user-global additions (cannot override bundled)
  if (userRoot && existsSync(userRoot) && statSync(userRoot).isDirectory()) {
    for (const child of readdirSync(userRoot).sort()) {
      if (bundledNames.has(child)) continue; // never override bundled templates
      if (child.startsWith("_")) continue; // _-prefixed dirs are examples, not loaded
      const childPath = join(userRoot, child);
      if (isTemplateDir(childPath)) {
        templateDirs[child] = childPath;
      }
    }
  }

  // Pass 3: project-local templates (CAN override bundled and user-global)
  if (projectRoot && existsSync(projectRoot) && statSync(projectRoot).isDirectory()) {
    for (const child of readdirSync(projectRoot).sort()) {
      if (child.startsWith("_")) continue;
      const childPath = join(projectRoot, child);
      if (isTemplateDir(childPath)) {
        templateDirs[child] = childPath;
      }
    }
  }

  const resolvedPromptsDirs = promptsDirs && promptsDirs.length > 0
    ? promptsDirs
    : [resolvePromptsDir(bundledRoot)].filter((d): d is string => !!d);

  const agents: Record<string, Agent> = {};
  for (const name of Object.keys(templateDirs).sort()) {
    const agent = loadTemplate(templateDirs[name], config, undefined, mcpManager, resolvedPromptsDirs);
    agents[agent.name] = agent;
  }

  return agents;
}

function isTemplateDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, AGENT_YAML));
  } catch {
    return false;
  }
}

/**
 * Validate a template directory without loading it.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateTemplate(templateDir: string): string | null {
  const yamlPath = join(templateDir, AGENT_YAML);
  if (!existsSync(yamlPath)) {
    return `Missing agent.yaml in ${templateDir}`;
  }

  let spec: Record<string, unknown>;
  try {
    const raw = readFileSync(yamlPath, "utf-8");
    spec = (yaml.load(raw) as Record<string, unknown>) ?? {};
  } catch (e) {
    return `Invalid YAML in agent.yaml: ${e}`;
  }

  const typeError = validateTemplateType(spec);
  if (typeError) {
    return typeError;
  }

  if (!spec["system_prompt"] && !spec["system_prompt_file"]) {
    return "agent.yaml must have either 'system_prompt' or 'system_prompt_file'";
  }

  if (typeof spec["system_prompt_file"] === "string") {
    const promptPath = join(templateDir, spec["system_prompt_file"]);
    if (!existsSync(promptPath)) {
      return `system_prompt_file not found: ${spec["system_prompt_file"]}`;
    }
  }

  if (typeof spec["tools_prompt_file"] === "string") {
    const toolsPromptPath = join(templateDir, spec["tools_prompt_file"]);
    if (!existsSync(toolsPromptPath)) {
      return `tools_prompt_file not found: ${spec["tools_prompt_file"]}`;
    }
  }

  const toolsSpec = spec["tools"];
  if (toolsSpec != null && toolsSpec !== "all" && !Array.isArray(toolsSpec)) {
    return `Invalid tools spec: must be "all", a list of tool/pack names, or omitted`;
  }
  if (Array.isArray(toolsSpec)) {
    for (const entry of toolsSpec) {
      if (typeof entry !== "string") {
        return `Invalid tools entry: expected string, got ${typeof entry}`;
      }
      if (!TOOL_PACKS[entry] && !BASIC_TOOLS_MAP[entry]) {
        return `Unknown tool or pack '${entry}'. Available tools: ${Object.keys(BASIC_TOOLS_MAP).join(", ")}; packs: ${Object.keys(TOOL_PACKS).join(", ")}`;
      }
    }
  }

  const maxRoundsError = validateTemplateMaxToolRounds(spec);
  if (maxRoundsError) {
    return maxRoundsError;
  }

  return null;
}

// ------------------------------------------------------------------
// Prompt assembly
// ------------------------------------------------------------------

/**
 * Resolve the prompts/ directory as a sibling of the templates root.
 * Returns the path if found, or undefined if not.
 */
export function resolvePromptsDir(templatesRoot: string): string | undefined {
  const candidate = join(dirname(templatesRoot), "prompts");
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return candidate;
  }
  return undefined;
}

/**
 * Resolve tool names from the `tools` field in agent.yaml.
 *
 * - `"all"` → all tools in TOOL_PROMPT_ORDER
 * - Array of names/packs → expand packs, deduplicate
 * - Absent / null → EXECUTOR_DEFAULT_TOOLS (for custom templates)
 *
 * Pack names and individual tool names can be mixed freely:
 *   tools: [read, bash, time]   →  read_file, list_dir, glob, grep, bash, time
 */
export function resolveToolNames(spec: Record<string, unknown>): string[] {
  const toolsSpec = spec["tools"];
  if (toolsSpec == null) return [...EXECUTOR_DEFAULT_TOOLS];
  if (toolsSpec === "all") return [...TOOL_PROMPT_ORDER];
  if (Array.isArray(toolsSpec)) return expandToolSpecs(toolsSpec as string[]);
  throw new Error(`Invalid tools spec: ${JSON.stringify(toolsSpec)}`);
}

/**
 * Expand an array of tool specs (pack names and/or individual tool names)
 * into a deduplicated list of individual tool names.
 */
function expandToolSpecs(specs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const spec of specs) {
    const packTools = TOOL_PACKS[spec];
    if (packTools) {
      for (const tool of packTools) {
        if (!seen.has(tool)) {
          seen.add(tool);
          result.push(tool);
        }
      }
    } else {
      if (!seen.has(spec)) {
        seen.add(spec);
        result.push(spec);
      }
    }
  }
  return result;
}

/**
 * Validate that paired tool dependencies are satisfied.
 */
export function validateToolDependencies(toolNames: string[]): void {
  const nameSet = new Set(toolNames);
  for (const [tool, requires] of Object.entries(TOOL_REQUIRES)) {
    if (!nameSet.has(tool)) continue;
    for (const req of requires) {
      if (!nameSet.has(req)) {
        throw new Error(
          `Tool '${tool}' requires '${req}' to be included in the tools list.`,
        );
      }
    }
  }
}

/**
 * Read and concatenate tool prompt files in canonical order.
 * For each tool, the first matching file across `promptsDirs` is used (user override first).
 * Tools without a corresponding prompt file are silently skipped.
 */
export function assembleToolPrompts(
  toolNames: string[],
  promptsDirs: string[],
): string {
  // Sort by TOOL_PROMPT_ORDER, unknowns go to the end alphabetically
  const orderIndex = new Map(TOOL_PROMPT_ORDER.map((n, i) => [n, i]));
  const sorted = [...toolNames].sort((a, b) => {
    const ia = orderIndex.get(a) ?? Infinity;
    const ib = orderIndex.get(b) ?? Infinity;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  });

  const parts: string[] = [];
  for (const name of sorted) {
    const filePath = resolveLayeredFile(promptsDirs, "tools", `${name}.md`);
    if (!filePath) continue;
    try {
      parts.push(readFileSync(filePath, "utf-8").trimEnd());
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join("\n\n");
}

/**
 * Resolve prompt_sections from the spec.
 * Defaults to [] if omitted.
 */
function resolveSections(spec: Record<string, unknown>): string[] {
  const sections = spec["prompt_sections"];
  if (sections == null) return [];
  if (Array.isArray(sections)) return sections as string[];
  return [];
}

/**
 * Read and concatenate section prompt files.
 * For each section, the first matching file across `promptsDirs` is used.
 */
export function assembleSectionPrompts(
  sections: string[],
  promptsDirs: string[],
): string {
  if (sections.length === 0) return "";

  const parts: string[] = [];
  for (const name of sections) {
    const filePath = resolveLayeredFile(promptsDirs, "sections", `${name}.md`);
    if (!filePath) continue;
    try {
      parts.push(readFileSync(filePath, "utf-8").trimEnd());
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join("\n\n");
}

/**
 * Resolve a file across multiple directories, returning the first match.
 * Directories are checked in order (user override first, bundled second).
 */
function resolveLayeredFile(dirs: string[], subdir: string, filename: string): string | null {
  for (const dir of dirs) {
    const filePath = join(dir, subdir, filename);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

/**
 * Return the system prompt string from inline text or an external file.
 */
function resolveSystemPrompt(
  spec: Record<string, unknown>,
  templateDir: string,
): string {
  if (typeof spec["system_prompt"] === "string") {
    return spec["system_prompt"];
  }
  if (typeof spec["system_prompt_file"] === "string") {
    const promptPath = join(templateDir, spec["system_prompt_file"]);
    if (!existsSync(promptPath)) {
      throw new Error(`system_prompt_file not found: ${promptPath}`);
    }
    return readFileSync(promptPath, "utf-8");
  }
  return "";
}

function validateTemplateType(spec: Record<string, unknown>): string | null {
  const type = spec["type"];
  if (typeof type !== "string" || !type.trim()) {
    return `agent.yaml must set type: ${REQUIRED_TEMPLATE_TYPE}`;
  }
  if (type !== REQUIRED_TEMPLATE_TYPE) {
    return `Invalid template type '${type}': expected '${REQUIRED_TEMPLATE_TYPE}'`;
  }
  return null;
}

function validateTemplateMaxToolRounds(spec: Record<string, unknown>): string | null {
  const raw = spec["max_tool_rounds"];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return `agent.yaml must set integer max_tool_rounds >= ${MIN_TEMPLATE_MAX_TOOL_ROUNDS}`;
  }
  if (raw < MIN_TEMPLATE_MAX_TOOL_ROUNDS) {
    return `max_tool_rounds must be >= ${MIN_TEMPLATE_MAX_TOOL_ROUNDS} (got ${raw})`;
  }
  return null;
}

/**
 * Resolve the `tools` field to a list of ToolDef objects.
 *
 * - `"all"` => all built-in tools
 * - A list of pack/tool names => expand packs, resolve each from BASIC_TOOLS_MAP
 * - Absent / null => empty list (custom templates get defaults via resolveToolNames)
 */
function resolveTools(spec: Record<string, unknown>): ToolDef[] {
  const toolsSpec = spec["tools"];
  if (toolsSpec == null) return [];

  if (toolsSpec === "all") {
    // BASIC_TOOLS includes all basic tools.
    // Comm tools (spawn, spawn_file, wait, etc.) are injected by Session at runtime.
    return [...BASIC_TOOLS];
  }

  if (Array.isArray(toolsSpec)) {
    const toolNames = expandToolSpecs(toolsSpec as string[]);
    const resolved: ToolDef[] = [];
    for (const name of toolNames) {
      const tool = BASIC_TOOLS_MAP[name];
      if (!tool) {
        throw new Error(
          `Unknown tool '${name}'. Available: ${Object.keys(BASIC_TOOLS_MAP).join(", ")}, packs: ${Object.keys(TOOL_PACKS).join(", ")}`,
        );
      }
      resolved.push(tool);
    }
    return resolved;
  }

  throw new Error(`Invalid tools spec: ${JSON.stringify(toolsSpec)}`);
}

/**
 * Resolve the `mcp_tools` field to MCP ToolDef objects.
 */
function resolveMcpTools(
  spec: Record<string, unknown>,
  mcpManager?: MCPClientManager,
): ToolDef[] {
  if (!mcpManager) return [];

  const mcpSpec = spec["mcp_tools"];
  if (!mcpSpec || mcpSpec === "none") return [];

  if (mcpSpec === "all") {
    return mcpManager.getAllTools();
  }

  if (Array.isArray(mcpSpec)) {
    const tools: ToolDef[] = [];
    for (const serverName of mcpSpec) {
      const serverTools = mcpManager.getToolsForServer(serverName as string);
      if (serverTools.length === 0) {
        console.warn(
          `MCP server '${serverName}' has no tools or is not connected`,
        );
      }
      tools.push(...serverTools);
    }
    return tools;
  }

  return [];
}

/**
 * Build a fully configured Agent from the parsed YAML spec.
 */
function buildAgent(
  spec: Record<string, unknown>,
  name: string,
  model: string | undefined,
  systemPrompt: string,
  config: Config,
  mcpManager?: MCPClientManager,
): Agent {
  const typeError = validateTemplateType(spec);
  if (typeError) {
    throw new Error(typeError);
  }
  const maxRoundsError = validateTemplateMaxToolRounds(spec);
  if (maxRoundsError) {
    throw new Error(maxRoundsError);
  }

  const resolvedModel = model ?? config.defaultModel;
  if (!resolvedModel) {
    throw new Error(
      `No model specified for template '${name}' and no default model in config.`,
    );
  }

  const tools = [...resolveTools(spec), ...resolveMcpTools(spec, mcpManager)];

  const opts: {
    name: string;
    role: string;
    model: string;
    config: Config;
    tools: ToolDef[];
    maxToolRounds?: number;
    description?: string;
  } = {
    name,
    role: systemPrompt,
    model: resolvedModel,
    config,
    tools,
  };

  opts.maxToolRounds = spec["max_tool_rounds"] as number;
  if (typeof spec["description"] === "string") {
    opts.description = spec["description"];
  }

  const agent = new Agent(opts);

  // Keep MCP selection intent for runtime lazy wiring in Session._ensureMcp().
  (agent as any)._mcpToolsSpec = spec["mcp_tools"] ?? undefined;

  return agent;
}
