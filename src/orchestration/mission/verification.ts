/**
 * MAC v1 P6 PR 6.2 — Kit evidence → verification gates (SPEC §10.3–§10.5).
 *
 * Only adapter-observed Kit invocations can advance a TDD phase or prove one
 * complete — an LLM (or any agent) declaring RED/GREEN/VERIFIED is never
 * evidence (INV-6 extension / invariant I6; SPEC §10.3 "An LLM never advances
 * or declares a TDD phase"). This module:
 *
 *   1. defines `KitPort` — the mission plane's consumer-side twin of the
 *      domains-plane adapter (`src/domains/agentic-sdlc-kit/adapter.ts`).
 *      Layering forbids importing the domains plane from here, so the port is
 *      declared locally and kept STRUCTURALLY ASSIGNABLE to the adapter by a
 *      mirror-sync test (same pattern as the commander decision twin).
 *   2. `alignWithKitNext` — the pure alignment rule: `kit next --json` is the
 *      authoritative statement of what the workflow needs next; when the plan
 *      disagrees, the Kit WINS and the mismatch is a coordination failure
 *      logged for the Commander to resolve (SPEC §10.3).
 *   3. `KitEvidence` (SPEC §10.4) — evidence records with the Kit-observed
 *      verification outcome, persisted as `verification-evidence` artifacts.
 *   4. `KitMissionVerification` — the `VerificationPort` implementation for
 *      Kit-bound missions: evidence-chain gate (the Kit's own audit), the
 *      hash-chained journal gate (required for `mission.completed`), the
 *      next-alignment gate, and T8 journal-tamper escalation (mission aborts,
 *      human escalation, the journal is the incident record).
 *
 * Kit payload grounding (verified against the Kit repo, schema v2):
 * a phase command's `--json` output is the FeatureRunState whose task records
 * carry `status: "passed" | "failed"` + the task-targeted verification
 * metadata — the observed RED (failed) / GREEN (passing) outcome. SPEC §10.4
 * sketches this as `exitCode !== 0` (red) / `exitCode === 0` (green); the
 * Kit's actual v2 records surface the observation as a status + failure
 * classification, recorded here as `verificationStatus` alongside the Kit
 * invocation's exit code. The grounding rule is unchanged: adapter-observed
 * only, never an agent claim.
 */

import { z } from "zod";
import type { EvidenceRef } from "./events.js";
import { buildReportArtifact, ReportArtifactStore } from "./report-artifacts.js";
import type { VerificationPort } from "./mission-coordinator.js";

// ── KitPort — consumer-side twin of the domains-plane adapter ───────────────

/** TDD phases the coordinator may advance through the adapter (SPEC §10.2 subset). */
export type KitPhase = "start" | "red" | "green" | "refactor" | "verify";

/**
 * The command subset the mission plane consumes (SPEC §10.2): the phase
 * machine, the `next` protocol and the journal audit. `inspect`/`doctor`/
 * `validate-spec`/`validate-plan`/`verify` remain agent-facing tools
 * (`sdlc_*`) — they are deliberately NOT part of the coordinator surface.
 */
export type KitCommand =
  | { op: "feature-phase"; featureId: string; taskId: string; phase: KitPhase }
  | { op: "fix-phase"; fixId: string; taskId: string; phase: KitPhase }
  | { op: "next" }
  | { op: "journal-verify"; runId: string };

/** Structural twin of the adapter's SdlcKitResult (sync-tested). */
export interface KitOutcome {
  ok: boolean;
  exitCode: number;
  parsed: unknown | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  failure: string | null;
  blocker: string | null;
  evidence: EvidenceRef[];
}

/**
 * The port the mission plane consumes. The production adapter
 * (`SdlcKitAdapter`) is structurally assignable to this interface — a
 * mirror-sync test proves it; the mission plane never imports the adapter.
 */
export interface KitPort {
  /** Kit present? (SPEC §10.5 row 1 — re-checked before every gate run) */
  available(): boolean;
  execute(command: KitCommand): Promise<KitOutcome>;
}

