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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { validatePlanDag } from "../dag-validator.js";
import type { PlanStep } from "../../core/plan/plan-contracts.js";
import type { DelegationRequest } from "../delegation/delegator.js";
import type { CommanderAction, MissionPolicy } from "./mission-policy.js";
import {
  evidenceRefSchema,
  isMissionEvent,
  validateMissionEvent,
  type EvidenceRef,
  type MissionEvent,
  type TrackerReportRef,
  type PredictionReportRef,
} from "./events.js";
import { assessComplexity } from "../complexity.js";
import { newDelegationId } from "../../core/identity.js";
import {
  buildReportArtifact,
  ReportArtifactStore,
  type ReportArtifact,
  type ReportArtifactKind,
} from "./report-artifacts.js";
import { MissionBudgetLedger, MissionLoopGuard } from "./mission-budget.js";
import { MissionLifecycle, type MissionCheckpoint, type MissionLifecycleState } from "./mission-lifecycle.js";
import { KIT_JOURNAL_GATE, KitMissionVerification, type KitPort } from "./verification.js";
import { createMissionState } from "../../runtime/mission-derive.js";
import type { MissionPhaseId, MissionState } from "../../runtime/types.js";
import { findWorkspaceRoot, workspaceStateDir } from "../../platform/paths.js";

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

// ═══════════════════════════════════════════════════════════════════════════
// The coordination loop (SPEC §11.1–11.2) — PR 5.3
//
// Deterministic: no LLM calls inside the coordinator (§11.1) — every model
// turn happens inside the injected role agents / worker port. The loop is
// bounded three ways: the ledger envelope (preflight before every dispatch),
// the decision/rejection budgets, and a hard turn bound. A role crash never
// fails the mission silently: it suspends at a checkpoint, resumable.
// ═══════════════════════════════════════════════════════════════════════════

// ── Mission intent + outcome (SPEC §11.1) ────────────────────────────────────

export interface MissionIntent {
  /** `ms_` + uuid (generated when omitted). */
  missionId?: string;
  /** Verbatim user objective. */
  goal: string;
  successCriteria: string[];
  constraints: string[];
  autonomy?: string;
  kitBinding?: { kind: "feature" | "fix"; id: string };
  submittedBy: "user" | "ci" | "webhook" | "schedule";
  /** Pilot class label (P8): bug-investigation | test-flake-diagnosis | bounded-refactor. */
  pilotClass?: string;
}

export interface MissionOutcome {
  missionId: string;
  /** Terminal state, or null when the mission is suspended mid-flight (resumable). */
  outcome: "completed" | "failed" | "aborted" | "cancelled" | null;
  summary: string;
  state: MissionLifecycleState;
  /** True when a crash suspended the mission at a checkpoint. */
  resumable: boolean;
  checkpoint: MissionCheckpoint;
}

// ── Injected ports (production wiring is the P8 pilot; tests script them) ──

/** The trio. Production: delegated role runs; tests: scripted fakes. */
export interface MissionRoleAgents {
  observe(input: { missionId: string; goal: string }): Promise<{
    report: TrackerReportRef;
    artifactPayload: unknown;
  }>;
  assess(input: { missionId: string; goal: string; trackerReport: TrackerReportRef }): Promise<{
    report: PredictionReportRef;
    artifactPayload: unknown;
  }>;
  decide(input: {
    missionId: string;
    goal: string;
    trackerReport: TrackerReportRef;
    predictionReport: PredictionReportRef;
    /** Feedback from the previous rejected decision, if any (bounded loop). */
    lastRejection?: { reason: string; gate: string };
  }): Promise<DecisionCandidate>;
}

/** Worker delegation port. `review` runs before every `delegate` (Delegator semantics, §11.4). */
export interface WorkerPort {
  review(request: DelegationRequest): { allowed: boolean; reason: string; childAgentId?: string };
  delegate(request: DelegationRequest): Promise<{ status: "completed" | "failed"; output?: string; error?: string }>;
}

/** Deterministic verification gates (production: gateTaskCompletion / Kit verify — P6/P7). */
export interface VerificationPort {
  verify(input: { missionId: string; goal: string; taskIds: string[] }): Promise<
    Array<{
      gate: string;
      passed: boolean;
      summary: string;
      evidenceRefs: EvidenceRef[];
      /** Present when the verdict demands stop-the-line (T8 journal tamper). */
      escalate?: string;
    }>
  >;
}

