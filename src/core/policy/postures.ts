/**
 * Policy postures — named RulePolicyEngine presets for products.
 *
 * A posture answers "how much friction does this product want around tool
 * execution?". The gateway enforces whatever engine it is given; postures
 * are just ready-made engines so products don't hand-roll rule chains:
 *
 *   parity     — the CLI DevAgent's historical UX: only destructive shell,
 *                git push / PR creation, and file deletion ask; everything
 *                else flows. Financial side effects ALWAYS ask (review
 *                mandate: a tool that moves money can never bypass
 *                confirmation, even in parity mode). The paper-trade tool's
 *                confirmation is the one deliberate UX delta vs. the
 *                pre-kernel CLI.
 *   standard   — every tool at risk >= "high" asks (shell, git, github,
 *                docker-style surfaces). For products that want a visibly
 *                safer default than parity.
 *   restricted — risk >= "medium" asks, plus optional deny lists/ceilings.
 *                For unattended runners and the crypto agent.
 *
 * All postures keep ModeRestrictionRule (read-only agent modes deny
 * mutating tools) via RulePolicyEngine's built-in rule tail.
 */

import { PolicyRule, RulePolicyEngine } from "./policy-engine.js";
import { ExecutionProfile, executionProfileByName } from "./execution-profiles.js";
import { DeleteFileRule, DestructiveShellRule, FileEditRule, GitPublishRule } from "./rules.js";
import { ToolRisk } from "../tools/tool-contract.js";

export type PolicyPostureName = "parity" | "standard" | "restricted";

export interface RestrictedPostureOptions {
  /** Risk floor that triggers confirmation (default "medium"). */
  requireConfirmationFor?: ToolRisk;
  /** Tools that may not run at all. */
  deniedToolIds?: readonly string[];
  /** Ceiling beyond which tools are outright denied. */
  denyRiskAbove?: ToolRisk;
  /** Extra product rules, evaluated before the built-in tail. */
  extraRules?: PolicyRule[];
}

/**
 * Parity's arg rules let benign faces (e.g. `ls`, `git status`) bypass the
 * risk ladder entirely. Stricter postures keep the confirm-side of those
 * rules but let benign faces fall through to the ladder, so "standard" and
 * "restricted" genuinely ask for every high/medium-risk call.
 */
function argRules(allowBenignFaces: boolean): PolicyRule[] {
  return [
    new DestructiveShellRule(allowBenignFaces),
    new GitPublishRule(allowBenignFaces),
    new DeleteFileRule(),
    new FileEditRule(),
  ];
}

/** Historical CLI DevAgent UX: minimal prompts, financial never bypasses. */
export function parityPosture(): RulePolicyEngine {
  return new RulePolicyEngine({
    rules: argRules(true),
    requireConfirmationFor: "critical",
  });
}

/** Visible-safety default: every high-risk tool call asks first. */
export function standardPosture(): RulePolicyEngine {
  return new RulePolicyEngine({
    rules: argRules(false),
    requireConfirmationFor: "high",
  });
}

/** Unattended-runner posture: medium floor plus optional deny configuration. */
export function restrictedPosture(opts: RestrictedPostureOptions = {}): RulePolicyEngine {
  return new RulePolicyEngine({
    rules: [...(opts.extraRules ?? []), ...argRules(false)],
    requireConfirmationFor: opts.requireConfirmationFor ?? "medium",
    deniedToolIds: opts.deniedToolIds,
    denyRiskAbove: opts.denyRiskAbove,
  });
}

export function postureByName(name: PolicyPostureName, opts: RestrictedPostureOptions = {}): RulePolicyEngine {
  switch (name) {
    case "parity":
      return parityPosture();
    case "standard":
      return standardPosture();
    case "restricted":
      return restrictedPosture(opts);
  }
}

// ── Profile-based posture (review item 8) ───────────────────────────────────

/**
 * Build a policy engine from an execution profile (review item 8): the
 * profile's permissions, risk ceiling, confirmation floor, external
 * mutation and financial flags become the engine's baseline rules —
 * command blacklists replaced by declarative permissions.
 */
export function profilePosture(profileNameOrProfile: string | ExecutionProfile): RulePolicyEngine {
  const profile =
    typeof profileNameOrProfile === "string" ? executionProfileByName(profileNameOrProfile) : profileNameOrProfile;
  return new RulePolicyEngine({
    profile,
    deniedToolIds: profile.deniedTools,
    requireConfirmationFor: profile.confirmationFloor,
  });
}
