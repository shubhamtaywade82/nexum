/**
 * MAC v1 mission policy — autonomy profiles, budget envelope, narrowing rules
 * (SPEC §9, §12.1) — P5.
 *
 * The policy is the coordinator's constitution: deterministic, config-owned,
 * and impossible for a model-generated decision to widen. Two load-bearing
 * rules:
 *
 *   - fail-closed escalation (SPEC §9 "Who enables"): controlled-autonomous
 *     and research must be explicitly enabled by the deployment; the default
 *     mission runs `supervised`.
 *   - model-sourced amendments may only NARROW (INV-3: "child-count and
 *     replan limits cannot be raised by a model-generated decision").
 *     Human/config amendments may adjust either way, but must stay coherent
 *     (`validateMissionPolicy`).
 *
 * `CommanderAction` is mirrored here from the commander plane (SPEC §4.3,
 * also mirrored by the predictor contracts): the mission plane may not import
 * from `src/agents` (layering rule, P0) and the role planes may not import
 * from `src/orchestration` — the vocabulary is duplicated deliberately and
 * must stay in sync.
 */

import { z } from "zod";
import type { DelegationPolicy } from "../delegation/delegator.js";

// ── Autonomy profiles (SPEC §9) ─────────────────────────────────────────────

export type AutonomyProfile = "supervised" | "controlled-autonomous" | "research";

export const autonomyProfileSchema = z.enum(["supervised", "controlled-autonomous", "research"]);

/** Profiles a deployment may run; the default deployment runs supervised only. */
export const DEFAULT_ENABLED_PROFILES: readonly AutonomyProfile[] = ["supervised"];

// ── Commander action vocabulary (SPEC §4.3, mirrored) ──────────────────────

export const COMMANDER_ACTIONS = [
  "delegate",
  "replan",
  "retry",
  "verify",
  "request_approval",
  "complete",
  "abort",
] as const;

export type CommanderAction = (typeof COMMANDER_ACTIONS)[number];

export const commanderActionSchema = z.enum(COMMANDER_ACTIONS);

// ── Mission budget envelope (SPEC §12.1) ────────────────────────────────────

export interface MissionBudgetEnvelope {
  /** Hard wall clock. Default 30 min supervised / 60 / 120 for the wider profiles. */
  wallClockMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxTokens: number;
  /** ≤ DelegationPolicy.maxTotalChildren (verified default 8). */
  maxChildren: number;
  /** Delegation depth: missions cap at 1 — roles and workers are leaves. */
  maxDepth: number;
  /** Mission-wide replan bound. */
  maxReplans: number;
  /** Consecutive rejected decisions before failed(decision_loop). Default 3. */
  maxDecisionRejections: number;
}

export const missionBudgetEnvelopeSchema = z
  .object({
    wallClockMs: z.number().int().positive(),
    maxModelCalls: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxChildren: z.number().int().positive(),
    maxDepth: z.number().int().min(1).max(1),
    maxReplans: z.number().int().min(0),
    maxDecisionRejections: z.number().int().positive(),
  })
  .strict();

// ── Mission policy (SPEC §9) ────────────────────────────────────────────────

export interface MissionPolicy {
  profile: AutonomyProfile;
  maxReplans: number; // default 2
  maxReplansPerTask: number; // default 1
  maxRetriesPerTask: number; // default 2
  budget: MissionBudgetEnvelope; // §12
  delegationPolicy: DelegationPolicy; // narrowed from defaults
  allowedActions: readonly CommanderAction[];
  approvalTimeoutMs: number; // default 24 h
  maxContextHandoffChars: number; // default 32_768
  requireKitWorkflow: boolean;
  /** SPEC §9: research forces sandbox worktree isolation + a write scope narrowed to it. */
  isolation?: "worktree";
}

export const missionPolicySchema = z
  .object({
    profile: autonomyProfileSchema,
    maxReplans: z.number().int().min(0),
    maxReplansPerTask: z.number().int().min(0),
    maxRetriesPerTask: z.number().int().min(0),
    budget: missionBudgetEnvelopeSchema,
    delegationPolicy: z
      .object({
        allowedChildAgents: z.array(z.string()).optional(),
        maxConcurrentChildren: z.number().int().positive().optional(),
        maxTotalChildren: z.number().int().positive().optional(),
        inheritPolicy: z.boolean().optional(),
        cancelWithParent: z.boolean().optional(),
      })
      .strict(),
    allowedActions: z.array(commanderActionSchema).min(1),
    approvalTimeoutMs: z.number().int().positive(),
    maxContextHandoffChars: z.number().int().positive(),
    requireKitWorkflow: z.boolean(),
    isolation: z.literal("worktree").optional(),
  })
  .strict();