// ── `kit next --json` payload + the alignment rule (SPEC §10.3) ──────────────

/** The machine-readable NextAction payload (Kit ADR-0021 §2, verified contract). */
export interface KitNextAction {
  featureId?: string;
  status?: string;
  taskId?: string;
  phase?: string;
  /** What the workflow requires next — the authoritative statement. */
  requiredAction: string;
  nextInvocation?: string;
  verificationCommand?: string[];
  blockingQuestions?: string[];
  advisoryLessons?: string[];
}

/** The Kit's terminal statement: the run has its full evidence chain. */
export const KIT_RUN_COMPLETED = "run.completed";

export interface KitAlignmentInput {
  /** The mission's planned task ids, in TaskGraph order. */
  plannedTaskIds: readonly string[];
  /** What the coordinator intends next, or null when it has no phase intent. */
  intent: { taskId: string; phase: KitPhase } | { runCompleted: true } | null;
  /** The Kit's `next --json` payload; null when the Kit is unavailable/blocked. */
  next: KitNextAction | null;
}

export interface KitAlignment {
  /** The authoritative next action — the Kit's requiredAction when present (the Kit wins). */
  requiredAction: string;
  /** The task the Kit requires next (when the requirement is task-scoped). */
  taskId?: string;
  /** The phase the Kit requires next (when the requirement is phase-scoped). */
  phase?: string;
  /** True iff the coordinator's intent matches the Kit's requirement. */
  aligned: boolean;
  /** Coordination failure record — present iff !aligned; the Kit wins. */
  mismatch: string | null;
}

/**
 * The pure alignment rule (SPEC §10.3): `kit next --json` is authoritative.
 * On disagreement the Kit's `requiredAction` wins and the mismatch is logged
 * as a coordination failure for the Commander to resolve — never silently
 * repaired (the same honesty as INV-5's verbatim DAG rejection).
 */
export function alignWithKitNext(input: KitAlignmentInput): KitAlignment {
  if (input.next === null) {
    return {
      requiredAction: "",
      aligned: false,
      mismatch: "kit next unavailable — the workflow requirement cannot be established",
    };
  }
  const next = input.next;
  const requiredAction = next.requiredAction;
  const base = {
    requiredAction,
    ...(next.taskId !== undefined ? { taskId: next.taskId } : {}),
    ...(next.phase !== undefined ? { phase: next.phase } : {}),
  };

  if (requiredAction === KIT_RUN_COMPLETED) {
    // The Kit says the run is complete: nothing more may advance. With no
    // intent (or an explicit completion intent) there is no disagreement.
    if (input.intent === null || "runCompleted" in input.intent) {
      return { ...base, aligned: true, mismatch: null };
    }
    return {
      ...base,
      aligned: false,
      mismatch: `coordination failure: plan intends ${input.intent.taskId} ${input.intent.phase} but the Kit requires run.completed — the Kit wins`,
    };
  }

  // A phase requirement (red/green/refactor/start/verify for a task).
  const requiredTask = next.taskId ?? "(unspecified task)";
  const requiredPhase = next.phase ?? requiredAction;
  const withinPlan = input.plannedTaskIds.includes(requiredTask);
  if (input.intent !== null && "runCompleted" in input.intent) {
    // Completion intent vs a phase requirement: the Kit wins — more work first.
    return {
      ...base,
      aligned: false,
      mismatch: `coordination failure: plan intends completion but the Kit requires ${requiredTask} ${requiredPhase} — the Kit wins`,
    };
  }
  if (input.intent !== null) {
    const matches = input.intent.taskId === requiredTask && input.intent.phase === requiredPhase;
    if (matches) {
      return { ...base, aligned: true, mismatch: null };
    }
    return {
      ...base,
      aligned: false,
      mismatch: `coordination failure: plan intends ${input.intent.taskId} ${input.intent.phase} but the Kit requires ${requiredTask} ${requiredPhase} — the Kit wins`,
    };
  }
  if (!withinPlan && next.taskId !== undefined) {
    return {
      ...base,
      aligned: false,
      mismatch: `coordination failure: the Kit requires ${requiredTask} ${requiredPhase} which is not in the plan — the Kit wins`,
    };
  }
  // No coordinator intent to disagree with: the coordinator follows the Kit.
  return { ...base, aligned: true, mismatch: null };
}

