/**
 * ExperimentArtifact — the immutable, per-cycle JSON record (v2.3.2).
 *
 * The ExperimentStore (SQLite) is the PROGRESSIVE audit log: rows are
 * upserted as the lifecycle advances, so the database always shows the live
 * state of an experiment. The artifact is the complementary FROZEN snapshot:
 * one JSON file per experiment, written exactly once at the end of a cycle
 * (success or failure), capturing everything needed to inspect the mutation
 * scientifically after the fact:
 *
 *   Experiment H1
 *   ├── target             formed capability target (Aspire layer)
 *   ├── diagnosis          the episode-grounded diagnosis behind the target
 *   ├── hypothesis         id / statement / predicted effect
 *   ├── model              mutation strategy + provider model + tier
 *   ├── executor           executor kind, verification profile + gates
 *   ├── mutation proposals the plan the strategist produced (and rejections)
 *   ├── changed files      candidate commit, branch, diff stat, file list
 *   ├── verification       per-gate command results + scope audits
 *   ├── baseline metrics   B(H0) subprocess benchmark aggregates + raw runs
 *   ├── candidate metrics  B(H1) subprocess benchmark aggregates + raw runs
 *   ├── held-out metrics   held-out split results (when the suite provides them)
 *   ├── transfer metrics   transfer split results (fixed-executor phase)
 *   ├── delivery           local prep and/or GitHub PR/CI/review/merge outcome
 *   ├── CI                 the experiment record's CI status
 *   ├── review             the experiment record's review state
 *   ├── activation         runtime activation outcome (manifest pointer)
 *   └── decision           two-stage verdict + rationale (or stage failure)
 *
 * Immutability contract:
 *   - the file is opened with `wx` — an existing artifact is NEVER overwritten
 *     (a second cycle reuses a new experimentId, so collisions signal a bug);
 *   - the envelope carries a sha256 integrity hash over the canonical payload;
 *   - stage-failure cycles (prepare/implement/verify/finalize/evaluate) are
 *     recorded too — a failed or declined mutation is a scientific result.
 *
 * This module intentionally does NOT import from engine-v2.ts (which imports
 * sibling modules here): the CLI maps cycle outcomes into the structural
 * input below, keeping the dependency graph acyclic.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExperimentRecord } from "./experiment-schema.js";
import {
  CandidateArtifact,
  CodeChangePlan,
  MutationResult,
  MutationVerification,
} from "../mutation/mutation-executor.js";
import { TaskExecutionResult } from "../evaluator.js";
import { ImprovementTarget } from "../targets/target-engine.js";
import { HarnessDiagnosis } from "../types.js";
import { MutationScope } from "../mutation/mutation-scope.js";

export const EXPERIMENT_ARTIFACT_SCHEMA_VERSION = 1;

/** Compact aggregate over one benchmark side (baseline or candidate). */
export interface ExperimentMetricsSummary {
  runs: number;
  taskSuccessRate: number;
  verificationPassRate: number;
  toolErrorRate: number;
  falseSuccessRate: number;
  loopAbortRate: number;
  avgTokens: number;
  avgLatencyMs: number;
  /** Compact per-run rows — the raw evidence behind the aggregates. */
  runsDetail: Array<{
    taskId: string;
    success: boolean;
    verificationPassed: boolean;
    isHeldOut: boolean;
    loopAborted: boolean;
    toolCalls: number;
    toolErrors: number;
    tokens: number;
    latencyMs: number;
  }>;
}

export interface ExperimentArtifactPayload {
  // ── experiment identity ──
  experimentId: string;

