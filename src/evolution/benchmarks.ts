/**
 * Benchmark runner integration for the Nexum Harness Evolution System.
 *
 * Bridges the benchmark cases in src/benchmark/ to TaskExecutionResult metrics
 * used by CandidateEvaluator and CandidateComparator.
 */

import { BUILTIN_CASES } from "../benchmark/cases.js";
import { buildAgenticCases } from "../benchmark/cases-agentic.js";
import { buildHarnessCases } from "../benchmark/cases-harness.js";
import { buildExecutionCases } from "../benchmark/cases-execution.js";
import { BenchmarkTarget, runBenchmark } from "../benchmark/runner.js";
import { BenchmarkCase, BenchmarkResult } from "../benchmark/types.js";
import { Provider } from "../models/adapters/provider.js";
import { TaskExecutionResult } from "./evaluator.js";
import { isHeldOutCase } from "./heldout-split.js";

/** Gathers all benchmark cases across builtin, agentic, and execution suites. */
export async function getAllBenchmarkCases(): Promise<BenchmarkCase[]> {
  const executionCases = await buildExecutionCases();
  return [...BUILTIN_CASES, ...buildAgenticCases(), ...buildHarnessCases(), ...executionCases];
}

/** Filters available cases by recommended category names. */
export function filterCasesByCategory(cases: BenchmarkCase[], categories: string[]): BenchmarkCase[] {
  if (categories.length === 0) return cases;
  const set = new Set(categories.map((c) => c.toLowerCase()));
  const matched = cases.filter((c) => c.category && set.has(c.category.toLowerCase()));
  // Fall back to all cases if no category matched
  return matched.length > 0 ? matched : cases;
}

/** Transforms a BenchmarkResult into a standardized TaskExecutionResult. */
export function toTaskExecutionResult(res: BenchmarkResult): TaskExecutionResult {
  const loopAborted = Boolean(res.error?.includes("maxTurns") || res.reason?.includes("loop"));

  return {
    taskId: res.caseId,
    success: res.pass,
    verificationPassed: res.pass,
    // Recorded by the runner from the trajectory; undefined when it was not recorded.
    toolCalls: res.toolCalls,
    toolErrors: res.toolErrors,
    tokens: res.tokens,
    tokensEstimated: res.tokensEstimated,
    latencyMs: res.latencyMs,
    loopAborted,
    isHeldOut: isHeldOutCase(res.caseId),
  };
}

/** Executes benchmark cases against a target provider and returns evaluation results. */
export async function runHarnessBenchmark(
  provider: Provider,
  categories: string[] = [],
  cases?: BenchmarkCase[],
): Promise<TaskExecutionResult[]> {
  const target: BenchmarkTarget = {
    model: provider.currentModel,
    tier: provider.currentTier,
    provider,
  };

  const caseList = cases ?? (await getAllBenchmarkCases());
  const selectedCases = filterCasesByCategory(caseList, categories);
  const benchmarkResults = await runBenchmark([target], selectedCases, { timeoutMs: 30_000 });
  return benchmarkResults.map(toTaskExecutionResult);
}
