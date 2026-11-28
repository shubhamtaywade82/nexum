/**
 * Predictor contracts (SPEC §4.2) — MAC v1 P4.
 *
 * The prediction/report contract lives NEXT TO ITS OWNER (SPEC §16: role
 * contracts in `src/agents/<name>/contracts.ts`). The `EvidenceRef` union
 * mirrors `src/orchestration/mission/events.ts` and the tracker's contracts
 * structurally — the agents plane must not import the mission plane (the two
 * planes must not import each other; tests/architecture/mission-layering.test.ts),
 * so the shared vocabulary is declared on each side and stays assignable.
 *
 * This module ENFORCES the SPEC §4.2 grounding rules at the contract layer:
 *
 *   1. Probability ≠ confidence — `probability` requires
 *      `basis: "statistical"` (schema) AND a covering calibration dataset
 *      whose ref resolves (service check in `assemblePredictionReport`):
 *      no dataset, no probability (SPEC §15.3, INV-9).
 *   2. Labeled bases — the `basis` enum is closed; `evidenceRefs` must be
 *      non-empty unless `basis === "unknown"` ("unknown" is a valid answer).
 *      A `model-hypothesis` prediction is allowed but never decision-
 *      sufficient for `complete`/`verify` actions (`DECISION_SUFFICIENT_BASES`).
 *   3. Abstention — missing required evidence ⇒ `abstained` set and
 *      recommendations emptied (schema + service; INV-8). Abstention is a
 *      first-class, tested outcome, not a failure.
 *   4. Lineage — `basedOnReportId` cites the tracker report the predictions
 *      derive from (`^tr_`); staleness is enforced by the agent
 *      (predictor-agent.ts refuses stale/absent input; the coordinator
 *      rejects otherwise — both sides of SPEC §4.2 rule 4).
 *
 * Layering: src/agents/predictor/** imports runtime/core contracts only — no
 * orchestration, ui or domains (ROADMAP P0 invariant).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

// ── Evidence refs (mirrors the mission plane's union; see header) ───────────

export type EvidenceRef =
  | `artifact:${string}` // immutable artifact id
  | `event:${string}` // EventEnvelope id
  | `run:${string}` // recorded run id
  | `checkpoint:${string}`; // mission checkpoint id

export const evidenceRefSchema = z.string().refine((v) => /^(artifact|event|run|checkpoint):.+/.test(v), {
  message: "evidence ref must be artifact:|event:|run:|checkpoint: prefixed",
}) as z.ZodType<EvidenceRef>;

const isoTimestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "must be an ISO 8601 timestamp" });

// ── Prediction / Risk / Recommendation / PredictionReport (SPEC §4.2) ───────

export type PredictionBasis =
  | "observed-fact" // directly observed in cited evidence
  | "historical-pattern" // pattern over cited historical records
  | "statistical" // computed from a calibration dataset
  | "model-hypothesis" // model-generated, not evidence-derived
  | "unknown"; // basis could not be established

export type Confidence = "low" | "medium" | "high";

export interface Prediction {
  /** Task id, file, dependency, mission outcome. */
  subject: string;
  /** Falsifiable statement of expected outcome. */
  outcome: string;
  /** Present ONLY when a calibration dataset covers this subject (SPEC §15.3). Absent probability is not zero — it is "not estimable". */
  probability?: number; // [0,1], calibrated
  /** Quality of available evidence. */
  confidence: Confidence;
  /** REQUIRED — "unknown" is a valid answer. */
  basis: PredictionBasis;
  /** Non-empty unless basis === "unknown". */
  evidenceRefs: EvidenceRef[];
}

export type RiskSeverity = "low" | "medium" | "high" | "critical";

export type RiskCategory =
  "implementation" | "dependency" | "verification" | "regression" | "resource" | "security" | "coordination";

export interface Risk {
  riskId: string;
  category: RiskCategory;
  description: string;
  severity: RiskSeverity;
  /** Observable conditions. */
  triggers: string[];
  mitigation?: string;
  evidenceRefs: EvidenceRef[];
}

/**
 * SPEC §4.3's CommanderAction, mirrored: the commander plane owns the enum
 * (P5 lands `src/agents/commander/contracts.ts`); it must stay structurally
 * assignable to this union, the same way the EvidenceRef unions mirror
 * across planes.
 */
export type CommanderAction = "delegate" | "replan" | "retry" | "verify" | "request_approval" | "complete" | "abort";

export interface Recommendation {
  /** §4.3 — advisory only. */
  targetAction: CommanderAction;
  rationale: string;
  expectedBenefit: string;
  evidenceRefs: EvidenceRef[];
}