/** Approval resolution — a human in production; never the decision layer (INV-5). */
export interface ApprovalPort {
  resolve(request: { subject: string; riskClass: string; description: string }): Promise<"approved" | "denied">;
}

// ── Journal (events.jsonl under .nexum/missions/<id>/) ──────────────────────

/** Append-only mission event journal: one validated MissionEvent JSON per line. */
export class MissionJournal {
  readonly path: string;
  private readonly events: MissionEvent[] = [];

  constructor(missionDir: string) {
    this.path = join(missionDir, "events.jsonl");
    mkdirSync(missionDir, { recursive: true });
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (isMissionEvent(parsed)) this.events.push(parsed as MissionEvent);
        } catch {
          // corrupt line: skipped on load; audit reports only validated events
        }
      }
    }
  }

  append(event: MissionEvent): void {
    const validation = validateMissionEvent(event);
    if (!validation.valid) throw new Error(`refusing to journal invalid mission event: ${validation.reason}`);
    this.events.push(event);
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }

  /** Validated events, journal order. */
  load(): MissionEvent[] {
    return [...this.events];
  }
}

// ── Audit reconstruction (SPEC §14 — events + artifacts only, no LLM) ────────

export interface MissionAudit {
  missionId: string;
  objective: string;
  outcome: MissionOutcome["outcome"];
  /** State transitions in order (mission.phase events). */
  transitions: Array<{ from: string; to: string; reason: string }>;
  /** Decisions with their re-validation verdicts (accepted + rejected). */
  decisions: Array<{
    decisionId: string;
    action: string;
    kind: "accepted" | "rejected";
    gate?: string;
    reason?: string;
  }>;
  /** Budget consumption from the last checkpoint. */
  budgetConsumed?: MissionCheckpoint["budgetConsumed"];
  degraded: boolean;
}

/** Reconstruct the mission audit record from the journal + last checkpoint alone. */
export function reconstructMissionAudit(journal: MissionJournal, checkpoint: MissionCheckpoint | null): MissionAudit {
  const events = journal.load();
  const audit: MissionAudit = {
    missionId: checkpoint?.missionId ?? (events[0]?.missionId as string | undefined) ?? "",
    objective: "",
    outcome: null,
    transitions: [],
    decisions: [],
    degraded: checkpoint?.degraded ?? false,
  };
  for (const e of events) {
    const payload = (e as { payload?: Record<string, unknown> }).payload ?? {};
    if (e.type === "mission.created") {
      audit.objective = String(payload.objective ?? "");
    } else if (e.type === "mission.phase") {
      if (String(payload.from) !== String(payload.to)) {
        audit.transitions.push({
          from: String(payload.from ?? ""),
          to: String(payload.to ?? ""),
          reason: String(payload.reason ?? ""),
        });
      }
    } else if (e.type === "commander.decision") {
      audit.decisions.push({
        decisionId: String(payload.decisionId ?? ""),
        action: String(payload.kind ?? ""),
        kind: "accepted",
      });
    } else if (e.type === "commander.decision.rejected") {
      audit.decisions.push({
        decisionId: String(payload.decisionId ?? ""),
        action: "",
        kind: "rejected",
        gate: String(payload.gate ?? ""),
        reason: String(payload.reason ?? ""),
      });
    } else if (
      e.type === "mission.completed" ||
      e.type === "mission.failed" ||
      e.type === "mission.aborted" ||
      e.type === "mission.cancelled"
    ) {
      audit.outcome = e.type.split(".")[1] as MissionAudit["outcome"];
    }
  }
  if (checkpoint) audit.budgetConsumed = checkpoint.budgetConsumed;
  return audit;
}

// ── TUI phase mapping (SPEC §11.5) ──────────────────────────────────────────

