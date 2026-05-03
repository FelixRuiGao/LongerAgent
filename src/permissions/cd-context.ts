/**
 * cd-aware context resolution for compound bash commands.
 *
 * Shared by the permission classifier (to decide whether rules apply)
 * and the bash executor (to resolve mutation paths correctly).
 */

import path from "node:path";
import { homedir } from "node:os";

export interface CdContext {
  /** Segments with pure-cd segments removed. */
  strippedSegments: string[];
  /** Effective cwd after resolving all cd segments. */
  effectiveCwd: string;
  /** Whether ANY non-cd segment runs outside projectRoot (once external, always external). */
  isExternal: boolean;
  /** Whether all cd targets were resolvable (no $VAR, no `-`). */
  allResolved: boolean;
}

/**
 * Extract the target path from a `cd` command segment.
 * Returns the raw target string, or null if unresolvable / not a cd command.
 */
export function extractCdTarget(segment: string): string | null {
  const trimmed = segment.trim();
  // Strip leading VAR=val assignments (e.g. "FOO=bar cd /tmp")
  const stripped = trimmed.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
  const parts = stripped.split(/\s+/);
  if (parts[0] !== "cd") return null;

  // `cd` with no argument → home directory
  if (parts.length === 1) return homedir();

  const target = parts[1]!;

  // Unresolvable targets
  if (target === "-") return null;
  if (target.startsWith("$") && target !== "$HOME") return null;
  if (target.includes("`") || target.includes("$(")) return null;

  // $HOME → home directory
  if (target === "$HOME") return homedir();

  // ~ expansion
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return path.join(homedir(), target.slice(2));

  return target;
}

/**
 * Walk compound command segments, resolve cd targets, and determine
 * whether subsequent commands run inside or outside projectRoot.
 */
export function resolveCdContext(
  segments: string[],
  projectRoot: string,
  cwd: string,
): CdContext {
  const resolvedProjectRoot = path.resolve(projectRoot);
  let effectiveCwd = path.resolve(cwd);
  let allResolved = true;
  let everExternal = false;
  const strippedSegments: string[] = [];

  for (const seg of segments) {
    const cdTarget = extractCdTarget(seg);
    if (cdTarget === null && isCdCommand(seg)) {
      allResolved = false;
      everExternal = true;
      strippedSegments.push(seg);
      continue;
    }
    if (cdTarget !== null) {
      effectiveCwd = path.isAbsolute(cdTarget)
        ? path.resolve(cdTarget)
        : path.resolve(effectiveCwd, cdTarget);
      if (!isWithinBase(resolvedProjectRoot, effectiveCwd)) {
        everExternal = true;
      }
      continue;
    }
    // Non-cd segment: check if it runs in an external context
    if (!isWithinBase(resolvedProjectRoot, effectiveCwd)) {
      everExternal = true;
    }
    strippedSegments.push(seg);
  }

  return { strippedSegments, effectiveCwd, isExternal: everExternal, allResolved };
}

// ------------------------------------------------------------------
// Parsed AST version (used by classifier — tree-sitter path)
// ------------------------------------------------------------------

export interface ParsedCdContext {
  /** Segments with pure-cd segments removed. */
  segments: import("./bash/types.js").ParsedBashSegment[];
  /** Effective cwd after resolving all cd segments. */
  effectiveCwd: string;
  /** Whether ANY non-cd segment runs outside projectRoot. */
  isExternal: boolean;
}

/**
 * cd-context resolution on tree-sitter parsed segments.
 * Handles quoted paths correctly via structured tokens.
 */
export function resolveCdContextParsed(
  segments: readonly import("./bash/types.js").ParsedBashSegment[],
  projectRoot: string,
  cwd: string,
): ParsedCdContext {
  const resolvedProjectRoot = path.resolve(projectRoot);
  let effectiveCwd = path.resolve(cwd);
  let everExternal = false;
  const kept: import("./bash/types.js").ParsedBashSegment[] = [];

  for (const seg of segments) {
    // A segment is a pure cd if it has exactly one command named "cd"
    if (seg.commands.length === 1 && seg.operator === "command") {
      const cmd = seg.commands[0]!;
      const name = cmd.name.split("/").pop() ?? cmd.name;
      if (name === "cd") {
        const target = extractCdTargetParsed(cmd);
        if (target === null) {
          // Unresolvable cd → treat as external
          everExternal = true;
        } else {
          effectiveCwd = path.isAbsolute(target)
            ? path.resolve(target)
            : path.resolve(effectiveCwd, target);
          if (!isWithinBase(resolvedProjectRoot, effectiveCwd)) {
            everExternal = true;
          }
        }
        continue;
      }
    }
    if (!isWithinBase(resolvedProjectRoot, effectiveCwd)) {
      everExternal = true;
    }
    kept.push(seg);
  }

  return { segments: kept, effectiveCwd, isExternal: everExternal };
}

function extractCdTargetParsed(cmd: import("./bash/types.js").ParsedBashCommand): string | null {
  // No arguments → home directory
  if (cmd.argv.length === 0) return homedir();

  // First non-flag argument
  const targetToken = cmd.argv.find(t => !t.value.startsWith("-"));
  if (!targetToken) return homedir();

  const val = targetToken.value;

  if (val === "-") return null;
  if (targetToken.kind === "unresolved_expression") return null;
  if (targetToken.kind === "home_reference" || val === "$HOME") return homedir();
  if (val === "~") return homedir();
  if (val.startsWith("~/")) return path.join(homedir(), val.slice(2));

  return val;
}

// ------------------------------------------------------------------
// Regex version (used by bash executor — no tree-sitter dependency)
// ------------------------------------------------------------------

function isCdCommand(segment: string): boolean {
  const stripped = segment.trim().replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
  return stripped.split(/\s+/)[0] === "cd";
}

function isWithinBase(baseAbs: string, candidateAbs: string): boolean {
  const rel = path.relative(baseAbs, candidateAbs);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.startsWith("..");
}