/** SPEC §4.2 abstention record — a first-class outcome, not a failure. */
export interface Abstention {
  reason: string;
  missingEvidence: string[];
}

export interface PredictionReport {
  /** `pr_` + uuid. */
  reportId: string;
  missionId: string;
  /** TrackerReport lineage (non-null, `^tr_`). */
  basedOnReportId: string;
  generatedAt: string;
  predictions: Prediction[];
  risks: Risk[];
  recommendations: Recommendation[];
  /** What is NOT known — required, may be long. */
  uncertainty: string[];
  abstained?: Abstention;
  schemaVersion: 1;
}

// ── Zod schemas (fail-closed: the report must validate before it exists) ────

export const predictionSchema = z
  .object({
    subject: z.string().min(1).max(500),
    outcome: z.string().min(1).max(2_000),
    probability: z.number().min(0).max(1).optional(),
    confidence: z.enum(["low", "medium", "high"]),
    basis: z.enum(["observed-fact", "historical-pattern", "statistical", "model-hypothesis", "unknown"]),
    evidenceRefs: z.array(evidenceRefSchema),
  })
  .strict()
  .refine((p) => p.probability === undefined || p.basis === "statistical", {
    message: 'probability requires basis "statistical" (SPEC §4.2 rule 1, INV-9)',
  })
  .refine((p) => p.basis === "unknown" || p.evidenceRefs.length > 0, {
    message: 'evidenceRefs must be non-empty unless basis is "unknown" (SPEC §4.2 rule 2)',
  });

export const riskSchema = z
  .object({
    riskId: z.string().min(1).max(500),
    category: z.enum([
      "implementation",
      "dependency",
      "verification",
      "regression",
      "resource",
      "security",
      "coordination",
    ]),
    description: z.string().min(1).max(2_000),
    severity: z.enum(["low", "medium", "high", "critical"]),
    triggers: z.array(z.string().min(1).max(500)),
    mitigation: z.string().max(2_000).optional(),
    evidenceRefs: z.array(evidenceRefSchema).min(1),
  })
  .strict();

export const commanderActionSchema = z.enum([
  "delegate",
  "replan",
  "retry",
  "verify",
  "request_approval",
  "complete",
  "abort",
]);

export const recommendationSchema = z
  .object({
    targetAction: commanderActionSchema,
    rationale: z.string().min(1).max(4_000),
    expectedBenefit: z.string().min(1).max(2_000),
    evidenceRefs: z.array(evidenceRefSchema).min(1),
  })
  .strict();

export const abstentionSchema = z
  .object({
    reason: z.string().min(1).max(2_000),
    missingEvidence: z.array(z.string().min(1).max(2_000)).min(1),
  })
  .strict();

export const predictionReportSchema = z
  .object({
    reportId: z.string().regex(/^pr_/),
    missionId: z.string().min(1),
    basedOnReportId: z.string().regex(/^tr_/),
    generatedAt: isoTimestamp,
    predictions: z.array(predictionSchema),
    risks: z.array(riskSchema),
    recommendations: z.array(recommendationSchema),
    uncertainty: z.array(z.string().min(1).max(2_000)),
    abstained: abstentionSchema.optional(),
    schemaVersion: z.literal(1),
  })
  .strict()
  .refine((r) => r.abstained === undefined || r.recommendations.length === 0, {
    message: "an abstained report may not emit recommendations (SPEC §4.2 rule 3, INV-8)",
  });

export function newPredictionReportId(): string {
  return `pr_${randomUUID()}`;
}

// ── Basis honesty (SPEC §4.2 rule 2) ────────────────────────────────────────

/** Bases that may support a `complete`/`verify` decision downstream. */
export const DECISION_SUFFICIENT_BASES: readonly PredictionBasis[] = [
  "observed-fact",
  "historical-pattern",
  "statistical",
];

/**
 * A `model-hypothesis` (or `unknown`) prediction is NEVER decision-sufficient
 * for `complete`/`verify` actions (SPEC §4.2 rule 2) — it is surfaced as a
 * hypothesis everywhere downstream and consumers (the P5 coordinator) must
 * refuse such support.
 */
export function isDecisionSufficientBasis(basis: PredictionBasis): boolean {
  return DECISION_SUFFICIENT_BASES.includes(basis);
}

/** Whether the report carries at least one decision-sufficient prediction. */
export function hasDecisionSufficientSupport(report: PredictionReport): boolean {
  return report.predictions.some((p) => isDecisionSufficientBasis(p.basis));
}

// ── Structural ports (supplied by the caller; mission-plane services satisfy) ─

export interface EvidenceRefResolution {
  ok: boolean;
  ref: EvidenceRef;
  violation?: string;
}