/** Lifecycle state → TUI MissionPhaseId (the existing vocabulary, F-2 — no second mission vocabulary). */
export function missionPhaseForLifecycleState(state: MissionLifecycleState): MissionPhaseId {
  switch (state) {
    case "created":
    case "triaging":
      return "understand";
    case "observing":
    case "assessing":
    case "single_agent":
      return "inspect";
    case "planning":
      return "plan";
    case "executing":
      return "execute";
    case "verifying":
      return "validate";
    case "awaiting_approval":
      return "review";
    case "completed":
    case "failed":
    case "aborted":
    case "cancelled":
      return "complete";
  }
}

/** Build the TUI-compatible MissionState from the lifecycle history (F-2: reuse, don't invent). */
export function buildTuiMissionState(goal: string, states: MissionLifecycleState[]): MissionState {
  let mission = createMissionState(goal);
  for (const state of states) {
    const phaseId = missionPhaseForLifecycleState(state);
    if (mission.phases.find((p) => p.id === phaseId)?.status === "pending") {
      mission = {
        ...mission,
        phases: mission.phases.map((p) => (p.id === phaseId ? { ...p, status: "running" } : p)),
      };
    }
    if (state === "completed" || state === "failed" || state === "aborted" || state === "cancelled") {
      mission = {
        ...mission,
        phases: mission.phases.map((p) => (p.status === "running" ? { ...p, status: "completed" } : p)),
      };
    }
  }
  return mission;
}

// ── The coordinator ─────────────────────────────────────────────────────────

export interface MissionCoordinatorOptions {
  policy: MissionPolicy;
  roles: MissionRoleAgents;
  workers: WorkerPort;
  verification: VerificationPort;
  approvals: ApprovalPort;
  /** Directory holding <missionId>/{checkpoint.json,events.jsonl,artifacts/}; default .nexum/missions. */
  missionsDir?: string;
  planSteps?: PlanStep[];
  /** External sink (e.g. the P2 event router / TUI store); every journaled event also passes here. */
  emit?: (event: MissionEvent) => void;
  now?: () => number;
  /**
   * The Kit adapter port (SPEC §10.2/§10.5). Mounted only when the mission
   * intent binds a Kit feature/fix id or the policy requires the Kit
   * workflow — otherwise it has no effect. Production wiring passes the
   * domains-plane `SdlcKitAdapter` (structurally assignable, sync-tested).
   */
  kit?: { port: KitPort };
}

interface CoordinatorRunState {
  verificationVerdicts: Array<{ gate: string; passed: boolean }>;
  replansUsed: number;
  replansUsedByTask: Record<string, number>;
  retriesByTask: Record<string, number>;
  childrenInFlight: number;
  childrenStarted: number;
  /** Kit journal verification observed (required for completion when bound, SPEC §10.4). */
  kitJournalVerified: boolean;
  lastRejection?: { reason: string; gate: string };
}

/** Hard deterministic bound on the coordination loop itself (belt beyond the budgets). */
const MAX_COORDINATION_TURNS = 100;

export class MissionCoordinator {
  readonly missionId: string;
  private readonly policy: MissionPolicy;
  private readonly ledger: MissionBudgetLedger;
  private readonly loopGuard = new MissionLoopGuard();
  private lifecycle: MissionLifecycle;
  private readonly journal: MissionJournal;
  private readonly artifactStore: ReportArtifactStore;
  private readonly opts: MissionCoordinatorOptions;
  private cycle: CoordinatorRunState;
  private artifactSeq = 0;
  /** Kit gates for a Kit-bound mission (mounted in the loop prelude, SPEC §10.5). */
  private kitVerification?: KitMissionVerification;

  constructor(opts: MissionCoordinatorOptions, missionId = `ms_${randomUUID()}`) {
    this.missionId = missionId;
    this.opts = opts;
    this.policy = opts.policy;
    this.ledger = new MissionBudgetLedger(opts.policy, { now: opts.now });
    const missionsDir = opts.missionsDir ?? join(workspaceStateDir(findWorkspaceRoot(process.cwd())), "missions");
    this.lifecycle = this.newLifecycle(missionsDir);
    this.journal = new MissionJournal(join(missionsDir, missionId));
    this.artifactStore = new ReportArtifactStore(join(missionsDir, missionId, "artifacts"));
    this.cycle = {
      verificationVerdicts: [],
      replansUsed: 0,
      replansUsedByTask: {},
      retriesByTask: {},
      childrenInFlight: 0,
      childrenStarted: 0,
      kitJournalVerified: false,
    };
  }