// ── Profile defaults (SPEC §9) ──────────────────────────────────────────────

/** The production pilot profile (P8) — SPEC §9, verbatim defaults. */
export const SUPERVISED_DEFAULTS: MissionPolicy = {
  profile: "supervised",
  maxReplans: 2,
  maxReplansPerTask: 1,
  maxRetriesPerTask: 2,
  budget: {
    wallClockMs: 30 * 60_000,
    maxModelCalls: 400,
    maxToolCalls: 1_500,
    maxTokens: 2_000_000,
    maxChildren: 8,
    maxDepth: 1,
    maxReplans: 2,
    maxDecisionRejections: 3,
  },
  delegationPolicy: {
    maxConcurrentChildren: 2,
    maxTotalChildren: 8,
    inheritPolicy: true,
    cancelWithParent: true,
  },
  allowedActions: [...COMMANDER_ACTIONS],
  approvalTimeoutMs: 24 * 3_600_000,
  maxContextHandoffChars: 32_768,
  requireKitWorkflow: false,
};

/**
 * SPEC §9 pins only the wall-clock defaults per profile (60 min
 * controlled-autonomous, 120 min research) and the research-forced isolation;
 * the remaining envelope dimensions scale proportionally as safe defaults,
 * adjustable per deployment via config overrides.
 */
function scaledDefaults(base: MissionPolicy, factor: number): MissionPolicy {
  return {
    ...base,
    budget: {
      ...base.budget,
      wallClockMs: base.budget.wallClockMs * factor,
      maxModelCalls: base.budget.maxModelCalls * factor,
      maxToolCalls: base.budget.maxToolCalls * factor,
      maxTokens: base.budget.maxTokens * factor,
    },
  };
}

export const CONTROLLED_AUTONOMOUS_DEFAULTS: MissionPolicy = scaledDefaults(SUPERVISED_DEFAULTS, 2);
CONTROLLED_AUTONOMOUS_DEFAULTS.profile = "controlled-autonomous";

export const RESEARCH_DEFAULTS: MissionPolicy = {
  ...scaledDefaults(SUPERVISED_DEFAULTS, 4),
  profile: "research",
  isolation: "worktree",
  // Isolated worktree: one worker at a time, sequential children.
  delegationPolicy: { maxConcurrentChildren: 1, maxTotalChildren: 8, inheritPolicy: true, cancelWithParent: true },
};

export function profileDefaults(profile: AutonomyProfile): MissionPolicy {
  switch (profile) {
    case "controlled-autonomous":
      return { ...CONTROLLED_AUTONOMOUS_DEFAULTS, budget: { ...CONTROLLED_AUTONOMOUS_DEFAULTS.budget } };
    case "research":
      return {
        ...RESEARCH_DEFAULTS,
        budget: { ...RESEARCH_DEFAULTS.budget },
        delegationPolicy: { ...RESEARCH_DEFAULTS.delegationPolicy },
      };
    case "supervised":
    default:
      return {
        ...SUPERVISED_DEFAULTS,
        budget: { ...SUPERVISED_DEFAULTS.budget },
        delegationPolicy: { ...SUPERVISED_DEFAULTS.delegationPolicy },
        allowedActions: [...SUPERVISED_DEFAULTS.allowedActions],
      };
  }
}

// ── Overrides + validation ──────────────────────────────────────────────────

export interface MissionPolicyOverrides {
  maxReplans?: number;
  maxReplansPerTask?: number;
  maxRetriesPerTask?: number;
  budget?: Partial<MissionBudgetEnvelope>;
  delegationPolicy?: Partial<DelegationPolicy>;
  allowedActions?: readonly CommanderAction[];
  approvalTimeoutMs?: number;
  maxContextHandoffChars?: number;
  requireKitWorkflow?: boolean;
  isolation?: "worktree";
}