// ── Kit evidence (SPEC §10.4) ───────────────────────────────────────────────

/** Evidence kinds — each grounded in a specific adapter-observed Kit invocation. */
export type KitEvidenceKind = "red" | "green" | "refactor" | "verify" | "journal";

export interface KitEvidence {
  kind: KitEvidenceKind;
  runId: string;
  /** Task phase kinds only (red/green/refactor); run-wide kinds (verify/journal) omit it. */
  taskId?: string;
  /** The Kit-observed verification outcome for the phase (from the Kit's own evidence records). */
  verificationStatus?: "passed" | "failed";
  /** The command the Kit ran for the observed verification, when the Kit reports it. */
  verificationCommand?: string[];
  /** journal kind only: the hash-chained journal's last verified hash. */
  journalHash?: string;
  /** The Kit invocation's exit code (0 = the Kit recorded the step). */
  exitCode: number;
  observedAt: string;
  artifactRefs: EvidenceRef[];
}

export const kitEvidenceSchema = z
  .object({
    kind: z.enum(["red", "green", "refactor", "verify", "journal"]),
    runId: z.string().min(1),
    taskId: z
      .string()
      .regex(/^TASK-[0-9]{3,}$/)
      .optional(),
    verificationStatus: z.enum(["passed", "failed"]).optional(),
    verificationCommand: z.array(z.string()).optional(),
    journalHash: z.string().min(1).optional(),
    exitCode: z.number().int(),
    observedAt: z.string().min(1),
    artifactRefs: z.array(z.string().refine((v) => /^(artifact|event|run|checkpoint):.+/.test(v))).min(1),
  })
  .strict()
  .superRefine((e, ctx) => {
    const taskScoped = e.kind === "red" || e.kind === "green" || e.kind === "refactor";
    if (taskScoped && e.taskId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["taskId"], message: `${e.kind} evidence is task-scoped` });
    }
    if (taskScoped && e.verificationStatus === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verificationStatus"],
        message: `${e.kind} evidence requires the Kit-observed verification outcome`,
      });
    }
    if (e.kind === "journal" && e.journalHash === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["journalHash"],
        message: "journal evidence requires the last verified hash",
      });
    }
    if (e.kind === "red" && e.verificationStatus !== "failed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verificationStatus"],
        message: "RED evidence requires an observed FAILING verification (SPEC §10.4) — never an agent claim",
      });
    }
    if ((e.kind === "green" || e.kind === "refactor") && e.verificationStatus !== "passed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verificationStatus"],
        message: `${e.kind.toUpperCase()} evidence requires an observed PASSING verification (SPEC §10.4)`,
      });
    }
  });

/** Verify a red/green/refactor evidence record satisfies its phase invariant. */
export function evidenceSatisfiesPhase(evidence: KitEvidence): boolean {
  const parsed = kitEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return false;
  if (evidence.exitCode !== 0) return false; // the Kit must have recorded the step
  return true;
}

// ── Gate names (verdict vocabulary) ─────────────────────────────────────────

/** The Kit's own evidence-chain audit (`kit feature|fix <ID> verify`). */
export const KIT_EVIDENCE_CHAIN_GATE = "kit-evidence-chain";
/** The hash-chained journal verification — required for mission.completed (SPEC §10.4). */
export const KIT_JOURNAL_GATE = "kit-journal-verified";
/** Alignment with `kit next --json` — the Kit's requirement wins (SPEC §10.3). */
export const KIT_NEXT_ALIGNMENT_GATE = "kit-next-alignment";

