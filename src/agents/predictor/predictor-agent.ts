/**
 * Predictor — MAC v1 role agent (ADR-0001, SPEC §4.2).
 *
 * P1 registered the ROLE (inert, capability-scoped AgentDescriptor). P4
 * (ROADMAP "Predictor agent", issue #82) adds the BEHAVIOR:
 *
 *   - the deterministic contract path: `assess()` takes the lineage
 *     `TrackerReport` plus basis-labeled drafts and assembles a
 *     schema-validated `PredictionReport` under the SPEC §4.2 grounding
 *     rules (`contracts.ts`) — evidence drops, INV-9 calibration gates and
 *     INV-8 abstention are enforced in code, never prompted;
 *   - lineage gate: a stale or absent tracker report makes the predictor
 *     REFUSE to run (SPEC §4.2 rule 4 — `basedOnReportId` must resolve to a
 *     non-stale TrackerReport; the coordinator rejects otherwise);
 *   - semantic-memory read integration for historical patterns: every
 *     `historical-pattern` draft subject is recalled through the read-only
 *     `MemoryRecallPort`, the recall result is anchored as evidence and its
 *     ref attached to the prediction (a `SemanticMemory` satisfies the port
 *     structurally); recall failures are recorded, never silent;
 *   - the tool surface is read-only BY CONSTRUCTION at both SPEC §8.2
 *     enforcement points: mount-time catalog filtering (session/artifact/
 *     memory reads only — the predictor observes nothing the Tracker did
 *     not collect) and `predictorReadOnlyPosture()`, a RulePolicyEngine
 *     denying every mutating/spawning/network tool even if one leaks into
 *     the catalog (defense in depth; asserted in tests, not prompts).
 *
 * Pack scoping (SPEC §8.1 capability matrix row "predictor"; P1 registration):
 *   - history → session search/events/trace + artifact reads (evidence in)
 *   - memory  → memory recall (read-class) — `memory_save` never mounts
 * No filesystem, git or process surface: the predictor reads the repository
 * only through what the Tracker already collected.
 *
 * Layering: src/agents/predictor/** must not import orchestration, ui or
 * domains (tests/architecture/mission-layering.test.ts). Sibling imports
 * (tracker contracts) are dataflow, not control.
 */

import type { AgentDescriptor } from "../../runtime/agent/agent-runtime.js";
import { DefaultToolGateway, type ToolGateway } from "../../tools/gateway/tool-gateway.js";
import { ToolCatalog } from "../../tools/gateway/tool-catalog.js";
import type { ToolDefinition } from "../../core/tools/tool-contract.js";
import type { PolicyDecision, PolicyRequest, PolicyRule } from "../../core/policy/policy-engine.js";
import { RulePolicyEngine } from "../../core/policy/policy-engine.js";
import { withUnattendedPolicy, type UnattendedPolicy } from "../../core/policy/unattended-policy.js";
import { SessionEventsTool, SessionSearchTool, SessionTraceTool } from "../../tools/session-history-tools.js";
import { ArtifactReadTool } from "../../tools/artifact-tools.js";
import { MemoryRecallTool } from "../../tools/memory-tools.js";
import type { SessionQueryService } from "../../session-query/index.js";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { SemanticMemory } from "../../memory/semantic/semantic-memory.js";
import { isReportStale, type TrackerReport } from "../tracker/contracts.js";
import {
  assemblePredictionReport,
  evidenceRefSchema,
  type CalibrationDatasetLike,
  type DroppedEntry,
  type EvidenceRef,
  type EvidenceRefResolverLike,
  type Prediction,
  type PredictionReport,
  type Recommendation,
  type Risk,
} from "./contracts.js";

/** SPEC §4.2 registration block — postures verbatim (P1, unchanged). */
export function predictorDescriptor(): AgentDescriptor {
  return {
    id: "predictor",
    displayName: "Mission Predictor",
    description: "Evidence-grounded risk assessment and forecasting; abstains when evidence is insufficient.",
    defaultCapability: "reasoning",
    defaultStrategy: "react",
    capabilities: ["predict", "risk-assessment", "analysis", "mission-reporting"],
    allowedPackIds: ["history", "memory"],
    allowedPolicies: ["readonly", "restricted"],
    supportedStrategies: ["react"],
  };
}

// ── Read-only enforcement, point 2: policy posture (SPEC §8.2) ──────────────

/**
 * SPEC §8.1 predictor row as a policy rule: reads only. The predictor mounts
 * no process tools at all (unlike the tracker's governed `git_read`), so
 * EVERY process spawn, filesystem/external/financial mutation and network
 * egress is denied. Runs inside RulePolicyEngine's deny-first chain, so no
 * later rule can widen it.
 */