function applyOverrides(base: MissionPolicy, overrides: MissionPolicyOverrides = {}): MissionPolicy {
  const merged: MissionPolicy = {
    ...base,
    ...(overrides.maxReplans !== undefined ? { maxReplans: overrides.maxReplans } : {}),
    ...(overrides.maxReplansPerTask !== undefined ? { maxReplansPerTask: overrides.maxReplansPerTask } : {}),
    ...(overrides.maxRetriesPerTask !== undefined ? { maxRetriesPerTask: overrides.maxRetriesPerTask } : {}),
    ...(overrides.allowedActions !== undefined ? { allowedActions: [...overrides.allowedActions] } : {}),
    ...(overrides.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: overrides.approvalTimeoutMs } : {}),
    ...(overrides.maxContextHandoffChars !== undefined
      ? { maxContextHandoffChars: overrides.maxContextHandoffChars }
      : {}),
    ...(overrides.requireKitWorkflow !== undefined ? { requireKitWorkflow: overrides.requireKitWorkflow } : {}),
    ...(overrides.isolation !== undefined ? { isolation: overrides.isolation } : {}),
    budget: { ...base.budget, ...(overrides.budget ?? {}) },
    delegationPolicy: { ...base.delegationPolicy, ...(overrides.delegationPolicy ?? {}) },
  };
  return merged;
}

/**
 * Coherence validation (fail-closed). Returns the first violation as a
 * reason string, or null when the policy is coherent.
 */
export function validateMissionPolicy(policy: MissionPolicy): string | null {
  const parsed = missionPolicySchema.safeParse(policy);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `mission policy schema: ${where}${issue?.message ?? "invalid"}`;
  }
  if (policy.budget.maxChildren > (policy.delegationPolicy.maxTotalChildren ?? 8)) {
    return `budget.maxChildren (${policy.budget.maxChildren}) exceeds delegationPolicy.maxTotalChildren (${policy.delegationPolicy.maxTotalChildren ?? 8}) (SPEC §12.1)`;
  }
  if (policy.budget.maxDepth !== 1) {
    return "budget.maxDepth must be 1: roles and workers are leaves (SPEC §12.1)";
  }
  if (policy.maxReplans !== policy.budget.maxReplans) {
    return `maxReplans (${policy.maxReplans}) disagrees with budget.maxReplans (${policy.budget.maxReplans}): one replan bound, stated once`;
  }
  if (policy.isolation === "worktree" && policy.profile !== "research") {
    return "isolation: worktree is forced by the research profile only (SPEC §9)";
  }
  if (policy.profile === "research" && policy.isolation !== "worktree") {
    return "the research profile forces worktree isolation (SPEC §9)";
  }
  return null;
}

// ── Resolution (SPEC §9 "Who enables") ─────────────────────────────────────

export interface MissionPolicyRequest {
  /** Requested profile; default `supervised`. */
  profile?: AutonomyProfile;
  /**
   * Profiles this deployment may run. Default: supervised only — requesting
   * controlled-autonomous or research without enabling it is an escalation
   * attempt and is refused fail-closed.
   */
  enabledProfiles?: readonly AutonomyProfile[];
  /** Human/config-sourced adjustments. */
  overrides?: MissionPolicyOverrides;
}

/**
 * The deployment's enabled autonomy profiles from the environment (SPEC §9
 * "who enables"): `supervised` always; `controlled-autonomous` only behind
 * the explicit `NEXUM_MISSION_AUTONOMY=controlled` opt-in; `research` only
 * behind `NEXUM_MISSION_AUTONOMY=research` AND a declared isolated worktree
 * (the caller passes `researchWorktree` — the workspace declaration is
 * config, not ambient state). The pilot (P8) runs `supervised` by default.
 */
export function resolveEnabledProfiles(opts: {
  env?: { NEXUM_MISSION_AUTONOMY?: string };
  /** The isolated-worktree declaration required for the research profile. */
  researchWorktree?: boolean;
}): readonly AutonomyProfile[] {
  const enabled: AutonomyProfile[] = ["supervised"];
  const requested = opts.env?.NEXUM_MISSION_AUTONOMY;
  if (requested === "controlled") enabled.push("controlled-autonomous");
  if (requested === "research" && opts.researchWorktree === true) enabled.push("research");
  return enabled;
}

export interface MissionPolicyResolution {
  ok: boolean;
  policy?: MissionPolicy;
  /** Refusal reason when ok is false (never silent). */
  reason?: string;
}

