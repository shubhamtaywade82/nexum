/**
 * MAC v1 mission event contracts (SPEC §5.1) — P2.
 *
 * Mission events ride the EXISTING EventEnvelope
 * (src/core/events/envelope.ts): id, per-run seq, full id chain. This module
 * adds only a mission-scoped payload union and `missionId` in the payload —
 * no new bus, no broker, no second envelope type.
 *
 * Publishing goes through the standard EventSink used by the executing
 * context, so events fan out live to the TUI store AND persist through the
 * RunRecorder into `.nexum/runs` (dual path, same as
 * DefaultAgentRuntime.execute).
 *
 * Validation posture (fail-closed):
 *   - writes are STRICT: a mission event must validate before publish;
 *     malformed events are dropped and the drop is recorded (never silent).
 *   - reads are TOLERANT of unknown fields: forward compatibility for
 *     replayed histories written by newer versions.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

// ── Evidence refs (SPEC §4.1 / §5.2) ────────────────────────────────────────

export type EvidenceRef =
  | `artifact:${string}` // immutable artifact id
  | `event:${string}` // EventEnvelope id
  | `run:${string}` // recorded run id
  | `checkpoint:${string}`; // mission checkpoint id

export const evidenceRefSchema = z.string().refine((v) => /^(artifact|event|run|checkpoint):.+/.test(v), {
  message: "evidence ref must be artifact:|event:|run:|checkpoint: prefixed",
}) as z.ZodType<EvidenceRef>;

// ── Report refs (SPEC §5.2 — reference-passing rule) ───────────────────────
// Agents exchange references, never full transcripts. Enough to route and
// summarize; full payloads live in the artifact store and are read on demand.

export interface TrackerReportRef {
  reportId: string; // `tr_` + uuid
  artifactId: string; // `ma_` + uuid
  health: "healthy" | "degraded" | "blocked";
  observationCount: number;
  blockerCount: number;
}

export interface PredictionReportRef {
  reportId: string; // `pr_` + uuid
  artifactId: string;
  /** Present when the predictor abstained; the report itself explains why. */
  abstained?: boolean;
  riskCount: number;
}

export interface CommanderDecisionRef {
  decisionId: string; // `cd_` + uuid
  artifactId: string;
  /** "propose" | "execute-direct" — the coordinator validates before acting. */
  kind: string;
}

// ── Payload schemas (zod, strict on write) ─────────────────────────────────

export const missionIntentSchema = z
  .object({
    missionId: z.string().min(1),
    objective: z.string().min(1).max(2_000),
    constraints: z.array(z.string()).default([]),
    autonomyProfile: z.string().default("standard"),
  })
  .strict();

export type MissionIntent = z.infer<typeof missionIntentSchema>;

export const trackerReportRefSchema = z
  .object({
    reportId: z.string().regex(/^tr_/),
    artifactId: z.string().regex(/^ma_/),
    health: z.enum(["healthy", "degraded", "blocked"]),
    observationCount: z.number().int().nonnegative(),
    blockerCount: z.number().int().nonnegative(),
  })
  .strict();

export const predictionReportRefSchema = z
  .object({
    reportId: z.string().regex(/^pr_/),
    artifactId: z.string().regex(/^ma_/),
    abstained: z.boolean().optional(),
    riskCount: z.number().int().nonnegative(),
  })
  .strict();

export const commanderDecisionRefSchema = z
  .object({
    decisionId: z.string().regex(/^cd_/),
    artifactId: z.string().regex(/^ma_/),
    kind: z.string().min(1),
  })
  .strict();

export const decisionRejectionSchema = z
  .object({
    decisionId: z.string(),
    reason: z.string().min(1),
    /** Which validation failed: policy | budget | dag | profile | schema. */
    gate: z.enum(["policy", "budget", "dag", "profile", "schema"]),
  })
  .strict();

export const delegationLinkSchema = z
  .object({
    delegateId: z.string(),
    targetAgentId: z.string(),
    requiredCapabilities: z.array(z.string()),
    contextHandoff: z.string().max(32_768), // SPEC §5.2: capped by mission policy
    evidenceRefs: z.array(evidenceRefSchema),
  })
  .strict();

export const verificationVerdictSchema = z
  .object({
    gate: z.string().min(1),
    passed: z.boolean(),
    summary: z.string().min(1).max(2_000),
    evidenceRefs: z.array(evidenceRefSchema),
  })
  .strict();

export const replanRecordSchema = z
  .object({
    replanId: z.string(),
    trigger: z.enum(["verification-failed", "blocked", "budget-exhausted", "rejection"]),
    rationale: z.string().min(1).max(2_000),
    evidenceRefs: z.array(evidenceRefSchema),
  })
  .strict();

export const approvalRecordSchema = z
  .object({
    approvalId: z.string(),
    subject: z.string().min(1).max(2_000),
    /** The posture that triggered the approval (e.g. "restricted"). */
    posture: z.string(),
    resolvedAs: z.enum(["pending", "approved", "denied"]).default("pending"),
  })
  .strict();

export const checkpointRefSchema = z
  .object({
    checkpointId: z.string(),
    label: z.string().max(500),
    artifactIds: z.array(z.string()),
  })
  .strict();

export const phaseTransitionSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    reason: z.string().max(2_000).default(""),
  })
  .strict();

export const missionTerminationSchema = z
  .object({
    outcome: z.enum(["completed", "failed", "aborted", "cancelled"]),
    summary: z.string().max(4_000).default(""),
    evidenceRefs: z.array(evidenceRefSchema).default([]),
  })
  .strict();

// ── Mission event union (SPEC §5.1) ────────────────────────────────────────