export class PredictorReadOnlyRule implements PolicyRule {
  readonly id = "predictor-read-only";
  readonly description =
    "SPEC §8.1 predictor row: reads only — denies every filesystem/external/financial mutation, every process spawn and all network egress.";

  evaluate(request: PolicyRequest): PolicyDecision | null {
    const tool = request.tool;
    const s = tool.sideEffects;
    const mutating = s.filesystem || s.externalMutation || s.financial || s.network || s.process;
    if (!mutating) return null;
    return {
      allowed: false,
      requireConfirmation: false,
      reason: `predictor is read-only (SPEC §8.1): tool "${tool.id}" can mutate state, spawn processes or reach the network`,
      rule: this.id,
    };
  }
}

/** The predictor's policy engine: deny-first read-only posture. */
export function predictorReadOnlyPosture(): RulePolicyEngine {
  return new RulePolicyEngine({
    rules: [new PredictorReadOnlyRule()],
    requireConfirmationFor: "critical",
  });
}

/**
 * The predictor's unattended grant (review: authorization ≠ approval). Lists
 * exactly the read-class surface the predictor needs — session/artifact
 * history and memory recall. No host process, no network, no mutation.
 */
export const PREDICTOR_UNATTENDED_POLICY: UnattendedPolicy = {
  permittedTools: ["session_search", "session_events", "session_trace", "artifact_read", "memory_recall"],
  maxRisk: "read",
  allowHostProcess: false,
  allowNetwork: false,
  allowExternalMutation: false,
};

// ── Read-only enforcement, point 1: mount-time filtering (SPEC §8.2) ────────

/** Read-class metadata correction for pure-reader tools whose category inference marks them mutating. */
const READ_META = {
  risk: "read" as const,
  sideEffects: { filesystem: false, process: false, network: false, externalMutation: false, financial: false },
  policy: { confirmation: "never" as const },
};

/** What the predictor's catalog is allowed to expose at all (SPEC §8.2 point 1). */
function isPredictorVisibleTool(d: ToolDefinition): boolean {
  const s = d.sideEffects;
  return d.risk === "read" && !s.filesystem && !s.process && !s.network && !s.externalMutation && !s.financial;
}

/**
 * Build the predictor's catalog: read-class tools only — session/artifact
 * history and memory recall, each mounted solely when its backing service is
 * supplied. The constructor-time invariant fails closed if a future entry
 * would expose a mutating tool.
 */
export function predictorReadOnlyCatalog(opts: {
  sessionQuery?: SessionQueryService;
  artifacts?: ArtifactStore;
  memory?: SemanticMemory;
}): ToolCatalog {
  const catalog = new ToolCatalog();

  if (opts.sessionQuery) {
    const query = opts.sessionQuery;
    for (const tool of [new SessionSearchTool(query), new SessionEventsTool(query), new SessionTraceTool(query)]) {
      catalog.registerLegacy(tool, "Memory", READ_META);
    }
  }
  if (opts.artifacts) {
    catalog.registerLegacy(new ArtifactReadTool(opts.artifacts), "Memory", READ_META);
  }
  if (opts.memory) {
    catalog.registerLegacy(new MemoryRecallTool(opts.memory), "Memory", READ_META);
  }

  // Mount invariant (fail-closed): the predictor must never even SEE a
  // mutating tool. A violation is a construction error, not a runtime risk.
  for (const entry of catalog.all()) {
    if (!isPredictorVisibleTool(entry.definition)) {
      throw new Error(
        `predictor read-only mount invariant violated: tool "${entry.definition.id}" (risk "${entry.definition.risk}") is not read-class`,
      );
    }
  }
  return catalog;
}

// ── Deterministic historical-pattern grounding (SPEC §4.2 inputs) ───────────

/** Narrow read-only recall hit — a `MemoryHit` satisfies this structurally. */
export interface MemoryRecallHit {
  id: string;
  text: string;
}

/**
 * The read-only historical-pattern source. `SemanticMemory` satisfies this
 * port structurally (`recall(query)`); tests stub it with fixtures.
 */
export interface MemoryRecallPort {
  recall(query: string): Promise<MemoryRecallHit[]>;
}

/**
 * Persists a recall result set as immutable evidence and returns the
 * citation ref (the mission plane's anchor satisfies this structurally —
 * the predictor plane cannot import orchestration).
 */