export function resolveMissionPolicy(request: MissionPolicyRequest = {}): MissionPolicyResolution {
  const profile = request.profile ?? "supervised";
  const enabled = request.enabledProfiles ?? DEFAULT_ENABLED_PROFILES;
  if (!enabled.includes(profile)) {
    return {
      ok: false,
      reason: `autonomy profile "${profile}" is not enabled for this deployment (enabled: ${enabled.join(", ")}; escalation is config-only, SPEC §9)`,
    };
  }
  const base = profileDefaults(profile);
  const merged = applyOverrides(base, request.overrides);
  const violation = validateMissionPolicy(merged);
  if (violation) {
    return { ok: false, reason: violation };
  }
  return { ok: true, policy: merged };
}

// ── Amendments (INV-3: model-sourced amendments may only narrow) ────────────

export type PolicyAmendmentSource = "config" | "model";

/**
 * Amend a mission policy mid-flight.
 *
 * `config` amendments (human-owned) may adjust any dimension, subject to
 * coherence. `model` amendments — anything originating from a model-generated
 * decision — may only NARROW: raising a numeric cap, widening
 * `allowedActions`, relaxing `delegationPolicy` caps, widening the context
 * handoff, extending the approval timeout, or un-gating the Kit workflow are
 * all refused with a reason (INV-3: child-count and replan limits cannot be
 * raised by a model-generated decision).
 */
export function amendMissionPolicy(
  policy: MissionPolicy,
  overrides: MissionPolicyOverrides,
  source: PolicyAmendmentSource,
): MissionPolicyResolution {
  if (source === "model" && !narrowingOnly(policy, overrides)) {
    return {
      ok: false,
      reason: "model-generated amendment refused: it may only narrow the mission policy, never widen it (INV-3)",
    };
  }
  const merged = applyOverrides(policy, overrides);
  const violation = validateMissionPolicy(merged);
  if (violation) {
    return { ok: false, reason: violation };
  }
  return { ok: true, policy: merged };
}

/** True when every provided override is a narrowing of the current policy. */
function narrowingOnly(policy: MissionPolicy, o: MissionPolicyOverrides): boolean {
  const numericCaps: Array<[number | undefined, number | undefined]> = [
    [o.maxReplans, policy.maxReplans],
    [o.maxReplansPerTask, policy.maxReplansPerTask],
    [o.maxRetriesPerTask, policy.maxRetriesPerTask],
    [o.approvalTimeoutMs, policy.approvalTimeoutMs],
    [o.maxContextHandoffChars, policy.maxContextHandoffChars],
  ];
  for (const [requested, current] of numericCaps) {
    if (requested !== undefined && current !== undefined && requested > current) return false;
  }
  if (o.budget) {
    for (const key of Object.keys(o.budget) as Array<keyof MissionBudgetEnvelope>) {
      const requested = o.budget[key];
      const current = policy.budget[key];
      if (typeof requested === "number" && typeof current === "number" && requested > current) return false;
      // maxDepth may not change at all — it is already the ceiling (1).
      if (key === "maxDepth" && requested !== undefined && requested !== current) return false;
    }
  }
  if (o.delegationPolicy) {
    const dp = o.delegationPolicy;
    const cur = policy.delegationPolicy;
    if (
      dp.maxConcurrentChildren !== undefined &&
      cur.maxConcurrentChildren !== undefined &&
      dp.maxConcurrentChildren > cur.maxConcurrentChildren
    ) {
      return false;
    }
    if (
      dp.maxTotalChildren !== undefined &&
      cur.maxTotalChildren !== undefined &&
      dp.maxTotalChildren > cur.maxTotalChildren
    ) {
      return false;
    }
    // allowedChildAgents may only shrink.
    if (dp.allowedChildAgents && cur.allowedChildAgents) {
      const widening = dp.allowedChildAgents.some((id) => !cur.allowedChildAgents!.includes(id));
      if (widening) return false;
    }
    // Re-enabling inheritance / cancel-with-parent is a widening.
    if (dp.inheritPolicy === true && cur.inheritPolicy === false) return false;
    if (dp.cancelWithParent === false && cur.cancelWithParent === true) return false;
  }
  // Adding worktree isolation is a narrowing; removal cannot be expressed by
  // an amendment (an absent `isolation` override keeps the current value).
  if (o.allowedActions) {
    const widening = o.allowedActions.some((a) => !policy.allowedActions.includes(a));
    if (widening) return false;
  }
  // Un-gating the Kit workflow is a widening.
  if (o.requireKitWorkflow === false && policy.requireKitWorkflow === true) return false;
  return true;
}
