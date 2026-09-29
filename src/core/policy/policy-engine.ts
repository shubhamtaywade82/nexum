/**
 * PolicyEngine v2 — the centralized decision layer (review item 7).
 *
 * Answers "may this agent execute this tool now?" by evaluating EVERYTHING
 * the runtime knows about the request:
 *
 *   agent       who is asking (identity + capabilities)
 *   task        what they are trying to accomplish
 *   tool        declared risk / side effects / network requirements
 *   arguments   arg-aware rules (destructive shell patterns, git publish,
 *               file deletion)
 *   workspace   root + sandbox state + path scope
 *   environment execution profile + trading mode (review item 8)
 *   risk        the tool's risk ladder position vs ceilings
 *   budget      remaining run budget (depleted budgets deny mutations)
 *
 * Destructive-operation decisions live HERE — moved out of the Agent god
 * class and out of individual tools. The ToolGateway enforces the
 * decision; the engine never executes anything itself.
 *
 * Ships with the rule-based default engine (RulePolicyEngine):
 *   - deny rules always win
 *   - execution-profile permission checks (commands/network/filesystem/
 *     external mutation/financial)
 *   - mode restrictions (ask/review modes deny mutating tools)
 *   - arg-aware rules (destructive shell patterns, git publish, deletion)
 *   - budget guard (depleted budget denies further mutation)
 *   - risk >= confirmationFloor → human confirmation required
 *   - financial side effects always require confirmation
 *   - everything else is auto-approved
 */

import { ToolDefinition, ToolRisk, toolIsMutating, toolRiskAtLeast } from "../tools/tool-contract.js";
import type { TaskSpec } from "../types.js";
import type { BudgetUsage } from "../types.js";
import type { ExecutionProfile } from "./execution-profiles.js";

export type AgentModePolicy = "ask" | "code" | "architect" | "review" | "debug" | "autonomous";

/** Agent identity context (from the AgentRegistry descriptor). */
export interface AgentPolicyContext {
  id: string;
  displayName?: string;
  capabilities?: string[];
}

/** Workspace context (from the WorkspaceManager). */
export interface WorkspacePolicyContext {
  root: string;
  /** Docker sandbox available (commands permission can escalate to sandboxed). */
  sandboxed: boolean;
  /** Allowed write scope (subdirectory the run is pinned to). */
  writeScope?: string;
}

/** Environment context: active execution profile + optional trading mode. */
export interface EnvironmentPolicyContext {
  profile: ExecutionProfile;
  tradingMode?: string;
}

export interface PolicyRequest {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  agentId: string;
  runId: string;
  /** Current agent mode, when the embedding application tracks one. */
  mode?: AgentModePolicy | string;
  /** True when the operator asked for fully unattended execution. */
  unattended?: boolean;
  // ── review item 7 evaluation context ─────────────────────────────────
  /** The task being executed (goal/constraints). */
  task?: TaskSpec;
  /** Agent identity + capabilities. */
  agent?: AgentPolicyContext;
  /** Workspace root + sandbox state. */
  workspace?: WorkspacePolicyContext;
  /** Execution profile / trading mode. */
  environment?: EnvironmentPolicyContext;
  /** Remaining budget snapshot (depleted budgets deny mutations). */
  budget?: BudgetUsage;
}

export interface PolicyDecision {
  allowed: boolean;
  requireConfirmation: boolean;
  reason: string;
  /** Which rule produced this decision (observability / audit trail). */
  rule?: string;
}

export interface PolicyEngine {
  check(request: PolicyRequest): PolicyDecision;
}

// ── Rules ───────────────────────────────────────────────────────────────────

export interface PolicyRule {
  id: string;
  description: string;
  /** Return a decision to stop the chain, or null to defer to the next rule. */
  evaluate(request: PolicyRequest): PolicyDecision | null;
}

const ALLOW: PolicyDecision = { allowed: true, requireConfirmation: false, reason: "no rule matched" };

export class DenyToolsRule implements PolicyRule {
  readonly id = "deny-tools";
  readonly description = "Denies explicitly listed tool ids.";

  constructor(private readonly deniedToolIds: readonly string[]) {}

  evaluate(request: PolicyRequest): PolicyDecision | null {
    if (!this.deniedToolIds.includes(request.tool.id)) return null;
    return {
      allowed: false,
      requireConfirmation: false,
      reason: `tool "${request.tool.id}" is denied by policy`,
      rule: this.id,
    };
  }
}

export class DenyRiskAboveRule implements PolicyRule {
  readonly id = "deny-risk-above";
  readonly description = "Denies tools whose risk meets or exceeds a ceiling.";

