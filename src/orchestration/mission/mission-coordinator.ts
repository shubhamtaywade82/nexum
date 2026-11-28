/**
 * MAC v1 MissionCoordinator — decision re-validation (SPEC §11.4) — P5.
 *
 * The coordinator is deterministic: no LLM calls inside it (SPEC §11.1) —
 * all model work happens inside the role agents it delegates to. This
 * module is the authorization step every commander proposal passes through
 * BEFORE anything executes:
 *
 *   1. schema          strict decision shape + SPEC §4.3 iff-rules
 *   2. profile         `action` within the mission's autonomy profile
 *   3. dag             `validatePlanDag` on the live plan; invalid graphs are
 *                      rejected VERBATIM — never auto-repaired (INV-5)
 *   4. budget          delegation budget share + child caps; retry/replan
 *                      attempt budgets (INV-1/INV-2 mechanics, from P5.1)
 *   5. approval        approval-class actions route to ApprovalManager only;
 *                      the decision layer can never resolve an approval
 *                      (INV-5: no self-authorized execution)
 *   6. evidence        `complete` requires deterministic verification
 *                      verdicts — a commander's claim is never enough
 *                      (INV-6)
 *
 * The CommanderDecision shape is mirrored structurally from
 * `src/agents/commander/contracts.ts` (the layering rule forbids importing
 * the agents plane from the mission plane; the commander plane mirrors it
 * back the same way). A dedicated test keeps the mirrors in sync.
 *
 * Rejections carry `{decisionId, reason, gate}` — exactly the P2
 * `decisionRejection` event payload, so the coordinator emits them
 * without translation. `Delegator.review()` is called before every
 * `delegate()` at execution time; its refusal reason becomes the
 * DecisionRejection reason (wired with the coordinator loop in PR 5.3).
 */

import { z } from "zod";
import { validatePlanDag } from "../dag-validator.js";
import type { PlanStep } from "../../core/plan/plan-contracts.js";
import type { DelegationRequest } from "../delegation/delegator.js";
import type { CommanderAction, MissionPolicy } from "./mission-policy.js";
import { evidenceRefSchema } from "./events.js";

// ── Mirrored decision contract (structural twin of agents/commander) ────────