export type EvidenceAnchor = (input: { source: string; subject: string; payload: unknown }) => Promise<EvidenceRef>;

/** Audit trail for the deterministic recall pass — failures recorded, never silent. */
export interface RecallOutcome {
  subject: string;
  /** Anchored evidence ref for the recall result set (absent when nothing usable was recalled). */
  ref?: EvidenceRef;
  hits: number;
  /** Failure honesty: a failed recall is recorded here, never smoothed over. */
  error?: string;
}

// ── The agent ───────────────────────────────────────────────────────────────

export interface PredictorAgentOptions {
  /** Read-only historical-pattern source; a `SemanticMemory` satisfies this structurally. */
  recall?: MemoryRecallPort;
  /** Mounts the `memory_recall` tool when supplied (read-class, advisory layer). */
  memory?: SemanticMemory;
  /** Mounts the session history tools when supplied (read-class). */
  sessionQuery?: SessionQueryService;
  /** Mounts the artifact read tool when supplied (read-class). */
  artifacts?: ArtifactStore;
  /** Required for the deterministic recall pass (fail-closed when recall is configured). */
  evidenceAnchor?: EvidenceAnchor;
  /** Resolves evidence refs; unresolvable refs drop their entry (§4.2 rule 2). */
  resolver?: EvidenceRefResolverLike;
  /** The labeled-outcome calibration dataset backing `probability` fields (SPEC §15.3). */
  calibrationDataset?: CalibrationDatasetLike;
  /** Drop log sink; dropped entries are also returned from assess(). */
  log?: (entry: DroppedEntry) => void;
}

/** Basis-labeled assessment drafts (the LLM layer proposes within these shapes in P5). */
export interface PredictionDrafts {
  predictions: Prediction[];
  risks: Risk[];
  recommendations: Recommendation[];
}

export interface PredictorAssessInput {
  missionId: string;
  /** Lineage: the tracker report these predictions derive from. Absent or stale ⇒ refusal (SPEC §4.2 rule 4). */
  trackerReport?: TrackerReport;
  /** Assessment drafts; grounding rules are enforced regardless of who authored them. */
  drafts?: PredictionDrafts;
  /** Required evidence the caller could not gather (drives abstention, INV-8). */
  missingEvidence?: string[];
  /** Declared unknowns (merged into `uncertainty`). */
  uncertainty?: string[];
  /** ISO 8601 assessment time (tests). */
  now?: string;
}

export type PredictorAssessResult =
  | { ok: true; report: PredictionReport; dropped: DroppedEntry[]; recalls: RecallOutcome[] }
  | { ok: false; reason: string };

/**
 * The Predictor's deterministic assessment path: gate the lineage, ground
 * historical patterns through anchored recalls, assemble + validate the
 * PredictionReport. The grounding rules live in `contracts.ts`; this class
 * adds the memory read integration and the lineage refusal.
 */
export class PredictorAgent {
  readonly descriptor: AgentDescriptor;
  /** Read-only tool gateway (mount-filtered catalog + read-only posture). */
  readonly gateway: ToolGateway;

  private readonly recallPort?: MemoryRecallPort;
  private readonly evidenceAnchor?: EvidenceAnchor;
  private readonly resolver?: EvidenceRefResolverLike;
  private readonly calibrationDataset?: CalibrationDatasetLike;
  private readonly log?: (entry: DroppedEntry) => void;

  constructor(opts: PredictorAgentOptions = {}) {
    this.descriptor = predictorDescriptor();
    this.recallPort = opts.recall ?? opts.memory;
    this.evidenceAnchor = opts.evidenceAnchor;
    this.resolver = opts.resolver;
    this.calibrationDataset = opts.calibrationDataset;
    this.log = opts.log;

    this.gateway = new DefaultToolGateway({
      catalog: predictorReadOnlyCatalog({
        ...(opts.sessionQuery !== undefined ? { sessionQuery: opts.sessionQuery } : {}),
        ...(opts.artifacts !== undefined ? { artifacts: opts.artifacts } : {}),
        ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
      }),
      policyEngine: withUnattendedPolicy(predictorReadOnlyPosture(), PREDICTOR_UNATTENDED_POLICY),
      validation: "strict",
      label: "predictor:readonly",
    });
  }