/** Verdicts may demand stop-the-line escalation (T8: journal tamper). */
export interface KitVerdict {
  gate: string;
  passed: boolean;
  summary: string;
  evidenceRefs: EvidenceRef[];
  /** Present when the verdict requires mission abort + human escalation. */
  escalate?: string;
}

// ── The service ─────────────────────────────────────────────────────────────

export interface KitMissionVerificationOptions {
  missionId: string;
  port: KitPort;
  /** The bound Kit run (from the mission intent). */
  binding: { kind: "feature" | "fix"; id: string };
  artifactStore: ReportArtifactStore;
  /** Monotonic artifact sequence allocator (shared with the coordinator's store). */
  allocateSeq: () => number;
  /** ISO timestamp override (tests). */
  now?: () => string;
}

/** The observed outcome of advancing one TDD phase through the adapter. */
export type PhaseAdvance =
  | { ok: true; advanced: KitEvidence | null; alignment: KitAlignment }
  | { ok: false; reason: string; alignment: KitAlignment | null };

/**
 * Verification gates for Kit-bound missions — implements the coordinator's
 * `VerificationPort`. Deterministic: every verdict is grounded in an
 * adapter-observed Kit invocation persisted as a `verification-evidence`
 * artifact; nothing here reads a model or trusts an agent's claim.
 */
export class KitMissionVerification implements VerificationPort {
  private readonly opts: KitMissionVerificationOptions;
  /** Evidence observed so far, in observation order (append-only). */
  private readonly evidence: KitEvidence[] = [];

  constructor(opts: KitMissionVerificationOptions) {
    this.opts = opts;
  }

  /** Observed evidence so far (audit surface — a copy, never the live list). */
  observedEvidence(): readonly KitEvidence[] {
    return [...this.evidence];
  }

  /**
   * Advance the phase the Kit requires next (SPEC §10.3). The Kit's
   * `requiredAction` dictates the step — including its taskId — and the Kit
   * itself refuses invalid transitions; a refused step is surfaced, never
   * retried here (bounded retries belong to the coordination loop budgets).
   */
  async advanceRequiredPhase(plannedTaskIds: readonly string[]): Promise<PhaseAdvance> {
    const next = await this.opts.port.execute({ op: "next" });
    if (!next.ok || next.parsed === null) {
      return {
        ok: false,
        reason: kitFailureReason(next, "kit next unavailable — the required phase cannot be established"),
        alignment: null,
      };
    }
    const action = next.parsed as KitNextAction;
    const alignment = alignWithKitNext({ plannedTaskIds, intent: null, next: action });
    if (action.requiredAction === KIT_RUN_COMPLETED || action.taskId === undefined) {
      // Nothing to advance (run complete, or a non-phase requirement such as
      // an open blocking question — surfaced to the Commander via alignment).
      return { ok: true, advanced: null, alignment };
    }
    const phase = (action.phase ?? action.requiredAction) as KitPhase;
    if (!isKitPhase(phase)) {
      return { ok: false, reason: `kit next requiredAction "${action.requiredAction}" is not a phase`, alignment };
    }
    const outcome = await this.opts.port.execute({
      ...(this.opts.binding.kind === "feature"
        ? { op: "feature-phase" as const, featureId: this.opts.binding.id }
        : { op: "fix-phase" as const, fixId: this.opts.binding.id }),
      taskId: action.taskId,
      phase,
    });
    if (!outcome.ok) {
      // The Kit refused (its invariants: no GREEN before observed RED, …).
      return {
        ok: false,
        reason: `kit refused ${phase} for ${action.taskId}: ${kitFailureReason(outcome, outcome.stderr)}`,
        alignment,
      };
    }
    const evidence = this.recordPhaseEvidence(phase, action.taskId, outcome);
    if (evidence === null) {
      return { ok: false, reason: `kit accepted ${phase} but no evidence record could be derived`, alignment };
    }
    return { ok: true, advanced: evidence, alignment };
  }