const mirroredDecisionSchema = z
  .object({
    decisionId: z.string().regex(/^cd_/),
    missionId: z.string().min(1),
    action: z.enum(["delegate", "replan", "retry", "verify", "request_approval", "complete", "abort"]),
    rationale: z.string().min(1).max(4_000),
    taskIds: z.array(z.string().min(1)).optional(),
    delegation: z
      .object({
        goal: z.string().min(1).max(2_000),
        requiredCapabilities: z.array(z.string().min(1)).min(1),
        input: z.string().max(8_000).optional(),
        budgetShare: z.number().positive().max(1).optional(),
        maxToolTurns: z.number().int().positive().max(200).optional(),
        contextHandoff: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    replan: z
      .object({ reason: z.string().min(1).max(2_000), changedNodes: z.array(z.string().min(1)) })
      .strict()
      .optional(),
    retry: z
      .object({ taskId: z.string().min(1), attempt: z.number().int().positive() })
      .strict()
      .optional(),
    approvalRequest: z
      .object({
        subject: z.string().min(1).max(2_000),
        riskClass: z.enum(["REMOTE", "GITHUB", "DESTRUCTIVE", "financial"]),
        description: z.string().min(1).max(4_000),
      })
      .strict()
      .optional(),
    basedOnReports: z.array(z.string().min(1)).min(1),
    evidenceRefs: z.array(evidenceRefSchema).min(1),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((d, ctx) => {
    const iff = (condition: boolean, field: string, why: string) => {
      if (condition) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: why });
    };
    iff(d.action === "delegate" && !d.delegation, "delegation", 'action "delegate" requires a delegation proposal');
    iff(d.action !== "delegate" && !!d.delegation, "delegation", 'delegation only when action === "delegate"');
    iff(d.action === "replan" && !d.replan, "replan", 'action "replan" requires a replan record');
    iff(d.action !== "replan" && !!d.replan, "replan", 'replan record only when action === "replan"');
    iff(d.action === "retry" && !d.retry, "retry", 'action "retry" requires a retry record');
    iff(d.action !== "retry" && !!d.retry, "retry", 'retry record only when action === "retry"');
    iff(
      d.action === "request_approval" && !d.approvalRequest,
      "approvalRequest",
      'action "request_approval" requires an approval request',
    );
    iff(
      d.action !== "request_approval" && !!d.approvalRequest,
      "approvalRequest",
      'approval request only when action === "request_approval"',
    );
  });

/** Structural twin of the commander plane's CommanderDecision (kept in sync by test). */
export interface DecisionCandidate {
  decisionId: string;
  missionId: string;
  action: string;
  rationale: string;
  taskIds?: string[];
  delegation?: {
    goal: string;
    requiredCapabilities: string[];
    input?: string;
    budgetShare?: number;
    maxToolTurns?: number;
    contextHandoff?: string[];
  };
  replan?: { reason: string; changedNodes: string[] };
  retry?: { taskId: string; attempt: number };
  approvalRequest?: { subject: string; riskClass: string; description: string };
  basedOnReports: string[];
  evidenceRefs: string[];
  schemaVersion: number;
}

// ── Validation context + result ─────────────────────────────────────────────

/** Deterministic verification verdicts observed so far (P2 mission.verification payloads). */
export interface VerificationVerdictSummary {
  gate: string;
  passed: boolean;
}

/** Everything reValidateDecision needs — all deterministic, no model in the loop. */
export interface DecisionValidationContext {
  policy: MissionPolicy;
  /** The live plan (TaskGraph as PlanSteps); validated with validatePlanDag. */
  planSteps: PlanStep[];
  /** Gate verdicts collected so far (source of completion evidence, INV-6). */
  verificationVerdicts: VerificationVerdictSummary[];
  /** Replans consumed mission-wide so far. */
  replansUsed: number;
  /** Replans consumed per task node so far. */
  replansUsedByTask: Record<string, number>;
  /** Retry attempts consumed per task node so far. */
  retriesByTask: Record<string, number>;
  /** Children currently in flight (DelegationPolicy concurrency check). */
  childrenInFlight: number;
  /** Total children started so far (envelope maxChildren check). */
  childrenStarted: number;
  /** Kit journal verification observed (required for completion when bound). */
  kitJournalVerified: boolean;
}

export type RevalidationGate = "policy" | "budget" | "dag" | "profile" | "schema";

export interface DecisionValidationResult {
  ok: boolean;
  /** Which gate produced the verdict (the P2 decisionRejection.gate vocabulary). */
  gate: RevalidationGate;
  /** Never silent: the refusal reason, or the acceptance note. */
  reason: string;
  /** The rejected decision's id, so rejections are attributable (P2 payload shape). */
  decisionId?: string;
  /**
   * Present iff ok && action === "delegate": the DelegationRequest the
   * COORDINATOR constructed from the proposal — allowlisted fields only,
   * never trusted wholesale from the model (SPEC §11.4 point 3). The
   * Delegator picks the worker; childAgentId is never taken from a decision.
   */
  delegationRequest?: DelegationRequest;
  /**
   * Present iff ok && action === "request_approval": the routing directive.
   * ResolvedBy is always "human" — the decision layer has no code path that
   * resolves an approval (INV-5: no self-authorized execution).
   */
  approvalRouting?: { subject: string; riskClass: string; description: string; resolvedBy: "human" };
}

const REJECTED = (gate: RevalidationGate, decisionId: string, reason: string): DecisionValidationResult => ({
  ok: false,
  gate,
  reason,
  decisionId,
});

// ── reValidateDecision (SPEC §11.4) ─────────────────────────────────────────

/**
 * Pure decision re-validation — the authorization step. Unit-tested without
 * models; rejects fail-closed with a reason and a gate.
 */
export function reValidateDecision(
  decision: DecisionCandidate,
  context: DecisionValidationContext,
): DecisionValidationResult {
  const { policy } = context;

  // 1. Schema: strict shape + SPEC §4.3 iff-rules (gate "schema").
  const schema = mirroredDecisionSchema.safeParse(decision);
  if (!schema.success) {
    const issue = schema.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return REJECTED(
      "schema",
      String(decision?.decisionId ?? ""),
      `decision schema: ${where}${issue?.message ?? "invalid"}`,
    );
  }
  const d = schema.data;
  const decisionId = d.decisionId;

  // 2. Profile membership (gate "profile") — INV-4's first tooth.
  if (!policy.allowedActions.includes(d.action as CommanderAction)) {
    return REJECTED(
      "profile",
      decisionId,
      `action "${d.action}" is not in the mission's allowedActions (profile "${policy.profile}", SPEC §9)`,
    );
  }

  // 3. Plan/DAG validity (gate "dag") — rejection is final for this proposal,
  //    never auto-repaired (INV-5). The validator's errors surface verbatim.
  const dag = validatePlanDag(context.planSteps);
  if (!dag.valid) {
    return REJECTED("dag", decisionId, `plan DAG invalid: ${dag.errors.join("; ")}`);
  }
  const knownStepIds = new Set(context.planSteps.map((s) => s.id));
  const referenced = [...(d.taskIds ?? []), ...(d.replan?.changedNodes ?? []), ...(d.retry ? [d.retry.taskId] : [])];
  const dangling = referenced.filter((id) => !knownStepIds.has(id));
  if (dangling.length > 0) {
    return REJECTED("dag", decisionId, `decision references unknown task nodes: ${dangling.join(", ")}`);
  }

  // 4. Per-action checks.
  switch (d.action) {
    case "delegate": {
      const proposal = d.delegation!;
      if (proposal.budgetShare !== undefined && proposal.budgetShare > 1) {
        return REJECTED(
          "budget",
          decisionId,
          `budgetShare ${proposal.budgetShare} exceeds the remaining envelope (SPEC §11.4 point 3)`,
        );
      }
      if (context.childrenInFlight + 1 > (policy.delegationPolicy.maxConcurrentChildren ?? 2)) {
        return REJECTED(
          "budget",
          decisionId,
          `delegation would exceed maxConcurrentChildren (${context.childrenInFlight}/${policy.delegationPolicy.maxConcurrentChildren ?? 2} in flight)`,
        );
      }
      if (context.childrenStarted + 1 > policy.budget.maxChildren) {
        return REJECTED(
          "budget",
          decisionId,
          `delegation would exceed budget.maxChildren (${context.childrenStarted}/${policy.budget.maxChildren})`,
        );
      }
      // The coordinator constructs the actual request from the proposal —
      // allowlisted fields only; the Delegator picks the worker (never the
      // model). childAgentId and metadata are not taken from decisions.
      const delegationRequest: DelegationRequest = {
        goal: proposal.goal,
        requiredCapabilities: [...proposal.requiredCapabilities],
        ...(proposal.input !== undefined ? { input: proposal.input } : {}),
        ...(proposal.budgetShare !== undefined ? { budgetShare: proposal.budgetShare } : {}),
        ...(proposal.maxToolTurns !== undefined ? { maxToolTurns: proposal.maxToolTurns } : {}),
        ...(proposal.contextHandoff !== undefined ? { contextHandoff: [...proposal.contextHandoff] } : {}),
      };
      return { ok: true, gate: "policy", reason: "delegate: validated", decisionId, delegationRequest };
    }

    case "replan": {
      const replan = d.replan!;
      if (context.replansUsed + 1 > policy.budget.maxReplans) {
        return REJECTED(
          "budget",
          decisionId,
          `mission replan budget exhausted (${context.replansUsed}/${policy.budget.maxReplans})`,
        );
      }
      for (const node of replan.changedNodes) {
        const used = context.replansUsedByTask[node] ?? 0;
        if (used + 1 > policy.maxReplansPerTask) {
          return REJECTED(
            "budget",
            decisionId,
            `task "${node}" replan budget exhausted (${used}/${policy.maxReplansPerTask})`,
          );
        }
      }
      return { ok: true, gate: "policy", reason: "replan: validated, bounded", decisionId };
    }

    case "retry": {
      const retry = d.retry!;
      const used = context.retriesByTask[retry.taskId] ?? 0;
      if (retry.attempt > policy.maxRetriesPerTask) {
        return REJECTED(
          "budget",
          decisionId,
          `retry attempt ${retry.attempt} exceeds maxRetriesPerTask (${policy.maxRetriesPerTask}) for "${retry.taskId}"`,
        );
      }
      if (used + 1 > policy.maxRetriesPerTask) {
        return REJECTED(
          "budget",
          decisionId,
          `task "${retry.taskId}" retry budget exhausted (${used}/${policy.maxRetriesPerTask})`,
        );
      }
      return { ok: true, gate: "policy", reason: "retry: validated, bounded", decisionId };
    }

    case "complete": {
      // 6. Completion evidence (INV-6): deterministic gate verdicts only —
      //    a commander's claim is never evidence.
      if (context.verificationVerdicts.length === 0) {
        return REJECTED(
          "policy",
          decisionId,
          "complete refused: no deterministic verification evidence attached (INV-6)",
        );
      }
      const failedGates = context.verificationVerdicts.filter((v) => !v.passed);
      if (failedGates.length > 0) {
        return REJECTED(
          "policy",
          decisionId,
          `complete refused: verification gates not passed (${failedGates.map((g) => g.gate).join(", ")})`,
        );
      }
      if (policy.requireKitWorkflow && !context.kitJournalVerified) {
        return REJECTED(
          "policy",
          decisionId,
          "complete refused: Kit-bound mission requires journal-verify evidence (SPEC §10)",
        );
      }
      return { ok: true, gate: "policy", reason: "complete: verification evidence attached", decisionId };
    }

    case "request_approval": {
      // 5. Approval-class routing (INV-5): ApprovalManager owns resolution.
      //    There is no path by which this layer resolves an approval.
      const request = d.approvalRequest!;
      return {
        ok: true,
        gate: "policy",
        reason: "approval requested: routed to ApprovalManager (human resolution only)",
        decisionId,
        approvalRouting: { ...request, resolvedBy: "human" },
      };
    }

    case "verify":
      return { ok: true, gate: "policy", reason: "verify: gates requested", decisionId };

    case "abort":
      return { ok: true, gate: "policy", reason: "abort: validated, terminating with rationale", decisionId };

    default:
      return REJECTED("schema", decisionId, `unknown action "${String(d.action)}"`);
  }
}