  // ── the scientific tree ──
  target: {
    targetId: string;
    capability: string;
    desiredOutcome: string;
    observableSymptoms: string[];
    measurableMetrics: string[];
    affectedComponents: string[];
    confidence: number;
  } | null;
  diagnosis: {
    component: string;
    failureClass: string;
    rootCause: string;
    proposedFix: string;
    confidence: number;
  } | null;
  hypothesis: { id: string; statement: string; predictedEffect: string } | null;
  model: {
    /** "heuristic" | "agent" (the CLI --strategy value). */
    strategy: string;
    /** Provider model that backed the agent runtime (or the benchmark runs). */
    model: string;
    tier: string;
    executorPrimary: string | null;
    executorTransfer: string[];
  };
  executor: {
    kind: string;
    verifyProfile: string;
    verifyCommands: string[][];
  };
  scope: { kind: string; components: string[]; rationale: string } | null;
  proposals: {
    planId: string;
    strategy: string;
    summary: string;
    edits: Array<{ path: string; component: string; rationale: string; bytes: number }>;
    rejectedEdits: Array<{ path: string; reason: string }>;
  } | null;
  changedFiles: {
    commitSha: string;
    branchName: string;
    diffStat: string;
    files: string[];
  } | null;
  verification: {
    ok: boolean;
    scopeRespected: boolean;
    scopeViolations: string[];
    actualDiffViolations: string[];
    actualChangedFiles: string[];
    commands: Array<{ command: string; exitCode: number; outputTail: string }>;
  } | null;
  baselineMetrics: ExperimentMetricsSummary | null;
  candidateMetrics: ExperimentMetricsSummary | null;
  heldOutMetrics: Record<string, number> | null;
  transferMetrics: Record<string, number> | null;
  delivery: {
    /** "github" (PR path) | "local-prep" (eligible, no --github) | "none". */
    mode: "github" | "local-prep" | "none";
    branchName?: string;
    prNumber?: number;
    prUrl?: string;
    ciPassed?: boolean | null;
    accepted?: boolean;
    merged?: boolean;
  };
  ci: { status: string; runUrl?: string } | null;
  review: { state: string; reviewer?: string } | null;
  lifecycle: { state: string; enteredAt: number } | null;
  /**
   * Runtime activation outcome (v2.3.3): the manifest-file controller's
   * switch onto the accepted candidate. ok=false covers honest skips
   * (experiment not ACTIVE) and real failures; null when --activate-runtime
   * was not requested.
   */
  activation: {
    controller: string;
    harnessId: string;
    commitSha: string;
    activatedAt: number;
    ok: boolean;
    error?: string;
    /** False: the manifest pointer is written, but no runtime reads it yet. */
    consumedByRuntime: boolean;
  } | null;
  decision: {
    verdict: "eligible" | "rejected" | "inconclusive" | "failed";
    stageA?: string;
    stageB?: string;
    failedStage?: string;
    rationale: string;
    evaluatedAt: string;
  };

  // ── benchmark provenance ──
  benchmark: {
    categories: string[];
    baselineAbsent: boolean;
    evaluator: string;
  };
}

export interface ExperimentArtifactEnvelope {
  kind: "nexum-experiment-artifact";
  schemaVersion: number;
  experimentId: string;
  createdAt: string;
  integrity: { algorithm: "sha256"; hash: string };
  payload: ExperimentArtifactPayload;
}

/** Everything the CLI knows after one runEvolutionCycle call (either exit). */
export interface ExperimentArtifactInput {
  experimentId: string;
  strategyName: string;
  model: string;
  tier: string;
  verifyProfileName: string;
  benchmarkCategories: string[];
  /** True when the parent baseline was skipped or never benchmarked. */
  baselineAbsent: boolean;
  target: ImprovementTarget | null;
  diagnosis: HarnessDiagnosis | null;
  scope: MutationScope | null;
  /** The persisted experiment record — null when the cycle failed pre-evaluation. */
  record: ExperimentRecord | null;
  /** Partial mutation artifacts (present on both success and failure paths). */
  mutation: {
    plan?: CodeChangePlan;
    result?: MutationResult;
    verification?: MutationVerification;
    artifact?: CandidateArtifact;
  };
  baselineResults: TaskExecutionResult[];
  candidateResults: TaskExecutionResult[];
  /** Canonical GitHub delivery outcome (when the --github path ran). */
  github?: {
    branch: string;
    prNumber: number;
    prUrl: string;
    ciPassed: boolean | null;
    accepted: boolean;
    merged: boolean;
  } | null;
  /** Local delivery preparation (eligible candidate without --github). */
  localDelivery?: { branchName: string; prTitle: string } | null;
  /** Stage failure (the cycle returned ok:false). */
  failure?: { stage: string; reason: string } | null;
  /** Runtime activation outcome (v2.3.3, --activate-runtime); null otherwise. */
  activation?: {
    controller: string;
    harnessId: string;
    commitSha: string;
    activatedAt: number;
    ok: boolean;
    error?: string;
    /** False: the manifest pointer is written, but no runtime reads it yet. */
    consumedByRuntime: boolean;
  } | null;
}