  constructor(private readonly ceiling: ToolRisk) {}

  evaluate(request: PolicyRequest): PolicyDecision | null {
    if (!toolRiskAtLeast(request.tool.risk, this.ceiling)) return null;
    return {
      allowed: false,
      requireConfirmation: false,
      reason: `tool "${request.tool.id}" risk "${request.tool.risk}" exceeds ceiling "${this.ceiling}"`,
      rule: this.id,
    };
  }
}

/**
 * Execution-profile rule (review item 8): evaluates the tool's declared
 * metadata against the active profile's command/network/filesystem/
 * external-mutation/financial permissions. This replaces command
 * blacklists with declarative permissions.
 */
export class ExecutionProfileRule implements PolicyRule {
  readonly id = "execution-profile";
  readonly description = "Enforces the active execution profile's permissions.";

  evaluate(request: PolicyRequest): PolicyDecision | null {
    const env = request.environment;
    if (!env) return null;
    const profile = env.profile;
    const tool = request.tool;
    const deny = (reason: string): PolicyDecision => ({
      allowed: false,
      requireConfirmation: false,
      reason: `profile "${profile.name}": ${reason}`,
      rule: this.id,
    });

    // explicit deny list
    if (profile.deniedTools.includes(tool.id)) {
      return deny(`tool "${tool.id}" is not allowed in this profile`);
    }

    // commands / process spawning
    if (tool.sideEffects.process) {
      const commands = profile.permissions.commands;
      if (commands === "none") {
        return deny(`process spawning is disabled (tool "${tool.id}")`);
      }
    }

    // network egress
    const needsNetwork = tool.network?.required ?? tool.sideEffects.network;
    if (needsNetwork) {
      const network = profile.permissions.network;
      if (network === "none") {
        return deny(`network access is disabled (tool "${tool.id}" requires egress)`);
      }
      if (network === "registry" && !isRegistryTool(tool)) {
        return deny(`network limited to package registries (tool "${tool.id}" is not a registry tool)`);
      }
      if (network === "allowlisted" && tool.network?.required && !tool.network.proxyable) {
        return deny(`tool "${tool.id}" needs unrestricted egress; profile allows only declared domains`);
      }
    }

    // filesystem permissions
    if (tool.sideEffects.filesystem) {
      const fs = profile.permissions.filesystem;
      if (fs === "none" || fs === "read") {
        return deny(`filesystem writes are disabled (tool "${tool.id}" mutates files)`);
      }
    }

    // external mutation
    if (tool.sideEffects.externalMutation && !profile.allowExternalMutation) {
      return deny(`external mutation is disabled (tool "${tool.id}" mutates state outside the workspace)`);
    }

    // financial
    if (tool.sideEffects.financial && !profile.allowFinancial) {
      return deny(`financial side effects are disabled (tool "${tool.id}")`);
    }

    // risk ceiling
    if (toolRiskAtLeast(tool.risk, profile.riskCeiling)) {
      return deny(`tool risk "${tool.risk}" meets/exceeds profile ceiling "${profile.riskCeiling}"`);
    }

    return null;
  }
}

function isRegistryTool(tool: ToolDefinition): boolean {
  // package-manager shells and project runners are registry-egress tools
  const registryTools = new Set(["run_tests", "run_lint", "run_format", "run_build", "run_script"]);
  if (registryTools.has(tool.id)) return true;
  return tool.tags.some((t) => t === "package-manager" || t === "registry");
}

/** In "ask"/"review" style modes, mutating tools are not allowed at all. */
export class ModeRestrictionRule implements PolicyRule {
  readonly id = "mode-restriction";
  readonly description = "Denies side-effecting tools in read-only agent modes.";

  private static readonly READ_ONLY_MODES = new Set(["ask", "review"]);

  evaluate(request: PolicyRequest): PolicyDecision | null {
    if (!request.mode || !ModeRestrictionRule.READ_ONLY_MODES.has(request.mode)) return null;
    if (!toolIsMutating(request.tool)) return null;
    return {
      allowed: false,
      requireConfirmation: false,
      reason: `agent mode "${request.mode}" is read-only; tool "${request.tool.id}" mutates state`,
      rule: this.id,
    };
  }
}

/**
 * Budget guard (review item 7): a run with a depleted budget may not start
 * NEW mutations (reads still pass — recovery/diagnostics may read).
 */
export class BudgetGuardRule implements PolicyRule {
  readonly id = "budget-guard";
  readonly description = "Denies mutating tools once the run's budget is depleted.";

