/**
 * Unattended execution policy.
 *
 * `unattended` used to mean "confirmation is bypassed by contract", which made the flag a silent grant of
 * every mutation the base engine did not block. An unattended run now has its own explicit policy: the
 * tools it may execute, where it may write, whether it may use host processes, the network or state outside
 * the workspace, and the ceilings every run must be bounded by. Anything that would need a human is
 * escalated. For an unattended run that means refused, because no one is there to answer.
 *
 * Three controls stay separate:
 *   authorization  this policy: an explicit grant is required for every unattended call
 *   approval       confirmation, interactive runs only; it never grants anything unattended
 *   isolation      where a permitted tool runs (the sandbox); approval never upgrades it
 */

import type { ExecutionBudget } from "../types.js";
import { TOOL_RISK_ORDER, type ToolRisk } from "../tools/tool-contract.js";
import type { PolicyDecision, PolicyEngine, PolicyRequest } from "./policy-engine.js";

export interface UnattendedPolicy {
  /** Tool ids an unattended run may execute. Nothing is permitted unless listed here. */
  readonly permittedTools: readonly string[];
  /** Highest tool risk an unattended run may execute. Default "medium". */
  readonly maxRisk?: ToolRisk;
  /**
   * Workspace-relative path prefixes that filesystem-mutating tools may write under. Undefined leaves
   * the path decision to the workspace guard. When defined, a mutating call must name a path inside one.
   */
  readonly writePaths?: readonly string[];
  /** Whether permitted tools may reach the network. Default false. */
  readonly allowNetwork?: boolean;
  /** Whether permitted tools may run unsandboxed host processes. Default false. */
  readonly allowHostProcess?: boolean;
  /** Whether permitted tools may change state outside the workspace. Default false. Financial is never permitted. */
  readonly allowExternalMutation?: boolean;
}

/** The default: an unattended run may execute nothing. Products opt in tool by tool. */
export const DENY_ALL_UNATTENDED: UnattendedPolicy = { permittedTools: [] };

/** Ceilings every unattended run is bounded by. A caller's own limit is kept only when it is stricter. */
export const UNATTENDED_CEILINGS = {
  maxToolCalls: 200,
  maxModelCalls: 100,
  deadlineMs: 30 * 60_000,
} as const;

/** Applies the unattended ceilings to a run's budget: the stricter of the caller's value and the ceiling. */
export function applyUnattendedCeilings(budget: ExecutionBudget | undefined): ExecutionBudget {
  const given = budget ?? {};
  const stricter = (value: number | undefined, ceiling: number) =>
    value === undefined ? ceiling : Math.min(value, ceiling);
  return {
    ...given,
    maxToolCalls: stricter(given.maxToolCalls, UNATTENDED_CEILINGS.maxToolCalls),
    maxModelCalls: stricter(given.maxModelCalls, UNATTENDED_CEILINGS.maxModelCalls),
    deadlineMs: stricter(given.deadlineMs, UNATTENDED_CEILINGS.deadlineMs),
  };
}

/** Wraps an engine so that unattended calls must satisfy the policy. Interactive calls are unchanged. */
export function withUnattendedPolicy(inner: PolicyEngine, policy: UnattendedPolicy): PolicyEngine {
  return new UnattendedExecutionEngine(inner, policy);
}

/**
 * Base-engine rules whose confirmation an explicit permission answers: "this tool needs a human" (tool-level
 * risk or declared policy) and "every workspace edit asks" (file-edit). Listing the tool is the human's answer.
 * Every other confirmation names a specific dangerous action (destructive-shell, git-publish, delete-file)
 * and escalates even for a permitted tool, because a blanket permission does not cover it.
 */
export const PERMISSION_COVERS_RULES: ReadonlySet<string> = new Set(["confirmation", "file-edit"]);

const refuse = (reason: string): PolicyDecision => ({
  allowed: false,
  requireConfirmation: false,
  reason,
  rule: "unattended-policy",
});

function riskIndex(risk: ToolRisk): number {
  return TOOL_RISK_ORDER.indexOf(risk);
}

/** A workspace-relative path that stays inside one of the permitted prefixes. */
function insideWritePaths(path: unknown, prefixes: readonly string[]): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || path.split("/").includes("..")) return false;
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

class UnattendedExecutionEngine implements PolicyEngine {
  constructor(
    private readonly inner: PolicyEngine,
    private readonly policy: UnattendedPolicy,
  ) {}

  check(request: PolicyRequest): PolicyDecision {
    const decision = this.inner.check(request);
    if (request.unattended !== true) return decision;
    // Denials from the base engine always stand; an allow from it is not yet an authorization.
    if (!decision.allowed) return decision;
    return this.judge(request, decision);
  }

  private judge(request: PolicyRequest, base: PolicyDecision): PolicyDecision {
    const { tool } = request;
    const p = this.policy;

    const limits = request.budget?.limits;
    if (limits?.maxToolCalls === undefined || limits.maxModelCalls === undefined || limits.deadlineMs === undefined) {
      return refuse(
        "unattended run has no budget ceilings: maxToolCalls, maxModelCalls and deadlineMs are all required",
      );
    }

    if (!p.permittedTools.includes(tool.id)) {
      return refuse(`tool "${tool.id}" is not permitted for unattended runs (escalation required)`);
    }

    if (tool.sideEffects.financial) {
      return refuse(`tool "${tool.id}" has financial side effects, which are never permitted unattended`);
    }
    if (tool.sideEffects.externalMutation && p.allowExternalMutation !== true) {
      return refuse(
        `tool "${tool.id}" mutates state outside the workspace; not permitted unattended (escalation required)`,
      );
    }
    if (tool.sideEffects.process && tool.execution.isolation !== "sandbox" && p.allowHostProcess !== true) {
      return refuse(`tool "${tool.id}" runs on the host; host process execution is not permitted unattended`);
    }
    if (tool.sideEffects.network && p.allowNetwork !== true) {
      return refuse(`tool "${tool.id}" needs network access, which is not permitted for this unattended run`);
    }

    const ceiling: ToolRisk = p.maxRisk ?? "medium";
    if (riskIndex(tool.risk) > riskIndex(ceiling)) {
      return refuse(
        `tool "${tool.id}" risk "${tool.risk}" exceeds the unattended ceiling "${ceiling}" (escalation required)`,
      );
    }

    if (tool.sideEffects.filesystem && p.writePaths !== undefined) {
      if (!insideWritePaths(request.args.path, p.writePaths)) {
        const target = typeof request.args.path === "string" ? `"${request.args.path}"` : "an unnamed path";
        return refuse(`tool "${tool.id}" would write ${target}, outside the unattended write paths`);
      }
    }

    // The base engine wanted a human. An explicit permission answers the generic cases; a specific dangerous
    // action (destructive shell, publishing, deletion) escalates, because nobody is there to answer.
    if (base.requireConfirmation && !PERMISSION_COVERS_RULES.has(base.rule ?? "")) {
      return refuse(
        `tool "${tool.id}" needs human approval for a specific dangerous action (${base.rule ?? "unknown rule"}); escalation required`,
      );
    }

    return {
      allowed: true,
      requireConfirmation: false,
      reason: `tool "${tool.id}" is permitted for this unattended run`,
      rule: "unattended-policy",
    };
  }
}