const OUTPUT_TAIL_BYTES = 2000;

/** Aggregates raw benchmark runs into the compact artifact summary. */
export function summarizeExperimentRuns(results: TaskExecutionResult[]): ExperimentMetricsSummary {
  const total = results.length;
  const successes = results.filter((r) => r.success).length;
  const verified = results.filter((r) => r.verificationPassed).length;
  const falseSuccess = results.filter((r) => r.success && !r.verificationPassed).length;
  const loopAborts = results.filter((r) => r.loopAborted).length;
  const toolErrors = results.reduce((acc, r) => acc + r.toolErrors, 0);
  const toolCalls = results.reduce((acc, r) => acc + r.toolCalls, 0);
  const tokens = results.reduce((acc, r) => acc + r.tokens, 0);
  const latency = results.reduce((acc, r) => acc + r.latencyMs, 0);
  return {
    runs: total,
    taskSuccessRate: total === 0 ? 0 : successes / total,
    verificationPassRate: total === 0 ? 0 : verified / total,
    toolErrorRate: toolCalls === 0 ? 0 : toolErrors / toolCalls,
    falseSuccessRate: total === 0 ? 0 : falseSuccess / total,
    loopAbortRate: total === 0 ? 0 : loopAborts / total,
    avgTokens: total === 0 ? 0 : tokens / total,
    avgLatencyMs: total === 0 ? 0 : latency / total,
    runsDetail: results.map((r) => ({
      taskId: r.taskId,
      success: r.success,
      verificationPassed: r.verificationPassed,
      isHeldOut: r.isHeldOut === true,
      loopAborted: r.loopAborted,
      toolCalls: r.toolCalls,
      toolErrors: r.toolErrors,
      tokens: r.tokens,
      latencyMs: r.latencyMs,
    })),
  };
}

function diagnosisSummary(d: HarnessDiagnosis): ExperimentArtifactPayload["diagnosis"] {
  return {
    component: d.component,
    failureClass: d.failureClass,
    rootCause: d.rootCause,
    proposedFix: d.proposedFix,
    confidence: d.confidence,
  };
}

/**
 * Composes the frozen artifact payload from one cycle's inputs. Works for
 * every exit path: full success (record + artifacts present), stage failure
 * (record null, failure set), and declined mutations (failure at stage
 * "implement" with the decline reason).
 */
