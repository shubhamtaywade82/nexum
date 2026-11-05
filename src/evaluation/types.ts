/**
 * Evaluation framework contracts.
 *
 * The benchmark harness scores MODELS (JSON validity, tool-call format).
 * This framework scores AGENT RUNS: a Scenario declares what a correct
 * trajectory looks like, a harness executes it, Evaluators produce Metrics,
 * thresholds + regression policies turn metric streams into pass/fail gates.
 *
 *   EvaluationDataset
 *     └─ Scenario (task + expectations)
 *          ↓ AgentHarness.run(scenario)
 *     TrajectoryObservation (status, output, tool calls, model calls, usage)
 *          ↓ EvaluatorRegistry (RuleEvaluator + JudgeEvaluator + custom)
 *     MetricResult[]
 *          ↓ thresholds + regression policy (vs baseline report)
 *     EvaluationReport (pass/fail + per-scenario detail)
 */

import type { TaskSpec } from "../core/types.js";

// ── Scenarios & datasets ────────────────────────────────────────────────────

export interface ExpectedToolCall {
  /** Canonical tool name (aliases are resolved by the gateway). */
  name: string;
  /** The invocation's args must contain this subset (deep match). */
  argsContains?: Record<string, unknown>;
  /** When false, the call is counted but not required (default true). */
  required?: boolean;
}

export interface ScenarioExpectation {
  /** Expected terminal status (default "completed"). */
  status?: string;
  /** Substrings the final output must contain (all of them). */
  finalOutputContains?: string[];
  /** Tool calls the trajectory should include. */
  toolCalls?: ExpectedToolCall[];
  /** Tools the trajectory must never call. */
  forbiddenTools?: string[];
  /** Upper bound on strategy turns. */
  maxTurns?: number;
  /** Upper bound on total tool calls. */
  maxToolCalls?: number;
  /** Upper bound on wall-clock latency (ms). */
  maxLatencyMs?: number;
  /** Upper bound on total tokens consumed. */
  maxTokens?: number;
  /** LLM-judge rubric applied to the final output (needs a judge evaluator). */
  rubricId?: string;
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  task: TaskSpec;
  expected: ScenarioExpectation;
  metadata?: Record<string, unknown>;
}

export interface EvaluationDataset {
  id: string;
  name: string;
  scenarios: Scenario[];
}

export function defineDataset(dataset: EvaluationDataset): EvaluationDataset {
  if (!dataset.id || !dataset.name) throw new Error("dataset requires id and name");
  const ids = new Set<string>();
  for (const scenario of dataset.scenarios) {
    if (!scenario.id || !scenario.task?.goal) {
      throw new Error(`dataset "${dataset.id}" has a scenario without id/task.goal`);
    }
    if (ids.has(scenario.id)) throw new Error(`duplicate scenario id "${scenario.id}" in dataset "${dataset.id}"`);
    ids.add(scenario.id);
  }
  return dataset;
}

// ── Observations (what actually happened) ──────────────────────────────────

export interface ObservedToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface ObservedModelCall {
  model: string;
  tier?: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs?: number;
}

export interface TrajectoryObservation {
  scenarioId: string;
  runId: string;
  agentId: string;
  status: string;
  output: string;
  turns: number;
  toolCalls: ObservedToolCall[];
  modelCalls: ObservedModelCall[];
  startedAt: number;
  elapsedMs: number;
  totalTokens: number;
  costUsd?: number;
  error?: string;
}

// ── Metrics, evaluators, results ────────────────────────────────────────────

/** One measured value. `pass: null` marks informational metrics (no gate). */
export interface MetricResult {
  metricId: string;
  /** Normalized 0..1 (higher is better) for gated metrics; raw otherwise. */
  value: number;
  /** Raw value before normalization, when meaningful. */
  raw?: number;
  unit?: string;
  pass: boolean | null;
  details?: string;
}

export interface Evaluator {
  id: string;
  evaluate(scenario: Scenario, observation: TrajectoryObservation): Promise<MetricResult[]>;
}

export interface Threshold {
  /** Dataset-level gate applied to a metric across all scenarios. */
  metricId: string;
  /** Minimum average value (0..1). */
  min?: number;
  /** Maximum average value (raw metrics). */
  max?: number;
}

export interface ScenarioResult {
  scenarioId: string;
  pass: boolean;
  metrics: MetricResult[];
  observation: TrajectoryObservation;
  error?: string;
}

export interface EvaluationReport {
  datasetId: string;
  datasetName: string;
  runAt: string;
  results: ScenarioResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    passRate: number;
    metricAverages: Record<string, number>;
  };
  pass: boolean;
}

// ── Regression gating ───────────────────────────────────────────────────────

export interface RegressionRule {
  metricId: string;
  /** Maximum allowed drop in the dataset-wide average (default 0). */
  maxRegression: number;
}

export interface RegressionPolicy {
  rules: RegressionRule[];
  /** "fail" flips report pass to false; "warn" only reports (default "fail"). */
  mode?: "fail" | "warn";
}

export interface RegressionFinding {
  metricId: string;
  baseline: number;
  current: number;
  delta: number;
  maxRegression: number;
}

export interface RegressionResult {
  regressions: RegressionFinding[];
  pass: boolean;
  mode: "fail" | "warn";
}

/** Compare a current report against a baseline under a regression policy. */
export function compareReports(
  baseline: EvaluationReport,
  current: EvaluationReport,
  policy: RegressionPolicy,
): RegressionResult {
  const mode = policy.mode ?? "fail";
  const regressions: RegressionFinding[] = [];
  for (const rule of policy.rules) {
    const before = baseline.summary.metricAverages[rule.metricId];
    const after = current.summary.metricAverages[rule.metricId];
    if (before === undefined || after === undefined) continue;
    const delta = after - before;
    if (delta < -rule.maxRegression) {
      regressions.push({
        metricId: rule.metricId,
        baseline: round4(before),
        current: round4(after),
        delta: round4(delta),
        maxRegression: rule.maxRegression,
      });
    }
  }
  return { regressions, pass: regressions.length === 0 || mode === "warn", mode };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
