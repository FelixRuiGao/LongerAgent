/**
 * System prompt assembler — builds the full system prompt from layers.
 *
 * Follows Fermi's pattern: agent base prompt + prompt layers.
 *
 * Formula:
 *   systemPrompt =
 *     agent.prompt                    ← from template (role + tools + knowledge)
 *     + memory layer (AGENTS.md)      ← from disk, refreshed per-reload
 *     + agent model pins              ← from config
 *     + variable rendering            ← {PROJECT_ROOT}, {SESSION_ARTIFACTS}, {SYSTEM_DATA}
 *
 * All layers are assembled here — Session no longer does ad-hoc string concatenation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getFermiHomeDir } from "./home-path.js";

// ------------------------------------------------------------------
// Prompt layer types
// ------------------------------------------------------------------

export interface PromptLayer {
  id: string;
  order: number;
  content: () => string;
}

// ------------------------------------------------------------------
// Variable rendering
// ------------------------------------------------------------------

export interface PromptVariables {
  projectRoot: string;
  sessionArtifacts: string;
  systemData: string;
}

export function renderPromptVariables(prompt: string, vars: PromptVariables): string {
  return prompt
    .replace(/\{PROJECT_ROOT\}/g, vars.projectRoot)
    .replace(/\{SESSION_ARTIFACTS\}/g, vars.sessionArtifacts)
    .replace(/\{SYSTEM_DATA\}/g, vars.systemData);
}

// ------------------------------------------------------------------
// Built-in layers
// ------------------------------------------------------------------

/**
 * Read AGENTS.md persistent memory from global + project paths.
 * Returns empty string if no memory files exist.
 */
export function readAgentsMemory(projectRoot: string): string {
  const parts: string[] = [];

  const globalPath = join(getFermiHomeDir(), "AGENTS.md");
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, "utf-8").trim();
      if (content) parts.push(`## Global Memory\n\n${content}`);
    } catch { /* ignore */ }
  }

  const projectPath = join(projectRoot, "AGENTS.md");
  if (existsSync(projectPath)) {
    try {
      const content = readFileSync(projectPath, "utf-8").trim();
      if (content) parts.push(`## Project Memory\n\n${content}`);
    } catch { /* ignore */ }
  }

  return parts.join("\n\n---\n\n");
}

/**
 * Build a prompt section listing agent model pins.
 */
export function buildAgentModelPinsSection(
  agentModels: Record<string, { provider: string; selection_key: string; model_id: string; thinking_level?: string }>,
): string | null {
  const entries = Object.entries(agentModels);
  if (entries.length === 0) return null;

  const lines = entries.map(([template, model]) => {
    const parts = [`- **${template}**: ${model.model_id}`];
    if (model.thinking_level) parts[0] += ` (thinking: ${model.thinking_level})`;
    return parts[0];
  });

  return [
    "",
    "The following sub-agent templates have user-pinned models.",
    "When spawning these agents, do NOT specify `model_level` — the pinned model will be used automatically:",
    "",
    ...lines,
  ].join("\n");
}

// ------------------------------------------------------------------
// Assembler
// ------------------------------------------------------------------

export interface AssembleOptions {
  /** Base agent prompt (from template: role + tools + knowledge). */
  agentPrompt: string;
  /** Project root path (for AGENTS.md and variable rendering). */
  projectRoot: string;
  /** Session artifacts directory path. */
  sessionArtifacts: string;
  /** System data directory path. */
  systemData: string;
  /** Agent model pins from config (for the model pins section). */
  agentModels?: Record<string, { provider: string; selection_key: string; model_id: string; thinking_level?: string }>;
  /** Additional prompt layers (hooks, injected turns, etc.). */
  extraLayers?: PromptLayer[];
}

/**
 * Assemble the full system prompt from agent base + layers + variables.
 *
 * This is the single entry point for system prompt construction.
 * Called at session init and on each reload (AGENTS.md edit, /reload, etc.).
 */
export function assembleFullSystemPrompt(opts: AssembleOptions): string {
  let prompt = opts.agentPrompt;

  // Layer: AGENTS.md persistent memory
  const memory = readAgentsMemory(opts.projectRoot);
  if (memory) {
    prompt = prompt.trimEnd() +
      "\n\n---\n\n# Persistent Memory (AGENTS.md)\n\n" +
      memory;
  }

  // Layer: agent model pins
  if (opts.agentModels) {
    const pinsSection = buildAgentModelPinsSection(opts.agentModels);
    if (pinsSection) {
      prompt = prompt.trimEnd() + "\n\n" + pinsSection;
    }
  }

  // Layer: extra (hooks, injected turns — future extension point)
  if (opts.extraLayers) {
    const sorted = [...opts.extraLayers].sort((a, b) => a.order - b.order);
    for (const layer of sorted) {
      const content = layer.content();
      if (content) {
        prompt = prompt.trimEnd() + "\n\n" + content;
      }
    }
  }

  // Variable rendering (last — so variables in layers are also rendered)
  prompt = renderPromptVariables(prompt, {
    projectRoot: opts.projectRoot,
    sessionArtifacts: opts.sessionArtifacts,
    systemData: opts.systemData,
  });

  return prompt;
}
