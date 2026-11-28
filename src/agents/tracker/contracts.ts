/**
 * Tracker contracts (SPEC §4.1) — MAC v1 P3.
 *
 * The observation/report contract lives NEXT TO ITS OWNER (SPEC §16: role
 * contracts in `src/agents/<name>/contracts.ts`). The `EvidenceRef` union mirrors
 * `src/orchestration/mission/events.ts` structurally — the two planes must
 * not import each other (tests/architecture/mission-layering.test.ts), so
 * the shared vocabulary is declared on both sides and stays assignable.
 *
 * This module ENFORCES the SPEC §4.1 grounding rules at the contract layer:
 *
 *   1. Deterministic collectors first — the assembly below only accepts
 *      collector-produced drafts; there is no API to add a free-form claim.
 *   2. No evidence, no observation — observations with empty `evidenceRefs`
 *      are dropped and logged; an observation citing evidence that does not
 *      resolve is dropped AND surfaced as a `contradictory-evidence` blocker.
 *   3. Freshness — `staleAfter` bounds reuse (`isReportStale`).
 *   4. Failure honesty — collector failures become `Blocker`s, never silence.
 *
 * Layering: src/agents/tracker/** imports runtime/core contracts only — no
 * orchestration, ui or domains (ROADMAP P0 invariant).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

// ── Evidence refs (SPEC §4.1 output contract, verbatim families) ────────────

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

// ── Observation / DetectedChange / Blocker (SPEC §4.1, verbatim shapes) ─────

export type ObservationKind = "repository" | "tests" | "ci" | "agent-trace" | "task-status" | "resources";

export interface Observation {
  kind: ObservationKind;
  /** ≤ 500 chars, factual. */
  summary: string;
  /** Structured detail, ≤ 8 KiB. */
  detail?: string;
  /** MUST be non-empty (validated) — SPEC §4.1 grounding rule 2. */
  evidenceRefs: EvidenceRef[];
  observedAt: string; // ISO 8601
  /** ISO 8601 — freshness bound (grounding rule 3). */
  staleAfter?: string;
}

export type DetectedChangeKind = "code" | "test" | "config" | "docs" | "ci" | "environment";

export interface DetectedChange {
  kind: DetectedChangeKind;
  /** Path, ref, workflow id, ... */
  subject: string;
  before?: string;
  after?: string;
  evidenceRefs: EvidenceRef[];
}

export type BlockerKind =
  | "permission-denied"
  | "tool-failure"
  | "missing-dependency"
  | "timeout"
  | "external-unavailable"
  | "contradictory-evidence";

export interface Blocker {
  kind: BlockerKind;
  description: string;
  evidenceRefs: EvidenceRef[];
  suggestedUnblock?: string;
}

export type TrackerHealth = "healthy" | "degraded" | "blocked";

export interface TrackerReport {
  reportId: string; // `tr_` + uuid
  missionId: string;
  timestamp: string;
  /** May be empty only with a health explanation (healthRationale). */
  observations: Observation[];
  detectedChanges: DetectedChange[];
  blockers: Blocker[];
  health: TrackerHealth;
  /** Required when health !== "healthy". */
  healthRationale: string;
  /** Report-level evidence — superset union of every observation/change/blocker ref. */
  evidenceRefs: EvidenceRef[];
  schemaVersion: 1;
}

// ── Zod schemas (fail-closed: the report must validate before publication) ──

export const observationSchema = z
  .object({
    kind: z.enum(["repository", "tests", "ci", "agent-trace", "task-status", "resources"]),
    summary: z.string().min(1).max(500),
    detail: z.string().max(8_192).optional(),
    evidenceRefs: z.array(evidenceRefSchema).min(1),
    observedAt: isoTimestamp,
    staleAfter: isoTimestamp.optional(),
  })
  .strict();

export const detectedChangeSchema = z
  .object({
    kind: z.enum(["code", "test", "config", "docs", "ci", "environment"]),
    subject: z.string().min(1).max(2_000),
    before: z.string().max(2_000).optional(),
    after: z.string().max(2_000).optional(),
    evidenceRefs: z.array(evidenceRefSchema).min(1),
  })
  .strict();

