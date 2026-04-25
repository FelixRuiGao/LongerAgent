/**
 * Permission rules — storage and matching.
 *
 * Three scopes:
 *   session — in-memory only, dies with the session
 *   project — {projectRoot}/.fermi/permissions.json
 *   global  — ~/.fermi/permissions.json
 *
 * Rule matching: deny rules take priority over allow rules.
 * Within the same action, more specific scope wins (session > project > global).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getFermiHomeDir } from "../home-path.js";
import type { PermissionRule, PermissionRuleFile, InvocationAssessment } from "./types.js";

// ------------------------------------------------------------------
// PermissionRuleStore — manages rules across all three scopes
// ------------------------------------------------------------------

export class PermissionRuleStore {
  private _sessionRules: PermissionRule[] = [];
  private _projectRoot: string;

  constructor(projectRoot: string) {
    this._projectRoot = projectRoot;
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

    // Allow rules (session > project > global, so allRules is already ordered)
    const allowMatch = allRules.find(
      (r) => r.action === "allow" && this._ruleMatches(r, assessment),
    );
    return allowMatch ?? null;
  }

  /** Get all effective rules, ordered: session first, then project, then global. */
  private _getEffectiveRules(): PermissionRule[] {
    return [
      ...this._sessionRules,
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
    const full: PermissionRule = {
      ...rule,
      id: this._generateId(rule.scope),
      createdAt: Date.now(),
    };

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

  // -- Rule matching ---------------------------------------------------

  private _ruleMatches(rule: PermissionRule, assessment: InvocationAssessment): boolean {
    if (rule.type !== "tool_pattern") return false;
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

  private _projectFilePath(): string {
    return join(this._projectRoot, ".fermi", "permissions.json");
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
    // Atomic write: write to temp then rename
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
