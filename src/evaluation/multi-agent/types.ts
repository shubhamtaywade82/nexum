/**
 * MAC v1 P7 — multi-agent evaluation contracts (SPEC §15, TEST-STRATEGY §4–§6).
 *
 * The evaluation framework scores the DETERMINISTIC machinery — the real
 * collectors, contract assemblies, decision re-validation and the mission
 * coordination loop — against seeded fixture inputs with known ground truth.
 * No model, no network, no docker: the suite runs in the nightly CI lane and
 * in `npm test`-compatible form (scripted ports everywhere, exactly the repo's
 * `ScriptedAgentRuntime` / `cases-harness.ts` pattern).
 *
 * Metric shape: every case returns subject COUNTS (never pre-computed ratios)
 * so the aggregate metrics are auditable arithmetic — `metrics.ts` turns the
 * counts into the SPEC §15 metrics, `gates.ts` (PR 7.2) turns the metrics
 * into promotion decisions, and the held-out split keeps a hash-assigned
 * fifth of the cases out of every decision.
 */

/** SPEC §15 evaluation subjects. */
export type MultiAgentSubject = "tracker" | "predictor" | "commander" | "runtime" | "mission";

export const MULTI_AGENT_SUBJECTS: readonly MultiAgentSubject[] = [
  "tracker",
  "predictor",
  "commander",
  "runtime",
  "mission",
];

/** Evidence refs (the shared vocabulary, mirrored from the role planes, SPEC §5.2). */
export type EvidenceRef = `artifact:${string}` | `event:${string}` | `run:${string}` | `checkpoint:${string}`;

// ── Subject counts (raw, aggregated across cases — the metrics' inputs) ────

/** Tracker counts → evidence coverage, observation accuracy, fabrication, staleness. */
export interface TrackerCounts {
  /** Anchored observations entering assembly (denominator of evidence coverage). */
  observationsTotal: number;
  /** Observations whose evidence refs all resolve (numerator of evidence coverage). */
  observationsResolvable: number;
  /** Ground-truth changes across all change-bearing fixtures. */
  changesExpected: number;
  /** Detected changes that match the ground truth (kind + subject). */
  changesDetectedCorrect: number;
  /** Claims with NO ground-truth change — gate: 0. */
  changesFabricated: number;
  /** Clean-repo fixtures where nothing changed. */
  cleanFixtures: number;
  /** Clean fixtures correctly reporting zero changes. */
  cleanFixturesCorrect: number;
  /** Collector failures seeded across fixtures. */
  collectorFailures: number;
  /** Collector failures surfaced as honest blockers (never silence). */
  collectorFailuresAsBlockers: number;
  /** Observations past their freshness bound in the staleness fixture. */
  staleExpired: number;
  /** Expired observations correctly excluded by `freshObservations`. */
  staleDetected: number;
}

/** Predictor counts → risk recall, abstention precision, calibration honesty. */
export interface PredictorCounts {
  /** Ground-truth real risks with evidence available. */
  risksReal: number;
  /** Real risks kept in the assembled report (recall numerator). */
  risksKept: number;
  /** Unreal risks that survived assembly (precision violation). */
  risksFabricatedKept: number;
  /** Fixtures where required evidence is truly insufficient. */
  abstentionsRequired: number;
  /** Correct abstentions (abstained + empty recommendations). */
  abstentionsCorrect: number;
  /** Abstained when evidence WAS sufficient (abstention precision violation). */
  falseAbstentions: number;
  /** Failed to abstain: recommendations emitted with missing evidence (INV-8 violation). */
  missedAbstentions: number;
  /** `probability` fields surviving assembly without a covering dataset — gate: 0. */
  uncalibratedProbabilities: number;
  /** Labeled-outcome records the subject contributed. */
  labelsRecorded: number;
}

/** Commander counts → invalid-DAG rejection, delegation accuracy, recovery. */
export interface CommanderCounts {
  invalidDagSeeded: number;
  invalidDagRejected: number;
  validDecisionsSeeded: number;
  validDecisionsAccepted: number;
  forgedDecisionsSeeded: number;
  forgedDecisionsRejected: number;
  /** Delegations whose constructed request carries the ground-truth capabilities. */
  delegationsAccurate: number;
  delegationsTotal: number;
  recoveriesAttempted: number;
  recoveriesSucceeded: number;
}

/** Shared-runtime counts → budget adherence, escalation, cancellation. */
export interface RuntimeCounts {
  missionsWithBudget: number;
  /** Missions that terminated failed(budget_exhausted) with itemized consumption. */
  budgetTerminationsClean: number;
  cancellationsTotal: number;
  /** Cancellations with no orphaned pending delegation. */
  cancellationsClean: number;
  escalationAttempts: number;
  /** Approval-class actions that resolved without a human — gate: 0. */
  successfulEscalations: number;
}

/** Full-mission counts → verified completion, false success (the north star). */
export interface MissionCounts {
  /** Missions that reached `completed`. */
  missionsCompleted: number;
  /** Completed missions with deterministic verification evidence attached. */
  verifiedCompletions: number;
  /** Completed WITHOUT verification evidence — P0-class defect, gate: 0. */
  falseSuccesses: number;
  /** `complete` claims refused for lack of evidence (the gate working). */
  claimsRefusedWithoutEvidence: number;
}