export const blockerSchema = z
  .object({
    kind: z.enum([
      "permission-denied",
      "tool-failure",
      "missing-dependency",
      "timeout",
      "external-unavailable",
      "contradictory-evidence",
    ]),
    description: z.string().min(1).max(2_000),
    evidenceRefs: z.array(evidenceRefSchema),
    suggestedUnblock: z.string().max(2_000).optional(),
  })
  .strict();

export const trackerReportSchema = z
  .object({
    reportId: z.string().regex(/^tr_/),
    missionId: z.string().min(1),
    timestamp: isoTimestamp,
    observations: z.array(observationSchema),
    detectedChanges: z.array(detectedChangeSchema),
    blockers: z.array(blockerSchema),
    health: z.enum(["healthy", "degraded", "blocked"]),
    healthRationale: z.string().max(2_000).optional(),
    evidenceRefs: z.array(evidenceRefSchema),
    schemaVersion: z.literal(1),
  })
  .strict()
  .refine((report) => report.health === "healthy" || (report.healthRationale ?? "").length > 0, {
    message: "healthRationale is required when health is not healthy",
  });

export function newTrackerReportId(): string {
  return `tr_${randomUUID()}`;
}

// ── Structural resolver port ────────────────────────────────────────────────
/**
 * Evidence resolution is supplied by the caller (the mission plane's
 * `EvidenceResolver` satisfies this structurally — the tracker plane cannot
 * import orchestration). Without a resolver, refs are checked for
 * non-emptiness only; resolvability is then the coordinator's contract.
 */
export interface EvidenceRefResolution {
  ok: boolean;
  ref: EvidenceRef;
  violation?: string;
}

export interface EvidenceRefResolverLike {
  resolveAll(refs: EvidenceRef[]): { ok: boolean; resolutions: EvidenceRefResolution[] };
}

// ── Grounding-rule assembly (SPEC §4.1 rules 2–4, enforced) ─────────────────

export type DropRule = "no-evidence-no-observation" | "unresolvable-evidence" | "change-without-evidence";

export interface DroppedEntry {
  rule: DropRule;
  message: string;
  /** The dropped observation/change when one existed (audit trail). */
  observation?: Observation;
  change?: DetectedChange;
}

export interface AssembleTrackerReportInput {
  missionId: string;
  /** Anchored observations produced by deterministic collectors. */
  observations: Observation[];
  detectedChanges: DetectedChange[];
  /** Collector failures — already honest blockers (one per failure). */
  blockers: Blocker[];
  /** ISO 8601 assembly time. */
  now: string;
  /** Optional evidence resolver; unresolvable refs drop their observation. */
  resolver?: EvidenceRefResolverLike;
  /** Drop log sink; entries are also returned in the result (never silent). */
  log?: (entry: DroppedEntry) => void;
}

export type AssembleTrackerReportResult =
  { ok: true; report: TrackerReport; dropped: DroppedEntry[] } | { ok: false; reason: string };

/**
 * Assemble + validate a TrackerReport under the SPEC §4.1 grounding rules.
 * Deterministic: the same input always yields the same report (modulo ids).
 */