export interface EvidenceRefResolverLike {
  resolveAll(refs: EvidenceRef[]): { ok: boolean; resolutions: EvidenceRefResolution[] };
}

/**
 * The labeled-outcome calibration dataset (SPEC §15.3). `covers` encapsulates
 * the "calibration is earned" rule: a subject qualifies only when the dataset
 * holds ≥ 100 labeled outcomes covering it. No dataset, no probability.
 */
export interface CalibrationDatasetLike {
  /** Evidence ref into the dataset; injected into every prediction it backs. */
  readonly ref: EvidenceRef;
  covers(subject: string): boolean;
}

// ── Assembly (SPEC §4.2 grounding rules 1–3, enforced) ─────────────────────

export type DropRule =
  | "prediction-without-evidence"
  | "risk-without-evidence"
  | "recommendation-without-evidence"
  | "unresolvable-evidence"
  | "uncalibrated-statistical-basis";

export interface DroppedEntry {
  rule: DropRule;
  message: string;
  /** The dropped entry when one existed (audit trail). */
  prediction?: Prediction;
  risk?: Risk;
  recommendation?: Recommendation;
}

export interface AssemblePredictionReportInput {
  missionId: string;
  /** The lineage tracker report id (`^tr_`); the agent validates staleness. */
  basedOnReportId: string;
  /** ISO 8601 assembly time. */
  now: string;
  /** Draft predictions (basis-labeled); grounding rules applied below. */
  predictions: Prediction[];
  risks: Risk[];
  recommendations: Recommendation[];
  /** Required evidence the caller could not gather (drives abstention). */
  missingEvidence?: string[];
  /** Declared unknowns — merged with abstention-missing into `uncertainty`. */
  uncertainty?: string[];
  /** Resolves evidence refs; unresolvable refs drop their entry. */
  resolver?: EvidenceRefResolverLike;
  /** No dataset (or one that does not cover the subject) ⇒ no probability. */
  calibrationDataset?: CalibrationDatasetLike;
  /** Drop log sink; entries are also returned in the result (never silent). */
  log?: (entry: DroppedEntry) => void;
}

export type AssemblePredictionReportResult =
  { ok: true; report: PredictionReport; dropped: DroppedEntry[] } | { ok: false; reason: string };

function resolvesAll(resolver: EvidenceRefResolverLike, refs: EvidenceRef[]): boolean {
  return resolver.resolveAll(refs).ok;
}

/**
 * Assemble + validate a PredictionReport under the SPEC §4.2 grounding rules.
 * Deterministic: the same input always yields the same report (modulo ids).
 */