export interface MissionEventBase {
  /** Discriminator — matches the envelope's eventType column. */
  type: string;
  missionId: string;
  agentId: "tracker" | "predictor" | "commander" | "coordinator" | string;
  /** Immutable evidence references; non-empty on report/decision events. */
  evidenceRefs?: EvidenceRef[];
  /** Satisfies KernelEvent's index signature (structural assignability to EventSink). */
  [field: string]: unknown;
}

export type MissionEvent =
  | (MissionEventBase & { type: "mission.created"; payload: MissionIntent })
  | (MissionEventBase & { type: "mission.activated" | "mission.single_agent_fallback" })
  | (MissionEventBase & { type: "tracker.report"; payload: TrackerReportRef })
  | (MissionEventBase & { type: "prediction.report"; payload: PredictionReportRef })
  | (MissionEventBase & { type: "commander.decision"; payload: CommanderDecisionRef })
  | (MissionEventBase & { type: "commander.decision.rejected"; payload: z.infer<typeof decisionRejectionSchema> })
  | (MissionEventBase & { type: "mission.delegation"; payload: z.infer<typeof delegationLinkSchema> })
  | (MissionEventBase & { type: "mission.verification"; payload: z.infer<typeof verificationVerdictSchema> })
  | (MissionEventBase & { type: "mission.replan"; payload: z.infer<typeof replanRecordSchema> })
  | (MissionEventBase & {
      type: "mission.approval.requested" | "mission.approval.resolved";
      payload: z.infer<typeof approvalRecordSchema>;
    })
  | (MissionEventBase & { type: "mission.checkpoint"; payload: z.infer<typeof checkpointRefSchema> })
  | (MissionEventBase & { type: "mission.phase"; payload: z.infer<typeof phaseTransitionSchema> })
  | (MissionEventBase & {
      type: "mission.completed" | "mission.failed" | "mission.aborted" | "mission.cancelled";
      payload: z.infer<typeof missionTerminationSchema>;
    });

/** All mission event discriminators (single source of truth). */
export const MISSION_EVENT_TYPES = [
  "mission.created",
  "mission.activated",
  "mission.single_agent_fallback",
  "tracker.report",
  "prediction.report",
  "commander.decision",
  "commander.decision.rejected",
  "mission.delegation",
  "mission.verification",
  "mission.replan",
  "mission.approval.requested",
  "mission.approval.resolved",
  "mission.checkpoint",
  "mission.phase",
  "mission.completed",
  "mission.failed",
  "mission.aborted",
  "mission.cancelled",
] as const;

export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];

/** Payload schema per event type (strict: unknown fields rejected on write). */
export const missionPayloadSchemas: Record<MissionEventType, z.ZodTypeAny | null> = {
  "mission.created": missionIntentSchema,
  "mission.activated": null, // no payload
  "mission.single_agent_fallback": null,
  "tracker.report": trackerReportRefSchema,
  "prediction.report": predictionReportRefSchema,
  "commander.decision": commanderDecisionRefSchema,
  "commander.decision.rejected": decisionRejectionSchema,
  "mission.delegation": delegationLinkSchema,
  "mission.verification": verificationVerdictSchema,
  "mission.replan": replanRecordSchema,
  "mission.approval.requested": approvalRecordSchema,
  "mission.approval.resolved": approvalRecordSchema,
  "mission.checkpoint": checkpointRefSchema,
  "mission.phase": phaseTransitionSchema,
  "mission.completed": missionTerminationSchema,
  "mission.failed": missionTerminationSchema,
  "mission.aborted": missionTerminationSchema,
  "mission.cancelled": missionTerminationSchema,
};

const baseSchema = z
  .object({
    type: z.string().min(1),
    missionId: z.string().min(1),
    agentId: z.string().min(1),
    /** Payload itself is validated per-type below (shape depends on `type`). */
    payload: z.unknown().optional(),
    evidenceRefs: z.array(evidenceRefSchema).optional(),
  })
  .strict();

/** Report/decision events MUST carry non-empty evidence (SPEC §5.1, INV-10). */
const EVIDENCE_REQUIRED = new Set<MissionEventType>([
  "tracker.report",
  "prediction.report",
  "commander.decision",
  "mission.verification",
]);

export interface MissionEventValidation {
  valid: boolean;
  /** Human-readable drop reason when invalid (never silent). */
  reason?: string;
}

/** Strict write validation: fail-closed, reason recorded. */
export function validateMissionEvent(event: unknown): MissionEventValidation {
  const base = baseSchema.safeParse(event);
  if (!base.success) {
    return { valid: false, reason: `base contract: ${base.error.issues[0]?.message ?? "invalid"}` };
  }
  const { type, evidenceRefs } = base.data;
  if (!(type in missionPayloadSchemas)) {
    return { valid: false, reason: `unknown mission event type "${type}"` };
  }
  const payloadSchema = missionPayloadSchemas[type as MissionEventType];
  const candidate = event as { payload?: unknown };
  if (payloadSchema) {
    const payload = payloadSchema.safeParse(candidate.payload);
    if (!payload.success) {
      return { valid: false, reason: `payload for ${type}: ${payload.error.issues[0]?.message ?? "invalid"}` };
    }
  }
  if (EVIDENCE_REQUIRED.has(type as MissionEventType) && (!evidenceRefs || evidenceRefs.length === 0)) {
    return { valid: false, reason: `${type} requires non-empty evidenceRefs (INV-10: no unevidenced reports)` };
  }
  return { valid: true };
}

/** Tolerant read: known fields validated, unknown fields preserved (replay compat). */
export function isMissionEvent(value: unknown): value is MissionEvent {
  return validateMissionEvent(value).valid;
}

/** Fresh mission event factory (ids follow the repo's prefixed-uuid idiom). */
export function newMissionEventId(): string {
  return `mev_${randomUUID()}`;
}