export function assembleTrackerReport(input: AssembleTrackerReportInput): AssembleTrackerReportResult {
  const dropped: DroppedEntry[] = [];
  const log = (entry: DroppedEntry) => {
    dropped.push(entry);
    input.log?.(entry);
  };

  // Rule 2a: no evidence, no observation.
  const evidenceBearing = input.observations.filter((o) => o.evidenceRefs.length > 0);
  for (const o of input.observations) {
    if (o.evidenceRefs.length === 0) {
      log({
        rule: "no-evidence-no-observation",
        message: `dropped ${o.kind} observation "${o.summary.slice(0, 120)}": empty evidenceRefs (SPEC §4.1 rule 2)`,
        observation: o,
      });
    }
  }

  // Rule 2b: unresolvable evidence is a contract violation, surfaced as a
  // `contradictory-evidence` blocker — never forwarded as an observation.
  const blockers: Blocker[] = [...input.blockers];
  const observations: Observation[] = [];
  for (const o of evidenceBearing) {
    if (input.resolver) {
      const resolution = input.resolver.resolveAll(o.evidenceRefs);
      if (!resolution.ok) {
        const violation = resolution.resolutions.find((r) => !r.ok)?.violation ?? "unresolvable evidence";
        log({
          rule: "unresolvable-evidence",
          message: `dropped ${o.kind} observation "${o.summary.slice(0, 120)}": ${violation}`,
          observation: o,
        });
        blockers.push({
          kind: "contradictory-evidence",
          description: `observation "${o.summary.slice(0, 200)}" cites evidence that does not resolve: ${violation}`,
          evidenceRefs: [], // citing the dead refs here would cite evidence we know is broken
        });
        continue;
      }
    }
    observations.push(o);
  }

  // Detected changes obey the same rule.
  const detectedChanges: DetectedChange[] = [];
  for (const c of input.detectedChanges) {
    if (c.evidenceRefs.length === 0) {
      log({
        rule: "change-without-evidence",
        message: `dropped ${c.kind} change "${c.subject.slice(0, 120)}": empty evidenceRefs`,
        change: c,
      });
      continue;
    }
    detectedChanges.push(c);
  }

  // Health derivation (SPEC §4.1 failure behavior + issue #81 scenarios):
  //   no usable observations        → blocked (the coordinator may not proceed)
  //   observations with blockers    → degraded
  //   observations without blockers → healthy
  const health: TrackerHealth = observations.length === 0 ? "blocked" : blockers.length > 0 ? "degraded" : "healthy";
  const kinds = [...new Set(blockers.map((b) => b.kind))];
  const healthRationale =
    health === "healthy"
      ? `all collectors succeeded; ${observations.length} observation(s)`
      : health === "degraded"
        ? `${observations.length} observation(s) collected with ${blockers.length} blocker(s) [${kinds.join(", ")}]`
        : observations.length === 0 && blockers.length > 0
          ? `no usable observations: ${blockers.length} blocker(s) [${kinds.join(", ")}]`
          : "no observations were collected";

  // Report-level evidence: superset union (SPEC §4.1), deduped, order-stable.
  const evidenceRefs: EvidenceRef[] = [];
  for (const ref of [
    ...observations.flatMap((o) => o.evidenceRefs),
    ...detectedChanges.flatMap((c) => c.evidenceRefs),
    ...blockers.flatMap((b) => b.evidenceRefs),
  ]) {
    if (!evidenceRefs.includes(ref)) evidenceRefs.push(ref);
  }

  const candidate: TrackerReport = {
    reportId: newTrackerReportId(),
    missionId: input.missionId,
    timestamp: input.now,
    observations,
    detectedChanges,
    blockers,
    health,
    healthRationale,
    evidenceRefs,
    schemaVersion: 1,
  };

  // Fail-closed: a report that does not validate is never returned as a report.
  const parsed = trackerReportSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `assembled tracker report failed schema: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  return { ok: true, report: parsed.data as TrackerReport, dropped };
}

// ── Freshness (SPEC §4.1 grounding rule 3) ──────────────────────────────────

/**
 * Observations still inside their `staleAfter` bound. Observations without a
 * `staleAfter` never expire (the collector declined to bound them); a report
 * with no observation is never "fresh" — there is nothing to reuse.
 */
export function freshObservations(report: TrackerReport, now: Date | string): Observation[] {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (Number.isNaN(nowMs)) throw new Error(`invalid freshness clock: ${String(now)}`);
  return report.observations.filter((o) => !o.staleAfter || Date.parse(o.staleAfter) >= nowMs);
}

/**
 * Consumer-side freshness gate: a report may be reused only while at least
 * one of its observations is still fresh; expired reports force
 * re-observation before decisions depend on them (SPEC §4.1 rule 3).
 */
export function isReportStale(report: TrackerReport, now: Date | string): boolean {
  return freshObservations(report, now).length === 0;
}
