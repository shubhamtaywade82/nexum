/**
 * Commander contracts (SPEC §4.3) — MAC v1 P5.
 *
 * The decision contract lives NEXT TO ITS OWNER (SPEC §16). The mission
 * plane (`src/orchestration/mission/mission-coordinator.ts`) mirrors the
 * shape structurally and re-validates every decision deterministically —
 * the two planes must not import each other
 * (tests/architecture/mission-layering.test.ts), so the vocabulary is
 * declared on both sides and stays assignable, exactly like the tracker's
 * EvidenceRef mirror.
 *
 * The authority boundary is the load-bearing rule (SPEC §4.3): a
 * CommanderDecision is a PROPOSAL. Nothing in this contract can execute
 * anything — no resolved approvals, no spawned work, no child agent
 * selection; the coordinator validates before acting (§11.4).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

// ── Evidence refs (mirrored from the mission plane, SPEC §5.2) ─────────────

export type EvidenceRef =
  | `artifact:${string}` // immutable artifact id
  | `event:${string}` // EventEnvelope id
  | `run:${string}` // recorded run id
  | `checkpoint:${string}`; // mission checkpoint id

export const evidenceRefSchema = z.string().refine((v) => /^(artifact|event|run|checkpoint):.+/.test(v), {
  message: "evidence ref must be artifact:|event:|run:|checkpoint: prefixed",
}) as z.ZodType<EvidenceRef>;

// ── Action vocabulary (SPEC §4.3 — the commander plane owns the enum) ──────

export type CommanderAction = "delegate" | "replan" | "retry" | "verify" | "request_approval" | "complete" | "abort";

export const commanderActionSchema = z.enum([
  "delegate",
  "replan",
  "retry",
  "verify",
  "request_approval",
  "complete",
  "abort",
]);

// ── Delegation proposal (SPEC §4.3, verbatim shape) ────────────────────────

export interface DelegationProposal {
  /** Becomes DelegationRequest.goal — the Delegator picks the worker. */
  goal: string;
  /** Capability tags (P1 adds them to workers). */
  requiredCapabilities: string[];
  input?: string;
  /** Within the remaining mission budget. */
  budgetShare?: number;
  maxToolTurns?: number;
  /** Distilled summaries, evidence refs. */
  contextHandoff?: string[];
}

export const delegationProposalSchema = z
  .object({
    goal: z.string().min(1).max(2_000),
    requiredCapabilities: z.array(z.string().min(1)).min(1),
    input: z.string().max(8_000).optional(),
    budgetShare: z.number().positive().max(1).optional(),
    maxToolTurns: z.number().int().positive().max(200).optional(),
    contextHandoff: z.array(z.string()).optional(),
  })
  .strict();

// ── Approval request (SPEC §4.3; permission classes per docs/ISSUE_AUTOMATION.md) ──

export const approvalRiskClassSchema = z.enum(["REMOTE", "GITHUB", "DESTRUCTIVE", "financial"]);

export type ApprovalRiskClass = z.infer<typeof approvalRiskClassSchema>;

// ── CommanderDecision (SPEC §4.3, verbatim shape) ──────────────────────────

export interface CommanderDecision {
  decisionId: string; // `cd_` + uuid
  missionId: string;
  action: CommanderAction;
  rationale: string;
  taskIds?: string[]; // affected TaskGraph nodes
  delegation?: DelegationProposal; // iff action === "delegate"
  replan?: { reason: string; changedNodes: string[] }; // iff action === "replan"
  retry?: { taskId: string; attempt: number }; // iff action === "retry"
  approvalRequest?: {
    // iff action === "request_approval"
    subject: string;
    riskClass: ApprovalRiskClass;
    description: string;
  };
  basedOnReports: string[]; // tracker/predictor report ids — non-empty
  evidenceRefs: EvidenceRef[];
  schemaVersion: 1;
}

const baseDecisionSchema = z
  .object({
    decisionId: z.string().regex(/^cd_/),
    missionId: z.string().min(1),
    action: commanderActionSchema,
    rationale: z.string().min(1).max(4_000),
    taskIds: z.array(z.string().min(1)).optional(),
    delegation: delegationProposalSchema.optional(),
    replan: z
      .object({
        reason: z.string().min(1).max(2_000),
        changedNodes: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
    retry: z
      .object({
        taskId: z.string().min(1),
        attempt: z.number().int().positive(),
      })
      .strict()
      .optional(),
    approvalRequest: z
      .object({
        subject: z.string().min(1).max(2_000),
        riskClass: approvalRiskClassSchema,
        description: z.string().min(1).max(4_000),
      })
      .strict()
      .optional(),
    basedOnReports: z.array(z.string().min(1)).min(1),
    evidenceRefs: z.array(evidenceRefSchema).min(1),
    schemaVersion: z.literal(1),
  })
  .strict();

/** Strict on write, with the SPEC §4.3 iff-rules enforced at the contract layer. */
export const commanderDecisionSchema = baseDecisionSchema.superRefine((d, ctx) => {
  const forbid = (field: keyof typeof d, why: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: why });
  };
  if (d.action === "delegate" && !d.delegation) {
    forbid("delegation", 'action "delegate" requires a delegation proposal (SPEC §4.3)');
  }
  if (d.action !== "delegate" && d.delegation) {
    forbid("delegation", 'delegation proposal is only allowed when action === "delegate" (SPEC §4.3)');
  }
  if (d.action === "replan" && !d.replan) {
    forbid("replan", 'action "replan" requires a replan record (SPEC §4.3)');
  }
  if (d.action !== "replan" && d.replan) {
    forbid("replan", 'replan record is only allowed when action === "replan" (SPEC §4.3)');
  }
  if (d.action === "retry" && !d.retry) {
    forbid("retry", 'action "retry" requires a retry record (SPEC §4.3)');
  }
  if (d.action !== "retry" && d.retry) {
    forbid("retry", 'retry record is only allowed when action === "retry" (SPEC §4.3)');
  }
  if (d.action === "request_approval" && !d.approvalRequest) {
    forbid("approvalRequest", 'action "request_approval" requires an approval request (SPEC §4.3)');
  }
  if (d.action !== "request_approval" && d.approvalRequest) {
    forbid("approvalRequest", 'approval request is only allowed when action === "request_approval" (SPEC §4.3)');
  }
});

export function newCommanderDecisionId(): string {
  return `cd_${randomUUID()}`;
}

/** Build a decision with the required iff-fields (fail-closed on the iff-rules). */
export function buildCommanderDecision(
  decision: Omit<CommanderDecision, "decisionId" | "schemaVersion"> & { decisionId?: string },
): CommanderDecision {
  const candidate: CommanderDecision = {
    decisionId: decision.decisionId ?? newCommanderDecisionId(),
    schemaVersion: 1,
    ...decision,
  };
  const parsed = commanderDecisionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`invalid commander decision: ${parsed.error.issues[0]?.message ?? "schema violation"}`);
  }
  return candidate;
}