export function buildExperimentArtifact(input: ExperimentArtifactInput): ExperimentArtifactEnvelope {
  const record = input.record;
  const { plan, result, verification, artifact } = input.mutation;

  const decision: ExperimentArtifactPayload["decision"] = record
    ? {
        verdict: record.decision.result,
        stageA: record.decision.stageA,
        stageB: record.decision.stageB,
        rationale: record.decision.rationale,
        evaluatedAt: new Date().toISOString(),
      }
    : {
        verdict: "failed",
        failedStage: input.failure?.stage ?? "unknown",
        rationale: input.failure?.reason ?? "No experiment record was produced.",
        evaluatedAt: new Date().toISOString(),
      };

  const delivery: ExperimentArtifactPayload["delivery"] = input.github
    ? {
        mode: "github",
        branchName: input.github.branch,
        prNumber: input.github.prNumber,
        prUrl: input.github.prUrl,
        ciPassed: input.github.ciPassed,
        accepted: input.github.accepted,
        merged: input.github.merged,
      }
    : input.localDelivery
      ? { mode: "local-prep", branchName: input.localDelivery.branchName }
      : { mode: "none" };

  const payload: ExperimentArtifactPayload = {
    experimentId: input.experimentId,
    target: input.target
      ? {
          targetId: input.target.id,
          capability: input.target.capability,
          desiredOutcome: input.target.desiredOutcome,
          observableSymptoms: [...input.target.observableSymptoms],
          measurableMetrics: [...input.target.measurableMetrics],
          affectedComponents: [...input.target.affectedComponents],
          confidence: input.target.confidence,
        }
      : null,
    diagnosis: input.diagnosis ? diagnosisSummary(input.diagnosis) : null,
    hypothesis: record?.hypothesis ?? null,
    model: {
      strategy: input.strategyName,
      model: input.model,
      tier: input.tier,
      executorPrimary: record?.executor.primary ?? null,
      executorTransfer: record ? [...record.executor.transfer] : [],
    },
    executor: {
      kind: "git-worktree",
      verifyProfile: input.verifyProfileName,
      verifyCommands: verification ? verification.commands.map((c) => c.command.split(" ")) : [],
    },
    scope: input.scope
      ? { kind: input.scope.kind, components: [...input.scope.components], rationale: input.scope.rationale }
      : null,
    proposals: plan
      ? {
          planId: plan.planId,
          strategy: plan.strategy,
          summary: plan.summary,
          edits: plan.edits.map((e) => ({
            path: e.path,
            component: e.component,
            rationale: e.rationale,
            bytes: Buffer.byteLength(e.content, "utf8"),
          })),
          rejectedEdits: (result?.rejectedEdits ?? []).map((e) => ({ path: e.path, reason: e.reason })),
        }
      : null,
    changedFiles: artifact
      ? {
          commitSha: artifact.commitSha,
          branchName: artifact.branchName,
          diffStat: artifact.diffStat,
          files: [...artifact.changedFiles],
        }
      : null,
    verification: verification
      ? {
          ok: verification.ok,
          scopeRespected: verification.scopeRespected,
          scopeViolations: [...verification.scopeViolations],
          actualDiffViolations: [...verification.actualDiffViolations],
          actualChangedFiles: [...verification.actualChangedFiles],
          commands: verification.commands.map((c) => ({
            command: c.command,
            exitCode: c.exitCode,
            outputTail:
              c.output.length > OUTPUT_TAIL_BYTES ? `...[truncated]\n${c.output.slice(-OUTPUT_TAIL_BYTES)}` : c.output,
          })),
        }
      : null,
    baselineMetrics: input.baselineAbsent ? null : summarizeExperimentRuns(input.baselineResults),
    candidateMetrics: summarizeExperimentRuns(input.candidateResults),
    heldOutMetrics:
      record && Object.keys(record.evaluation.held_out).length > 0 ? { ...record.evaluation.held_out } : null,
    transferMetrics:
      record && Object.keys(record.evaluation.transfer).length > 0 ? { ...record.evaluation.transfer } : null,
    delivery,
    ci: record ? { status: record.ci.status, ...(record.ci.runUrl ? { runUrl: record.ci.runUrl } : {}) } : null,
    review: record
      ? { state: record.review.state, ...(record.review.reviewer ? { reviewer: record.review.reviewer } : {}) }
      : null,
    lifecycle: record ? { state: record.lifecycle.state, enteredAt: record.lifecycle.enteredAt } : null,
    activation: input.activation ?? null,
    decision,
    benchmark: {
      categories: [...input.benchmarkCategories],
      baselineAbsent: input.baselineAbsent,
      evaluator: "subprocess: node tsx src/benchmark/cli.ts --json (cwd = worktree)",
    },
  };

  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return {
    kind: "nexum-experiment-artifact",
    schemaVersion: EXPERIMENT_ARTIFACT_SCHEMA_VERSION,
    experimentId: input.experimentId,
    createdAt: new Date().toISOString(),
    integrity: { algorithm: "sha256", hash },
    payload,
  };
}

/**
 * Writes the artifact as `<dir>/<experimentId>.json`. The write is EXCLUSIVE
 * (`wx`): an existing artifact for the same experiment id is never silently
 * overwritten — a collision is a caller bug and must fail loudly. Returns the
 * written path.
 */
export function writeExperimentArtifact(dir: string, envelope: ExperimentArtifactEnvelope): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${envelope.experimentId}.json`);
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx" });
  return path;
}