  private newLifecycle(missionsDir: string): MissionLifecycle {
    return MissionLifecycle.begin({
      missionId: this.missionId,
      policy: this.policy,
      ledger: this.ledger,
      missionsDir,
      now: this.opts.now,
      emit: (event) => this.journal.append(event),
    });
  }

  /**
   * The deterministic management surface (PR 5.3 CLI): create + gate +
   * activate. No model work happens here — `run()` drives the trio.
   */
  async begin(intent: MissionIntent): Promise<MissionOutcome> {
    this.emit({
      type: "mission.created",
      missionId: this.missionId,
      agentId: "coordinator",
      payload: {
        missionId: this.missionId,
        objective: intent.goal,
        constraints: intent.constraints,
        autonomyProfile: this.policy.profile,
        ...(intent.pilotClass !== undefined ? { pilotClass: intent.pilotClass } : {}),
      },
    });
    this.transition("triaging", "complexity + policy gate");
    const gate = assessComplexity(intent.goal);
    if (!gate.multiStep) {
      // INV-13: below threshold and no risk signals — the trio is never
      // instantiated; the worker continues on the ordinary interactive path.
      this.emit({ type: "mission.single_agent_fallback", missionId: this.missionId, agentId: "coordinator" });
      this.transition("single_agent", `complexity gate: single-step (score ${gate.score})`);
      return this.suspendedOutcome(
        "single-agent fallback: the trio is not instantiated; continue on the ordinary path",
      );
    }
    this.emit({ type: "mission.activated", missionId: this.missionId, agentId: "coordinator" });
    this.transition("observing", `complexity gate: multi-step (score ${gate.score})`);
    return this.suspendedOutcome("mission activated; awaiting role turns (drive with run())");
  }

  /** The §11.2 coordination loop: observe → assess → decide → re-validate → act. */
  async run(intent: MissionIntent, resume?: MissionCheckpoint): Promise<MissionOutcome> {
    if (resume) {
      const resumed = MissionLifecycle.resume(resume, {
        missionId: this.missionId,
        policy: this.policy,
        ledger: this.ledger,
        missionsDir: this.opts.missionsDir,
        now: this.opts.now,
        emit: (event) => this.journal.append(event),
      });
      if (!resumed.ok) {
        return this.finish(`resume refused: ${resumed.reason}`, "failed");
      }
      // In-flight delegations of the previous incarnation are orphaned
      // (§7.3): they are never re-run; the idempotency keys of the tool
      // pipeline protect double execution.
      this.lifecycle = resumed.lifecycle;
      this.cycle.childrenInFlight = 0;
    } else {
      const begin = await this.begin(intent);
      if (begin.state === "single_agent" || begin.outcome === "failed") return begin;
    }
    return this.loop(intent);
  }

  cancel(reason: string): MissionOutcome {
    const result = this.lifecycle.cancel(reason);
    if (!result.changed) {
      // I7: a late cancel on a terminal mission is a no-op recorded as a warning
      return this.finish(result.warning?.message ?? "late cancel no-op", this.lifecycle.state as "failed");
    }
    return {
      missionId: this.missionId,
      outcome: "cancelled",
      summary: reason,
      state: "cancelled",
      resumable: false,
      checkpoint: this.lifecycle.checkpoint(),
    };
  }

  audit(): MissionAudit {
    return reconstructMissionAudit(this.journal, this.lifecycle.checkpointStore.load());
  }

  journalEvents(): MissionEvent[] {
    return this.journal.load();
  }