export function assemblePredictionReport(input: AssemblePredictionReportInput): AssemblePredictionReportResult {
  const dropped: DroppedEntry[] = [];
  const log = (entry: DroppedEntry) => {
    dropped.push(entry);
    input.log?.(entry);
  };
  const missingEvidence: string[] = [...(input.missingEvidence ?? [])];

  // Dataset usability, checked once and fail-closed: a dataset whose own ref
  // does not resolve is no dataset at all — no dataset, no probability.
  const dataset = input.calibrationDataset;
  let datasetUsable: boolean | undefined;
  const useDataset = (): boolean => {
    if (datasetUsable !== undefined) return datasetUsable;
    datasetUsable = false;
    if (!dataset) return false;
    if (input.resolver && !resolvesAll(input.resolver, [dataset.ref])) {
      log({
        rule: "uncalibrated-statistical-basis",
        message: `calibration dataset ref ${dataset.ref} does not resolve: probability-bearing predictions cannot be grounded (SPEC §4.2 rule 1, INV-9)`,
      });
      return false;
    }
    datasetUsable = true;
    return true;
  };

  // Rule 2 + rule 1, prediction drafts.
  const predictions: Prediction[] = [];
  for (const source of input.predictions) {
    let draft = source;
    // (a) no evidence, no prediction — basis "unknown" is the exempt honest label.
    if (draft.basis !== "unknown" && draft.evidenceRefs.length === 0) {
      log({
        rule: "prediction-without-evidence",
        message: `dropped prediction on "${draft.subject.slice(0, 120)}": empty evidenceRefs with basis "${draft.basis}" (SPEC §4.2 rule 2)`,
        prediction: draft,
      });
      continue;
    }
    // (b) unresolvable evidence is a contract violation — never forwarded.
    if (input.resolver && draft.evidenceRefs.length > 0 && !resolvesAll(input.resolver, draft.evidenceRefs)) {
      log({
        rule: "unresolvable-evidence",
        message: `dropped prediction on "${draft.subject.slice(0, 120)}": cited evidence does not resolve (SPEC §4.2 rule 2)`,
        prediction: draft,
      });
      continue;
    }
    // (c) INV-9, boundary layer 1: probability ⇒ statistical basis (schema
    // rule enforced at the draft boundary so one bad label cannot poison the
    // report; the assembled report re-validates it fail-closed).
    if (draft.probability !== undefined && draft.basis !== "statistical") {
      log({
        rule: "uncalibrated-statistical-basis",
        message: `dropped probability-bearing prediction on "${draft.subject.slice(0, 120)}": basis "${draft.basis}" is not "statistical" (SPEC §4.2 rule 1, INV-9)`,
        prediction: draft,
      });
      continue;
    }
    // (d) INV-9, boundary layer 2: statistical claims need a covering dataset.
    if (draft.probability !== undefined || draft.basis === "statistical") {
      const usable = useDataset();
      const covered = usable && dataset!.covers(draft.subject);
      if (!covered) {
        const why = !usable
          ? "no usable calibration dataset is configured"
          : `the calibration dataset does not cover this subject`;
        missingEvidence.push(
          `calibration dataset covering subject "${draft.subject.slice(0, 120)}" (SPEC §15.3): ${why}`,
        );
        log({
          rule: "uncalibrated-statistical-basis",
          message: `dropped probability-bearing prediction on "${draft.subject.slice(0, 120)}": ${why} — no dataset, no probability (SPEC §4.2 rule 1, INV-9)`,
          prediction: draft,
        });
        continue;
      }
      // Grounded by construction: the dataset ref is injected into the
      // prediction's evidence — a probability without it would be uncalibrated.
      if (!draft.evidenceRefs.includes(dataset!.ref)) {
        draft = { ...draft, evidenceRefs: [...draft.evidenceRefs, dataset!.ref] };
      }
    }
    predictions.push(draft);
  }

  // Risks obey the same evidence rules.
  const risks: Risk[] = [];
  for (const risk of input.risks) {
    if (risk.evidenceRefs.length === 0) {
      log({
        rule: "risk-without-evidence",
        message: `dropped risk "${risk.riskId}": empty evidenceRefs (SPEC §4.2 rule 2)`,
        risk,
      });
      continue;
    }
    if (input.resolver && !resolvesAll(input.resolver, risk.evidenceRefs)) {
      log({
        rule: "unresolvable-evidence",
        message: `dropped risk "${risk.riskId}": cited evidence does not resolve`,
        risk,
      });
      continue;
    }
    risks.push(risk);
  }

  // Recommendations are advisory (§4.3) but still evidence-bound.
  let recommendations: Recommendation[] = [];
  for (const rec of input.recommendations) {
    if (rec.evidenceRefs.length === 0) {
      log({
        rule: "recommendation-without-evidence",
        message: `dropped ${rec.targetAction} recommendation: empty evidenceRefs (SPEC §4.2 rule 2)`,
        recommendation: rec,
      });
      continue;
    }
    if (input.resolver && !resolvesAll(input.resolver, rec.evidenceRefs)) {
      log({
        rule: "unresolvable-evidence",
        message: `dropped ${rec.targetAction} recommendation: cited evidence does not resolve`,
        recommendation: rec,
      });
      continue;
    }
    recommendations.push(rec);
  }

  // Rule 3 / INV-8: when required evidence is missing, abstain — and a
  // report whose every prediction draft was dropped abstains as well.
  if (input.predictions.length > 0 && predictions.length === 0) {
    missingEvidence.push("no evidence-grounded predictions survived the grounding rules (every draft was dropped)");
  }
  const dedupedMissing = [...new Set(missingEvidence)];
  const abstained: Abstention | undefined =
    dedupedMissing.length > 0
      ? {
          reason: `required evidence is missing (${dedupedMissing.length} item(s)); recommendations are withheld (SPEC §4.2 rule 3, INV-8)`,
          missingEvidence: dedupedMissing,
        }
      : undefined;
  if (abstained) recommendations = [];

  // Uncertainty = declared unknowns ∪ missing evidence — what is NOT known.
  const uncertainty = [...new Set([...(input.uncertainty ?? []), ...(abstained ? abstained.missingEvidence : [])])];

  const candidate: PredictionReport = {
    reportId: newPredictionReportId(),
    missionId: input.missionId,
    basedOnReportId: input.basedOnReportId,
    generatedAt: input.now,
    predictions,
    risks,
    recommendations,
    uncertainty,
    ...(abstained !== undefined ? { abstained } : {}),
    schemaVersion: 1,
  };

  // Fail-closed: a report that does not validate is never returned as a report.
  const parsed = predictionReportSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `assembled prediction report failed schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  return { ok: true, report: parsed.data as PredictionReport, dropped };
}
