/**
 * PermissionAdvisor — the main GateAdvisor that makes allow/ask/deny decisions.
 *
 * Flow:
 *   1. Classify the tool call → InvocationAssessment
 *   2. Check persisted rules → if matching allow, short-circuit allow
 *   3. Apply decision matrix (mode × class → allow/ask)
 *   4. Build approval offers for ask decisions
 */

import type { GateAdvisor, GateDecision } from "../tool-runtime.js";
import type { ToolPreflightContext } from "../agents/tool-loop.js";
import { classifyTool, classifyToolAsync } from "./classify.js";
import { PermissionRuleStore } from "./rules.js";
import type {
  PermissionMode,
  InvocationAssessment,
  ApprovalOffer,
  PermissionRule,
} from "./types.js";
import { effectiveMode } from "./types.js";

// ------------------------------------------------------------------
// PermissionAdvisor
// ------------------------------------------------------------------

export class PermissionAdvisor implements GateAdvisor {
  private _ruleStore: PermissionRuleStore;
  private _sessionMode: PermissionMode;
  private _agentCeiling?: PermissionMode;

  /** In-memory "allow once" grants for this session (toolCallId → true). */
  private _allowOnceGrants = new Set<string>();

  constructor(opts: {
    ruleStore: PermissionRuleStore;
    sessionMode?: PermissionMode;
    agentCeiling?: PermissionMode;
  }) {
    this._ruleStore = opts.ruleStore;
    this._sessionMode = opts.sessionMode ?? "reversible";
    this._agentCeiling = opts.agentCeiling;
  }

  get sessionMode(): PermissionMode {
    return this._sessionMode;
  }

  set sessionMode(mode: PermissionMode) {
    this._sessionMode = mode;
  }

  get ruleStore(): PermissionRuleStore {
    return this._ruleStore;
  }

  // -- GateAdvisor interface -------------------------------------------

  async evaluate(ctx: ToolPreflightContext): Promise<GateDecision> {
    const assessment = await classifyToolAsync(ctx.toolName, ctx.toolArgs);
    const mode = effectiveMode(this._sessionMode, this._agentCeiling);

    // 1. Check allow-once grants
    if (this._allowOnceGrants.has(ctx.toolCallId)) {
      return { kind: "allow" };
    }

    // 2. Check persisted rules (skip in read_only — mode is the hard ceiling)
    if (mode !== "read_only") {
      const matchingRule = this._ruleStore.findMatchingRule(assessment);
      if (matchingRule) {
        if (matchingRule.action === "deny") {
          return { kind: "deny", message: `Denied by rule: ${matchingRule.id}` };
        }
        // allow rule — but catastrophic ALWAYS asks
        if (assessment.permissionClass !== "catastrophic") {
          return { kind: "allow" };
        }
      }
    }

    // 3. Decision matrix
    const decision = this._applyMatrix(mode, assessment);
    if (decision === "allow") {
      return { kind: "allow" };
    }

    // 4. Build approval offers (read_only: only allow-once, no persistent rules)
    const offers = this._buildOffers(assessment, mode);
    return {
      kind: "ask",
      question: this._buildQuestion(ctx, assessment),
      toolCallId: ctx.toolCallId,
      offers,
      assessment,
    };
  }

  // -- Allow-once management -------------------------------------------

  grantAllowOnce(toolCallId: string): void {
    this._allowOnceGrants.add(toolCallId);
  }

  /** Persist a rule from an accepted approval offer. */
  acceptOffer(offer: ApprovalOffer): void {
    if (offer.rule) {
      this._ruleStore.addRule(offer.rule);
    }
  }

  // -- Decision matrix -------------------------------------------------

  private _applyMatrix(
    mode: PermissionMode,
    assessment: InvocationAssessment,
  ): "allow" | "ask" {
    const cls = assessment.permissionClass;

    // Catastrophic ALWAYS asks, even in yolo
    if (cls === "catastrophic") return "ask";

    // Read and spawn are always allowed
    if (cls === "read" || cls === "spawn") return "allow";

    switch (mode) {
      case "yolo":
        return "allow";

      case "reversible":
        if (cls === "write_reversible") return "allow";
        return "ask";

      case "read_only":
        return "ask";
    }
  }

  // -- Offer building --------------------------------------------------

  private _buildOffers(assessment: InvocationAssessment, mode?: PermissionMode): ApprovalOffer[] {
    const offers: ApprovalOffer[] = [];

    // Always offer "allow once"
    offers.push({
      type: "tool_once",
      label: "Allow once",
    });

    // read_only / catastrophic: only allow once, no persistent rules
    if (mode === "read_only" || assessment.permissionClass === "catastrophic") {
      return offers;
    }

    // If memoizable, offer tool_pattern rules at each scope
    if (assessment.canMemoize && assessment.canonicalPattern) {
      const pattern = assessment.canonicalPattern;
      const tool = assessment.toolName;

      for (const scope of ["session", "project", "global"] as const) {
        const rule: Omit<PermissionRule, "id" | "createdAt"> = {
          type: "tool_pattern",
          action: "allow",
          tool,
          pattern,
          scope,
        };
        offers.push({
          type: "tool_pattern",
          label: `Allow "${pattern}" (${scope})`,
          scope,
          rule: rule as PermissionRule, // id/createdAt filled on accept
        });
      }
    } else if (assessment.canMemoize) {
      // No pattern but memoizable (e.g. write_file, edit_file)
      const tool = assessment.toolName;
      for (const scope of ["session", "project", "global"] as const) {
        const rule: Omit<PermissionRule, "id" | "createdAt"> = {
          type: "tool_pattern",
          action: "allow",
          tool,
          scope,
        };
        offers.push({
          type: "tool_pattern",
          label: `Allow ${tool} (${scope})`,
          scope,
          rule: rule as PermissionRule,
        });
      }
    }

    return offers;
  }

  private _buildQuestion(
    ctx: ToolPreflightContext,
    assessment: InvocationAssessment,
  ): string {
    const cls = assessment.permissionClass;
    if (cls === "catastrophic") {
      return `DANGEROUS: ${ctx.toolName} — this operation could cause irreversible damage. ${ctx.summary}`;
    }
    if (cls === "write_danger") {
      return `${ctx.toolName} is a potentially dangerous operation. ${ctx.summary}`;
    }
    return `${ctx.toolName} requires approval. ${ctx.summary}`;
  }
}
