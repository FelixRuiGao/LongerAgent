/**
 * Permission rules — storage and matching.
 *
 * Four layers (most specific wins):
 *   session   — in-memory only, dies with the session
 *   workspace — {projectRoot}/.fermi/permissions.json (user-authored, read-only by system)
 *   project   — ~/.fermi/projects/<slug>/permissions.json (system-managed)
 *   global    — ~/.fermi/permissions.json
 *
 * Rule matching: deny rules take priority over allow rules.
 * Within the same action, more specific scope wins.
 *
 * System writes (from approval choices) go to project or global.
 * Workspace rules are read-only — only the user creates/edits them.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getFermiHomeDir } from "../home-path.js";
import type { PermissionRule, PermissionRuleFile, InvocationAssessment, ExternalPathRule } from "./types.js";

// ------------------------------------------------------------------
// PermissionRuleStore — manages rules across all layers
// ------------------------------------------------------------------

export class PermissionRuleStore {
  private _sessionRules: PermissionRule[] = [];
  /** ~/.fermi/projects/<slug>/ — system-managed project store. */
  private _projectStoreDir: string;
  /** {projectRoot} — workspace root (read-only for rules). */
  private _workspaceRoot: string | undefined;

  constructor(opts: {
    projectStoreDir: string;
    workspaceRoot?: string;
  }) {
    this._projectStoreDir = opts.projectStoreDir;
    this._workspaceRoot = opts.workspaceRoot;
  }

  // -- Query ----------------------------------------------------------

  /** Find the first matching rule. Deny rules are checked before allow rules. */
  findMatchingRule(assessment: InvocationAssessment): PermissionRule | null {
    const allRules = this._getEffectiveRules();

    // Deny rules first
    const denyMatch = allRules.find(
      (r) => r.action === "deny" && this._ruleMatches(r, assessment),
    );
    if (denyMatch) return denyMatch;

    // Allow rules (ordered most-specific first)
    const allowMatch = allRules.find(
      (r) => r.action === "allow" && this._ruleMatches(r, assessment),
    );
    return allowMatch ?? null;
  }

  /** Get all effective rules, ordered: session > workspace > project > global. */
  private _getEffectiveRules(): PermissionRule[] {
    return [
      ...this._sessionRules,
      ...(this._workspaceRoot ? this._loadFileRules(this._workspaceFilePath()) : []),
      ...this._loadFileRules(this._projectFilePath()),
      ...this._loadFileRules(this._globalFilePath()),
    ];
  }

  /** Get all rules for display (e.g. /permissions list). */
  getAllRules(): PermissionRule[] {
    return this._getEffectiveRules();
  }

  // -- Mutations -------------------------------------------------------

  addRule(rule: Omit<PermissionRule, "id" | "createdAt">): PermissionRule {
    const full = {
      ...rule,
      id: this._generateId(rule.scope),
      createdAt: Date.now(),
    } as PermissionRule;

    if (full.scope === "session") {
      this._sessionRules.push(full);
    } else {
      const filePath = full.scope === "project"
        ? this._projectFilePath()
        : this._globalFilePath();
      const existing = this._loadFileRules(filePath);
      existing.push(full);
      this._saveFileRules(filePath, existing);
    }

    return full;
  }

  revokeRule(ruleId: string): boolean {
    // Session rules
    const sessionIdx = this._sessionRules.findIndex((r) => r.id === ruleId);
    if (sessionIdx >= 0) {
      this._sessionRules.splice(sessionIdx, 1);
      return true;
    }

    // File-backed rules — determine scope from ID prefix
    const filePath = ruleId.startsWith("p_")
      ? this._projectFilePath()
      : ruleId.startsWith("g_")
        ? this._globalFilePath()
        : null;

    if (!filePath) return false;

    const rules = this._loadFileRules(filePath);
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx < 0) return false;
    rules.splice(idx, 1);
    this._saveFileRules(filePath, rules);
    return true;
  }

  clearSessionRules(): void {
    this._sessionRules = [];
  }

  // -- External path rules ---------------------------------------------

  findMatchingExternalPathRule(
    resolvedPath: string,
    accessKind: "read" | "write_reversible",
  ): ExternalPathRule | null {
    const allRules = this._getEffectiveRules();
    for (const rule of allRules) {
      if (rule.type !== "external_path") continue;
      if (rule.action !== "allow") continue;
      if (accessKind === "write_reversible" && rule.accessKind !== "write_reversible") continue;
      // Normalize: ensure prefix ends with / to prevent /tmp/foo matching /tmp/foobar
      const prefix = rule.pathPrefix.endsWith("/") ? rule.pathPrefix : rule.pathPrefix + "/";
      if (resolvedPath.startsWith(prefix) || resolvedPath === prefix.slice(0, -1)) return rule;
    }
    return null;
  }

  /** Get all approved external path prefixes (for executor allowlist). */
  getApprovedExternalPrefixes(): string[] {
    const allRules = this._getEffectiveRules();
    const prefixes: string[] = [];
    for (const rule of allRules) {
      if (rule.type !== "external_path") continue;
      if (rule.action !== "allow") continue;
      prefixes.push(rule.pathPrefix.endsWith("/") ? rule.pathPrefix : rule.pathPrefix + "/");
    }
    return prefixes;
  }

  // -- Rule matching ---------------------------------------------------

  private _ruleMatches(rule: PermissionRule, assessment: InvocationAssessment): boolean {
    if (rule.type === "external_path") return false;
    if (rule.tool !== assessment.toolName) return false;

    // If rule has a pattern, match against canonical pattern or raw commands
    if (rule.pattern) {
      if (assessment.canonicalPattern) {
        return this._patternMatches(rule.pattern, assessment.canonicalPattern);
      }
      // No canonical pattern (complex command) — pattern rules don't apply
      return false;
    }

    // No pattern specified — matches all invocations of this tool
    return true;
  }

  private _patternMatches(rulePattern: string, subject: string): boolean {
    // Exact match
    if (rulePattern === subject) return true;

    // Simple glob: "git *" matches "git status", "git commit", etc.
    if (rulePattern.endsWith(" *")) {
      const prefix = rulePattern.slice(0, -1); // "git "
      return subject.startsWith(prefix);
    }

    return false;
  }

  // -- File I/O --------------------------------------------------------

  /** System-managed project rules: ~/.fermi/projects/<slug>/permissions.json */
  private _projectFilePath(): string {
    return join(this._projectStoreDir, "permissions.json");
  }

  /** User-authored workspace rules: {projectRoot}/.fermi/permissions.json (read-only) */
  private _workspaceFilePath(): string {
    return join(this._workspaceRoot!, ".fermi", "permissions.json");
  }

  private _globalFilePath(): string {
    return join(getFermiHomeDir(), "permissions.json");
  }

  private _loadFileRules(filePath: string): PermissionRule[] {
    if (!existsSync(filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as PermissionRuleFile;
      if (raw.version !== 1 || !Array.isArray(raw.rules)) return [];
      return raw.rules;
    } catch {
      return [];
    }
  }

  private _saveFileRules(filePath: string, rules: PermissionRule[]): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const data: PermissionRuleFile = { version: 1, rules };
    const tmpPath = filePath + ".tmp." + process.pid;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    renameSync(tmpPath, filePath);
  }

  private _generateId(scope: "session" | "project" | "global"): string {
    const prefix = scope === "session" ? "s_" : scope === "project" ? "p_" : "g_";
    return prefix + randomUUID().slice(0, 8);
  }
}
