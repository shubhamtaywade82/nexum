/**
 * Unified evaluation plane.
 *
 *   Scenario / EvaluationDataset    what a correct run looks like
 *   AgentHarness / observeExecution how a run executes + is observed
 *   EvaluatorRegistry               RuleEvaluator (deterministic) + JudgeEvaluator (LLM)
 *   EvaluationRunner                concurrency, timeouts, thresholds, reports
 *   compareReports                  regression gating against a baseline
 *   renderMarkdownReport/ReportStore  CI-ready output + baselines
 *
 * Re-exports the judge plane (./judge) for one import surface.
 */

export type {
  ExpectedToolCall,
  ScenarioExpectation,
  Scenario,
  EvaluationDataset,
  ObservedToolCall,
  ObservedModelCall,
  TrajectoryObservation,
  MetricResult,
  Evaluator,
  Threshold,
  ScenarioResult,
  EvaluationReport,
  RegressionRule,
  RegressionPolicy,
  RegressionFinding,
  RegressionResult,
} from "./types.js";
export { defineDataset, compareReports } from "./types.js";

export {
  RULE_METRICS,
  goalCompletion,
  toolSelectionAccuracy,
  argumentValidity,
  trajectoryEfficiency,
  recoverySuccess,
  safetyForbidden,
  runLatency,
  runTokens,
  runTurns,
  argsContain,
} from "./metrics.js";

export { RuleEvaluator, JudgeEvaluator, EvaluatorRegistry, defaultEvaluatorRegistry } from "./evaluators.js";

export type { AgentHarness, EvaluationRunOptions } from "./runner.js";
export { EvaluationRunner, FunctionHarness, observeExecution } from "./runner.js";

export { renderMarkdownReport, renderRegression, ReportStore } from "./report.js";

export * from "./judge/index.js";