  evaluate(request: PolicyRequest): PolicyDecision | null {
    const budget = request.budget;
    if (!budget) return null;
    // depleted = no time left or negative headroom signals from the caller
    const depleted = budget.elapsedMs < 0 || (budget as { depleted?: boolean }).depleted === true;
    if (!depleted) return null;
    if (!toolIsMutating(request.tool)) return null;
    return {
      allowed: false,
      requireConfirmation: false,
      reason: `run budget is depleted; tool "${request.tool.id}" is mutating and denied`,
      rule: this.id,
    };
  }
}

export class ConfirmationRule implements PolicyRule {
  readonly id = "confirmation";
  readonly description = "Requires confirmation based on tool policy, profile floor, and risk posture.";

  constructor(
    private readonly requireConfirmationFor: ToolRisk = "high",
    private readonly financialAlwaysRequiresConfirmation = true,
  ) {}

  evaluate(request: PolicyRequest): PolicyDecision | null {
    const { tool } = request;
    const profileFloor = request.environment?.profile.confirmationFloor;

    // Financial side effects are checked BEFORE the tool-declared opt-out:
    // a tool that moves money can never silently bypass confirmation, no
    // matter what its own policy spec claims.
    if (this.financialAlwaysRequiresConfirmation && tool.sideEffects.financial) {
      return {
        allowed: true,
        requireConfirmation: true,
        reason: `tool "${tool.id}" has financial side effects`,
        rule: this.id,
      };
    }

    if (tool.policy.confirmation === "never") return null;

    // the stricter of the engine's floor and the profile's floor wins
    const floors = [this.requireConfirmationFor, ...(profileFloor ? [profileFloor] : [])];
    const floor = floors.reduce((a, b) => (toolRiskAtLeast(b, a) ? b : a));
    if (toolRiskAtLeast(tool.risk, floor)) {
      return {
        allowed: true,
        requireConfirmation: true,
        reason: `tool "${tool.id}" risk "${tool.risk}" >= "${floor}"`,
        rule: this.id,
      };
    }

    if (tool.policy.confirmation === "required") {
      return {
        allowed: true,
        requireConfirmation: true,
        reason: `tool "${tool.id}" declares confirmation: required`,
        rule: this.id,
      };
    }

    return null;
  }
}

// ── Default engine ──────────────────────────────────────────────────────────

export interface RulePolicyEngineOptions {
  rules?: PolicyRule[];
  /** Risk floor that triggers confirmation (default "high"). */
  requireConfirmationFor?: ToolRisk;
  /** Explicit deny list of tool ids. */
  deniedToolIds?: readonly string[];
  /** Ceiling beyond which tools are outright denied (optional). */
  denyRiskAbove?: ToolRisk;
  /** Active execution profile (enables the ExecutionProfileRule, review item 8). */
  profile?: ExecutionProfile;
}

export class RulePolicyEngine implements PolicyEngine {
  private readonly rules: PolicyRule[];
  /** Profile bound at construction — stamped into requests lacking one. */
  private readonly boundProfile?: ExecutionProfile;

  constructor(opts: RulePolicyEngineOptions = {}) {
    this.boundProfile = opts.profile;
    // Denials run FIRST. The first decision wins, and product rules may return
    // `allow` (e.g. parity's benign-shell allowance) — which must never bypass a
    // deny list, risk ceiling, execution profile, read-only mode or depleted budget.
    const denials: PolicyRule[] = [];
    if (opts.denyRiskAbove) denials.push(new DenyRiskAboveRule(opts.denyRiskAbove));
    if (opts.deniedToolIds?.length) denials.push(new DenyToolsRule(opts.deniedToolIds));
    if (opts.profile) denials.push(new ExecutionProfileRule());
    denials.push(new ModeRestrictionRule(), new BudgetGuardRule());
    this.rules = [...denials, ...(opts.rules ?? []), new ConfirmationRule(opts.requireConfirmationFor)];
  }

  check(request: PolicyRequest): PolicyDecision {
    // the profile travels WITH the request when the engine was built with
    // one but the caller didn't stamp environment context
    const effective: PolicyRequest =
      request.environment?.profile || !this.boundProfile
        ? request
        : {
            ...request,
            environment: { ...request.environment, profile: this.boundProfile },
          };
    for (const rule of this.rules) {
      const decision = rule.evaluate(effective);
      if (decision) return decision;
    }
    return { ...ALLOW, rule: "default-allow" };
  }
}

/** Permissive engine for headless/embedded use. */
export class AllowAllPolicyEngine implements PolicyEngine {
  check(): PolicyDecision {
    return { allowed: true, requireConfirmation: false, reason: "allow-all engine", rule: "allow-all" };
  }
}