  /**
   * Assess now: refuse a stale/absent lineage, ground historical patterns
   * through anchored recalls, assemble the report under the SPEC §4.2
   * grounding rules. Never throws for expected failure modes — refusals,
   * drops and recall failures are honest outcomes; only contract bugs
   * (schema violations) surface as `{ ok: false }`.
   */
  async assess(input: PredictorAssessInput): Promise<PredictorAssessResult> {
    // Lineage gate (SPEC §4.2 rule 4): absent tracker report ⇒ refusal.
    if (!input.trackerReport) {
      return {
        ok: false,
        reason:
          "no tracker report: predictor refuses to run — basedOnReportId must resolve to a non-stale TrackerReport (SPEC §4.2 rule 4)",
      };
    }
    const nowMs = input.now !== undefined ? Date.parse(input.now) : Date.now();
    if (Number.isNaN(nowMs)) {
      return { ok: false, reason: `invalid clock input: ${String(input.now)}` };
    }
    const now = new Date(nowMs).toISOString();

    // Lineage gate (SPEC §4.2 rule 4): stale tracker report ⇒ refusal;
    // re-observation comes before any prediction depends on it.
    if (isReportStale(input.trackerReport, now)) {
      return {
        ok: false,
        reason: `tracker report ${input.trackerReport.reportId} is stale as of ${now}: re-observe before predicting (SPEC §4.2 rule 4)`,
      };
    }

    const drafts: PredictionDrafts = input.drafts ?? { predictions: [], risks: [], recommendations: [] };
    const recallSubjects = [
      ...new Set(drafts.predictions.filter((p) => p.basis === "historical-pattern").map((p) => p.subject)),
    ];

    // Fail-closed wiring check: a configured recall source without an anchor
    // could never ground a historical pattern in resolvable evidence.
    if (recallSubjects.length > 0 && this.recallPort && !this.evidenceAnchor) {
      return {
        ok: false,
        reason:
          "recall source configured without an evidence anchor: recalled historical patterns could not carry resolvable evidence (SPEC §4.2, fail-closed)",
      };
    }

    // Deterministic historical-pattern grounding: recall, anchor, cite.
    const recalls: RecallOutcome[] = [];
    const recallRefs = new Map<string, EvidenceRef>();
    const autoMissing: string[] = [];
    for (const subject of recallSubjects) {
      const outcome = await this.groundHistoricalPattern(subject);
      recalls.push(outcome);
      if (outcome.ref) recallRefs.set(subject, outcome.ref);
      if (outcome.error) {
        // Failure honesty: a failed recall is missing evidence, never silence.
        autoMissing.push(`historical recall for subject "${subject}" failed: ${outcome.error}`);
      }
    }
    const predictions = drafts.predictions.map((p) =>
      p.basis === "historical-pattern" && recallRefs.has(p.subject)
        ? { ...p, evidenceRefs: [...new Set([...p.evidenceRefs, recallRefs.get(p.subject)!])] }
        : p,
    );

    const assembled = assemblePredictionReport({
      missionId: input.missionId,
      basedOnReportId: input.trackerReport.reportId,
      now,
      predictions,
      risks: drafts.risks,
      recommendations: drafts.recommendations,
      missingEvidence: [...(input.missingEvidence ?? []), ...autoMissing],
      ...(input.uncertainty !== undefined ? { uncertainty: input.uncertainty } : {}),
      ...(this.resolver !== undefined ? { resolver: this.resolver } : {}),
      ...(this.calibrationDataset !== undefined ? { calibrationDataset: this.calibrationDataset } : {}),
      ...(this.log !== undefined ? { log: this.log } : {}),
    });
    if (!assembled.ok) return { ok: false, reason: assembled.reason };
    return { ok: true, report: assembled.report, dropped: assembled.dropped, recalls };
  }

  /**
   * Recall a subject's historical patterns and anchor the result set as
   * evidence. Zero hits is an honest empty recall (no ref, no error); a
   * failed recall is recorded with its error — never silence.
   */
  private async groundHistoricalPattern(subject: string): Promise<RecallOutcome> {
    if (!this.recallPort || !this.evidenceAnchor) return { subject, hits: 0 };
    let hits: MemoryRecallHit[];
    try {
      hits = await this.recallPort.recall(subject);
    } catch (err) {
      return { subject, hits: 0, error: err instanceof Error ? err.message : String(err) };
    }
    if (hits.length === 0) return { subject, hits: 0 };
    try {
      const ref = await this.evidenceAnchor({ source: "memory-recall", subject, payload: { subject, hits } });
      const parsed = evidenceRefSchema.safeParse(ref);
      if (!parsed.success) {
        return {
          subject,
          hits: hits.length,
          error: `anchor returned a malformed evidence ref: ${JSON.stringify(ref)}`,
        };
      }
      return { subject, hits: hits.length, ref: parsed.data };
    } catch (err) {
      return { subject, hits: hits.length, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