/** Per-subject count deltas a case reports (merged by the runner). */
export interface CountsDelta {
  tracker?: Partial<TrackerCounts>;
  predictor?: Partial<PredictorCounts>;
  commander?: Partial<CommanderCounts>;
  runtime?: Partial<RuntimeCounts>;
  mission?: Partial<MissionCounts>;
}

export interface SubjectCounts {
  tracker: TrackerCounts;
  predictor: PredictorCounts;
  commander: CommanderCounts;
  runtime: RuntimeCounts;
  mission: MissionCounts;
}

export const EMPTY_COUNTS: SubjectCounts = {
  tracker: {
    observationsTotal: 0,
    observationsResolvable: 0,
    changesExpected: 0,
    changesDetectedCorrect: 0,
    changesFabricated: 0,
    cleanFixtures: 0,
    cleanFixturesCorrect: 0,
    collectorFailures: 0,
    collectorFailuresAsBlockers: 0,
    staleExpired: 0,
    staleDetected: 0,
  },
  predictor: {
    risksReal: 0,
    risksKept: 0,
    risksFabricatedKept: 0,
    abstentionsRequired: 0,
    abstentionsCorrect: 0,
    falseAbstentions: 0,
    missedAbstentions: 0,
    uncalibratedProbabilities: 0,
    labelsRecorded: 0,
  },
  commander: {
    invalidDagSeeded: 0,
    invalidDagRejected: 0,
    validDecisionsSeeded: 0,
    validDecisionsAccepted: 0,
    forgedDecisionsSeeded: 0,
    forgedDecisionsRejected: 0,
    delegationsAccurate: 0,
    delegationsTotal: 0,
    recoveriesAttempted: 0,
    recoveriesSucceeded: 0,
  },
  runtime: {
    missionsWithBudget: 0,
    budgetTerminationsClean: 0,
    cancellationsTotal: 0,
    cancellationsClean: 0,
    escalationAttempts: 0,
    successfulEscalations: 0,
  },
  mission: {
    missionsCompleted: 0,
    verifiedCompletions: 0,
    falseSuccesses: 0,
    claimsRefusedWithoutEvidence: 0,
  },
};

// ── Labeled outcomes (calibration data, SPEC §15.3 / §6 rule 3) ─────────────

/** One predicted-vs-actual record, persisted append-only for calibration. */
export interface LabeledOutcome {
  /** Deterministic id: `<subject>:<caseId>:<slot>` — re-runs do not double-count. */
  labelId: string;
  subject: MultiAgentSubject;
  /** The fixture case that produced the label. */
  caseId: string;
  /** What was predicted (a probability when calibrated, else a boolean claim). */
  predicted: number | boolean;
  /** What actually happened (ground truth or the recorded mission outcome). */
  actual: number | boolean;
  /** Evidence refs to the report artifacts the label derives from. */
  evidenceRefs: string[];
  recordedAt: string;
}

// ── Cases ───────────────────────────────────────────────────────────────────

/** A deterministic evaluation case (SPEC §15 seeded-repo harness). */
export interface MultiAgentCase {
  id: string;
  subject: MultiAgentSubject;
  description: string;
  /** Docker-gated case: runs only under NEXUM_DOCKER_TESTS=1 (sandboxed shell collectors). */
  requiresDocker?: boolean;
  /** Runs the REAL deterministic machinery against seeded inputs. */
  run(): Promise<CaseOutcome>;
}

export interface CaseOutcome {
  caseId: string;
  subject: MultiAgentSubject;
  /** Case-level ground-truth expectation met. */
  pass: boolean;
  details: string;
  counts: CountsDelta;
  /** Calibration records the case contributes. */
  labels: LabeledOutcome[];
}

// ── Report ──────────────────────────────────────────────────────────────────

export interface SubjectReport {
  subject: MultiAgentSubject;
  casesTotal: number;
  casesPassed: number;
  /** Computed metrics (ratios 0..1, plus raw counts where relevant). */
  metrics: Record<string, number>;
  heldOutCases: number;
}

export interface MultiAgentEvalReport {
  datasetVersion: string;
  generatedAt: string;
  heldOutSplitDigest: string;
  subjects: SubjectReport[];
  /** mission_* telemetry counters (the P8 pilot dashboard reads these). */
  counters: Record<string, number>;
  /** Labeled-outcome dataset status per subject (the ≥ 100 rule). */
  calibration: CalibrationStatus[];
  totalCases: number;
  totalPassed: number;
}

export interface CalibrationStatus {
  subject: MultiAgentSubject;
  labeledOutcomes: number;
  /** True iff ≥ 100 labeled outcomes — only then may `probability` be used. */
  datasetUsable: boolean;
  /** Brier score over labeled outcomes (reported, gated only when usable). */
  brier: number | null;
  /** Expected calibration error (15 equal bins). */
  ece: number | null;
}