  /** The TUI-compatible mission view (§11.5): existing MissionState vocabulary. */
  tuiMissionState(goal: string): MissionState {
    return buildTuiMissionState(
      goal,
      this.lifecycle.record.history.map((h) => h.to),
    );
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  private async loop(intent: MissionIntent): Promise<MissionOutcome> {
    // Kit workflow gating (SPEC §10.5 row 1): the adapter is mounted only
    // when a Kit feature/fix id is bound or the policy requires the Kit
    // workflow. A requireKitWorkflow mission NEVER proceeds ungated —
    // missing binding or missing Kit aborts. A bound-but-optional mission
    // degrades instead (the §7.1 overlay forces re-observation).
    const kitBinding = intent.kitBinding ?? null;
    const kitPort = this.opts.kit?.port ?? null;
    if (this.policy.requireKitWorkflow && kitBinding === null) {
      this.lifecycle.abort("requireKitWorkflow without a Kit feature/fix binding");
      return this.finish(
        "requireKitWorkflow mission has no Kit feature/fix binding — refused ungated (SPEC §10.5)",
        "aborted",
      );
    }
    if (kitBinding !== null) {
      if (kitPort === null || !kitPort.available()) {
        if (this.policy.requireKitWorkflow) {
          this.lifecycle.abort("Kit CLI unavailable (external-unavailable)");
          return this.finish(
            "Kit CLI unavailable (external-unavailable) — requireKitWorkflow missions abort rather than proceed ungated (SPEC §10.5)",
            "aborted",
          );
        }
        // Bound but optional, and the Kit is missing: the degraded overlay
        // forces re-observation (§7.1) — never a silent ungated proceed.
        this.lifecycle.markDegraded();
      } else {
        this.kitVerification = new KitMissionVerification({
          missionId: this.missionId,
          port: kitPort,
          binding: kitBinding,
          artifactStore: this.artifactStore,
          allocateSeq: () => {
            this.artifactSeq += 1;
            return this.artifactSeq;
          },
        });
      }
    }
    for (let turn = 0; turn < MAX_COORDINATION_TURNS; turn += 1) {
      const preflight = this.ledger.preflight();
      if (!preflight.ok) {
        this.fail("budget_exhausted", preflight.exceeded);
        return this.finish(
          `budget_exhausted (${preflight.exceeded.map((e) => `${e.dimension} ${e.consumed}/${e.limit}`).join(", ")})`,
          "failed",
        );
      }

      // 1. observe (Tracker first) — every role turn is a bounded child
      let tracker: Awaited<ReturnType<MissionRoleAgents["observe"]>>;
      try {
        if (!this.beginChild()) return this.budgetTerminated();
        tracker = await this.opts.roles.observe({ missionId: this.missionId, goal: intent.goal });
      } catch (err) {
        return this.suspend(err);
      }
      if (this.lifecycle.state === "observing") this.lifecycle.clearDegradedAfterObservation();
      this.persistArtifact("tracker-report", tracker.artifactPayload, (artifact) => {
        this.emit({
          type: "tracker.report",
          missionId: this.missionId,
          agentId: "tracker",
          payload: tracker.report,
          evidenceRefs: [`artifact:${artifact.artifactId}`],
        });
      });
      if (tracker.report.health === "degraded") {
        // §7.1: forces re-observation before the next decision; never
        // unblocks by itself. The next turn observes again.
        this.lifecycle.markDegraded();
        continue;
      }
      if (this.lifecycle.state === "observing") {
        const done = this.transitionOr("assessing", "tracker report published");
        if (done) return done;
      }

      // 2. assess (Predictor)
      let prediction: Awaited<ReturnType<MissionRoleAgents["assess"]>>;
      try {
        if (!this.beginChild()) return this.budgetTerminated();
        prediction = await this.opts.roles.assess({
          missionId: this.missionId,
          goal: intent.goal,
          trackerReport: tracker.report,
        });
      } catch (err) {
        return this.suspend(err);
      }
      this.persistArtifact("prediction-report", prediction.artifactPayload, (artifact) => {
        this.emit({
          type: "prediction.report",
          missionId: this.missionId,
          agentId: "predictor",
          payload: prediction.report,
          evidenceRefs: [`artifact:${artifact.artifactId}`],
        });
      });
      if (this.lifecycle.state === "assessing") {
        const done = this.transitionOr("planning", "prediction report in");
        if (done) return done;
      }

      // 3. decide (Commander — a proposal, never an authority)
      let decision: DecisionCandidate;
      try {
        decision = await this.opts.roles.decide({
          missionId: this.missionId,
          goal: intent.goal,
          trackerReport: tracker.report,
          predictionReport: prediction.report,
          ...(this.cycle.lastRejection ? { lastRejection: this.cycle.lastRejection } : {}),
        });
      } catch (err) {
        return this.suspend(err);
      }

      // 4. loop admission (§12.2): flagged decisions cannot re-enter the loop
      const admitted = this.loopGuard.admitDecision({
        action: decision.action,
        taskIds: decision.taskIds ?? [],
        rationale: decision.rationale,
      });
      if (!admitted.admitted) {
        const outcome = this.rejectDecision(decision.decisionId, admitted.reason ?? "decision loop", "policy");
        if (outcome) return outcome;
        continue;
      }

      // 5. re-validate (§11.4 — the authorization step)
      const validated = reValidateDecision(decision, this.context());
      if (!validated.ok) {
        const outcome = this.rejectDecision(decision.decisionId, validated.reason, validated.gate);
        if (outcome) return outcome;
        continue;
      }
      this.ledger.acceptDecision();
      this.cycle.lastRejection = undefined;

      // 6. the accepted decision persists as an immutable artifact + event
      const action = decision.action;
      this.persistArtifact("commander-decision", decision, (artifact) => {
        this.emit({
          type: "commander.decision",
          missionId: this.missionId,
          agentId: "commander",
          payload: { decisionId: decision.decisionId, artifactId: artifact.artifactId, kind: action },
          evidenceRefs: [`artifact:${artifact.artifactId}`],
        });
      });

      // 7. execute the validated action
      switch (action) {
        case "delegate": {
          const request = validated.delegationRequest!;
          const review = this.opts.workers.review(request);
          if (!review.allowed) {
            const outcome = this.rejectDecision(
              decision.decisionId,
              `delegator review refused: ${review.reason}`,
              "budget",
            );
            if (outcome) return outcome;
            continue;
          }
          if (!this.beginChild()) return this.budgetTerminated();
          const delegationId = newDelegationId();
          this.lifecycle.trackDelegation(delegationId);
          this.transition("executing", "decision(delegate) validated");
          this.emit({
            type: "mission.delegation",
            missionId: this.missionId,
            agentId: "coordinator",
            payload: {
              delegateId: delegationId,
              targetAgentId: review.childAgentId ?? "worker",
              requiredCapabilities: request.requiredCapabilities ?? [],
              contextHandoff: (request.contextHandoff ?? []).join("\n").slice(0, this.policy.maxContextHandoffChars),
              evidenceRefs: [`event:${decision.decisionId}`],
            },
          });
          let workerResult: Awaited<ReturnType<WorkerPort["delegate"]>>;
          try {
            workerResult = await this.opts.workers.delegate(request);
          } catch (err) {
            this.lifecycle.settleDelegation(delegationId);
            return this.suspend(err);
          }
          this.lifecycle.settleDelegation(delegationId);
          this.transition("verifying", "delegation results in");
          if (workerResult.status === "failed") {
            // failure honesty: recorded, fed back to the next decision
            this.cycle.lastRejection = { reason: `worker failed: ${workerResult.error ?? "unknown"}`, gate: "budget" };
          } else if (this.kitVerification) {
            // Kit phase advancement (SPEC §10.3): only the adapter-observed
            // exit code can advance a TDD phase — the worker's claim is
            // never evidence. The Kit's requiredAction dictates the step and
            // the Kit itself refuses invalid transitions (no GREEN before an
            // observed RED); a refused or misaligned step is surfaced to the
            // next decision turn, never retried here (bounded by budgets).
            try {
              const advanced = await this.kitVerification.advanceRequiredPhase(
                (this.opts.planSteps ?? []).map((s) => s.id),
              );
              if (!advanced.ok) {
                this.cycle.lastRejection = { reason: `kit phase refused: ${advanced.reason}`, gate: "policy" };
              } else if (advanced.alignment?.mismatch) {
                this.cycle.lastRejection = {
                  reason: `kit alignment: ${advanced.alignment.mismatch}`,
                  gate: "policy",
                };
              }
            } catch (err) {
              this.cycle.lastRejection = {
                reason: `kit phase advancement failed: ${err instanceof Error ? err.message : String(err)}`,
                gate: "policy",
              };
            }
          }
          continue;
        }
        case "verify": {
          // Kit-bound missions verify through the Kit gates (SPEC §10.4);
          // every verdict is adapter-observed evidence, journaled as events.
          const verifier = this.kitVerification ?? this.opts.verification;
          const verdicts = await verifier.verify({
            missionId: this.missionId,
            goal: intent.goal,
            taskIds: decision.taskIds ?? [],
          });
          let escalation: string | null = null;
          for (const verdict of verdicts) {
            this.cycle.verificationVerdicts.push({ gate: verdict.gate, passed: verdict.passed });
            if (verdict.gate === KIT_JOURNAL_GATE && verdict.passed) {
              // the completion gate reads this (SPEC §10.4: journal-verify
              // required for mission.completed on Kit-bound missions)
              this.cycle.kitJournalVerified = true;
            }
            if (verdict.escalate) escalation = verdict.escalate;
            this.emit({
              type: "mission.verification",
              missionId: this.missionId,
              agentId: "coordinator",
              payload: verdict,
              evidenceRefs: verdict.evidenceRefs,
            });
          }
          if (escalation !== null) {
            // T8 stop-the-line: journal tamper — the mission aborts with a
            // human escalation; the journal itself is the incident record.
            this.lifecycle.abort(`verification escalation: ${escalation}`);
            return this.finish(`mission aborted — ${escalation}`, "aborted");
          }
          continue;
        }
        case "complete": {
          if (this.lifecycle.state === "verifying") {
            this.transition("completed", "deterministic gates passed");
          }
          return this.finish("mission report assembled by the coordinator (not self-declared)", "completed");
        }
        case "abort": {
          // An accepted commander abort: deterministic termination from any
          // active state (the escape hatch, like fail — §7.1 table edges do
          // not cover aborting from executing/verifying).
          this.lifecycle.abort(decision.rationale);
          return this.finish(decision.rationale, "aborted");
        }
        case "replan": {
          const replan = this.ledger.requestReplan(decision.replan?.changedNodes[0]);
          if (!replan.ok) {
            this.fail("replan budget exhausted", this.ledger.exceededDimensions());
            return this.finish(replan.reason ?? "replan budget exhausted", "failed");
          }
          this.cycle.replansUsed += 1;
          const cycle = this.loopGuard.admitReplan(hashPlanDag(this.opts.planSteps ?? []));
          if (!cycle.admitted) {
            this.fail("decision_loop", this.ledger.exceededDimensions());
            return this.finish(cycle.reason ?? "replan cycle", "failed");
          }
          continue;
        }
        case "retry": {
          const taskId = decision.retry?.taskId ?? "unknown";
          this.cycle.retriesByTask[taskId] = (this.cycle.retriesByTask[taskId] ?? 0) + 1;
          continue;
        }
        case "request_approval": {
          const routing = validated.approvalRouting!;
          const approvalId = `apr_${randomUUID()}`;
          this.emit({
            type: "mission.approval.requested",
            missionId: this.missionId,
            agentId: "coordinator",
            payload: { approvalId, subject: routing.subject, posture: routing.riskClass, resolvedAs: "pending" },
          });
          this.transition("awaiting_approval", "approval-class action");
          const resolution = await this.opts.approvals.resolve(routing);
          this.emit({
            type: "mission.approval.resolved",
            missionId: this.missionId,
            agentId: "coordinator",
            payload: { approvalId, subject: routing.subject, posture: routing.riskClass, resolvedAs: resolution },
          });
          if (resolution === "approved") {
            this.transition("executing", "approved");
          } else {
            this.transition("aborted", "approval denied");
            return this.finish("approval denied", "aborted");
          }
          continue;
        }
        default:
          return this.finish(`unhandled action ${String(action)}`, "failed");
      }
    }
    this.fail("coordination loop bound exceeded", this.ledger.exceededDimensions());
    return this.finish("coordination loop bound exceeded", "failed");
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Record one bounded delegated child (role turn or worker); false when the cap is hit. */
  private beginChild(): boolean {
    const child = this.ledger.recordChild();
    if (child.ok) {
      this.cycle.childrenStarted += 1;
      return true;
    }
    return false;
  }

  private budgetTerminated(): MissionOutcome {
    this.fail("budget_exhausted", this.ledger.exceededDimensions());
    return this.finish("budget_exhausted", "failed");
  }

  /** Record a rejected decision; returns a terminal outcome when the rejection budget is spent. */
  private rejectDecision(decisionId: string, reason: string, gate: RevalidationGate): MissionOutcome | null {
    this.emit({
      type: "commander.decision.rejected",
      missionId: this.missionId,
      agentId: "coordinator",
      payload: { decisionId, reason, gate },
    });
    const budget = this.ledger.recordDecisionRejection();
    this.cycle.lastRejection = { reason, gate };
    if (!budget.ok) {
      this.fail("decision_loop", this.ledger.exceededDimensions());
      return this.finish(budget.reason ?? "decision-failure budget exhausted", "failed");
    }
    return null;
  }

  private context(): DecisionValidationContext {
    return {
      policy: this.policy,
      planSteps: this.opts.planSteps ?? [],
      verificationVerdicts: this.cycle.verificationVerdicts,
      replansUsed: this.cycle.replansUsed,
      replansUsedByTask: this.cycle.replansUsedByTask,
      retriesByTask: this.cycle.retriesByTask,
      childrenInFlight: this.cycle.childrenInFlight,
      childrenStarted: this.cycle.childrenStarted,
      kitJournalVerified: this.cycle.kitJournalVerified,
    };
  }

  private transition(to: MissionLifecycleState, reason: string): boolean {
    const result = this.lifecycle.transition(to, reason);
    if (result.ok) return true;
    // A refused transition is a coordination failure: fail the mission
    // rather than continuing against a desynchronized lifecycle.
    this.fail(`transition refused: ${result.reason ?? "unknown"}`);
    return false;
  }

  /** Apply a lifecycle transition; a terminal outcome when it fails. */
  private transitionOr(to: MissionLifecycleState, reason: string): MissionOutcome | null {
    const result = this.lifecycle.transition(to, reason);
    if (result.ok) return null;
    if (result.exceeded && result.exceeded.length > 0) {
      // The budget gate refused the transition — deterministic exhaustion.
      this.lifecycle.fail("budget_exhausted", result.exceeded);
      return this.finish(
        `budget_exhausted (${result.exceeded.map((e) => `${e.dimension} ${e.consumed}/${e.limit}`).join(", ")})`,
        "failed",
      );
    }
    this.lifecycle.fail(`transition refused: ${result.reason ?? "unknown"}`);
    return this.finish(`transition refused: ${result.reason ?? "unknown"}`, "failed");
  }

  private fail(reason: string, exceeded?: Array<{ dimension: string; consumed: number; limit: number }>): void {
    // The lifecycle records the failure (mission.failed event + warnings);
    // a double-fail on a terminal lifecycle is recorded as a warning only.
    this.lifecycle.fail(reason, exceeded);
  }

  private finish(summary: string, outcome: MissionOutcome["outcome"]): MissionOutcome {
    return {
      missionId: this.missionId,
      outcome,
      summary,
      state: this.lifecycle.state,
      resumable: false,
      checkpoint: this.lifecycle.checkpoint(),
    };
  }

  private suspendedOutcome(summary: string): MissionOutcome {
    return {
      missionId: this.missionId,
      outcome: null,
      summary,
      state: this.lifecycle.state,
      resumable: true,
      checkpoint: this.lifecycle.checkpoint(),
    };
  }

  /** A role/worker crash suspends the mission at a checkpoint — resumable, never a silent failure. */
  private suspend(err: unknown): MissionOutcome {
    const reason = err instanceof Error ? err.message : String(err);
    return this.suspendedOutcome(`suspended: ${reason}`);
  }

  private emit(event: MissionEvent): void {
    this.journal.append(event);
    this.opts.emit?.(event);
  }

  private persistArtifact(
    kind: ReportArtifactKind,
    payload: unknown,
    onStored: (artifact: ReportArtifact) => void,
  ): void {
    this.artifactSeq += 1;
    const built = buildReportArtifact(kind, this.missionId, this.artifactSeq, payload);
    if (!built.ok) return; // artifact write refused: the event is skipped, never fabricated
    const write = this.artifactStore.write(built.artifact);
    if (write.ok) onStored(write.artifact);
  }
}

/** Stable hash of the live plan (replan-cycle detection, §12.2). */
function hashPlanDag(steps: PlanStep[]): string {
  return createHash("sha256")
    .update(JSON.stringify(steps.map((s) => ({ id: s.id, dependencies: [...s.dependencies].sort() }))))
    .digest("hex");
}