  /**
   * The VerificationPort gate run (the coordinator's "verify" action):
   * evidence chain → journal → next-alignment. Every verdict carries the
   * artifact refs of its raw Kit output; a journal-tamper indication
   * escalates (T8) — the mission aborts, humans are escalated, the journal
   * itself is the incident record.
   */
  async verify(input: { missionId: string; goal: string; taskIds: string[] }): Promise<KitVerdict[]> {
    const verdicts: KitVerdict[] = [];

    // 1. Evidence chain: the Kit audits the Red→Green→Refactor evidence per
    //    task and runs whole-profile verification (`kit feature <ID> verify`).
    const chain = await this.opts.port.execute({
      ...(this.opts.binding.kind === "feature"
        ? { op: "feature-phase" as const, featureId: this.opts.binding.id }
        : { op: "fix-phase" as const, fixId: this.opts.binding.id }),
      taskId: input.taskIds[0] ?? "TASK-001",
      phase: "verify",
    });
    const chainRefs = this.persistRaw("verify", chain);
    if (chain.ok) {
      this.evidence.push({
        kind: "verify",
        runId: this.opts.binding.id,
        exitCode: chain.exitCode,
        observedAt: this.now(),
        artifactRefs: chainRefs,
      });
    }
    verdicts.push({
      gate: KIT_EVIDENCE_CHAIN_GATE,
      passed: chain.ok,
      summary: chain.ok
        ? `Kit audited the ${this.opts.binding.kind} evidence chain for ${this.opts.binding.id}`
        : `Kit evidence chain gate failed: ${kitFailureReason(chain, chain.stderr)}`,
      evidenceRefs: chainRefs,
    });

    // 2. Journal: hash-chained verification — required for mission.completed
    //    on Kit-bound missions (SPEC §10.4). A chain violation is T8.
    const journal = await this.opts.port.execute({ op: "journal-verify", runId: this.opts.binding.id });
    const journalRefs = this.persistRaw("journal-verify", journal);
    const journalParsed = journal.parsed as { valid?: unknown; lastHash?: unknown; eventCount?: unknown } | null;
    const journalOk = journal.ok && journalParsed !== null && journalParsed.valid === true;
    if (journalOk) {
      this.evidence.push({
        kind: "journal",
        runId: this.opts.binding.id,
        exitCode: journal.exitCode,
        observedAt: this.now(),
        ...(typeof journalParsed.lastHash === "string" ? { journalHash: journalParsed.lastHash } : {}),
        artifactRefs: journalRefs,
      });
    }
    verdicts.push({
      gate: KIT_JOURNAL_GATE,
      passed: journalOk,
      summary: journalOk
        ? `Kit journal verified for ${this.opts.binding.id}` +
          (typeof journalParsed?.eventCount === "number" ? ` (${journalParsed.eventCount} events)` : "")
        : `Kit journal gate failed: ${kitFailureReason(journal, journal.stderr)}`,
      evidenceRefs: journalRefs,
      ...(journal.exitCode === 1 && !journalOk
        ? {
            escalate: `Kit journal verification failed for ${this.opts.binding.id} — tamper indication (THREAT-MODEL T8): human escalation required`,
          }
        : {}),
    });

    // 3. Next-alignment: the Kit's authoritative requirement at gate time is
    //    run.completed — anything else means the workflow is not done.
    const next = await this.opts.port.execute({ op: "next" });
    const nextRefs = this.persistRaw("next", next);
    const nextAction = next.ok && next.parsed !== null ? (next.parsed as KitNextAction) : null;
    const alignment = alignWithKitNext({
      plannedTaskIds: input.taskIds,
      intent: { runCompleted: true },
      next: nextAction,
    });
    verdicts.push({
      gate: KIT_NEXT_ALIGNMENT_GATE,
      passed: alignment.aligned,
      summary: alignment.aligned
        ? `Kit agrees: ${this.opts.binding.id} is run.completed`
        : `Kit next alignment failed: ${alignment.mismatch ?? "the Kit does not report run.completed"}`,
      evidenceRefs: nextRefs,
    });

    return verdicts;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  /** Derive the phase evidence record from the Kit's FeatureRunState output. */
  private recordPhaseEvidence(
    phase: "red" | "green" | "refactor" | "start" | "verify",
    taskId: string,
    outcome: KitOutcome,
  ): KitEvidence | null {
    if (phase !== "red" && phase !== "green" && phase !== "refactor") return null;
    const refs = this.persistRaw(`${phase}:${taskId}`, outcome);
    const observed = extractObservedStatus(outcome.parsed, taskId, phase);
    if (observed === null) return null;
    const evidence: KitEvidence = {
      kind: phase,
      runId: this.opts.binding.id,
      taskId,
      verificationStatus: observed.status,
      ...(observed.command !== undefined ? { verificationCommand: observed.command } : {}),
      exitCode: outcome.exitCode,
      observedAt: this.now(),
      artifactRefs: refs,
    };
    const valid = kitEvidenceSchema.safeParse(evidence);
    if (!valid.success) return null; // fail-closed: no evidence record without the observed outcome
    this.evidence.push(evidence);
    return evidence;
  }

  /** Persist the raw Kit output as a verification-evidence artifact. */
  private persistRaw(label: string, outcome: KitOutcome): EvidenceRef[] {
    if (outcome.evidence.length > 0) return outcome.evidence; // the adapter already sank it
    const payload = {
      gate: label,
      runId: this.opts.binding.id,
      argv: undefined as string[] | undefined,
      exitCode: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      timedOut: outcome.timedOut,
      failure: outcome.failure,
      observedAt: this.now(),
    };
    const seq = this.opts.allocateSeq();
    const built = buildReportArtifact("verification-evidence", this.opts.missionId, seq, payload);
    if (!built.ok) return [];
    const write = this.opts.artifactStore.write(built.artifact);
    return write.ok ? [`artifact:${write.artifact.artifactId}`] : [];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isKitPhase(value: string): value is KitPhase {
  return value === "start" || value === "red" || value === "green" || value === "refactor" || value === "verify";
}

/** The Kit's failure reason, in its own words, with the SPEC §10.5 mode attached. */
function kitFailureReason(outcome: KitOutcome, fallback: string): string {
  const mode = outcome.failure ?? (outcome.timedOut ? "timeout" : "command-failed");
  const detail = outcome.stderr.trim() || outcome.stdout.trim() || fallback;
  return `${mode}: ${detail}`;
}

/**
 * Extract the Kit-observed verification outcome for a task phase from the
 * FeatureRunState payload (schema v2): the task's latest record for the
 * phase, with `status: "passed" | "failed"` + the verification metadata.
 * Returns null when the observation cannot be established (fail-closed —
 * never guess the phase state).
 */
function extractObservedStatus(
  parsed: unknown,
  taskId: string,
  phase: "red" | "green" | "refactor",
): { status: "passed" | "failed"; command?: string[] } | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const tasks = (parsed as { tasks?: Record<string, unknown> }).tasks;
  if (tasks === undefined || typeof tasks !== "object") return null;
  const task = (tasks as Record<string, { records?: unknown[] }>)[taskId];
  if (task === undefined || !Array.isArray(task.records)) return null;
  // latest record for this phase, in observation order
  for (let i = task.records.length - 1; i >= 0; i -= 1) {
    const record = task.records[i] as { phase?: unknown; status?: unknown; verification?: unknown };
    if (record.phase !== phase) continue;
    if (record.status !== "passed" && record.status !== "failed") return null;
    const command = extractVerificationCommand(record.verification);
    return {
      status: record.status,
      ...(command !== undefined ? { command } : {}),
    };
  }
  return null;
}

function extractVerificationCommand(verification: unknown): string[] | undefined {
  if (verification === null || typeof verification !== "object") return undefined;
  const command = (verification as { command?: unknown }).command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string")) return [...command];
  return undefined;
}
