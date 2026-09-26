/**
 * EvaluationRunner + harnesses + event-derived observations.
 *
 * The runner is agnostic to HOW a scenario executes: an AgentHarness is any
 * function that turns a Scenario into a TrajectoryObservation — a fake for
 * unit tests, a recorded real run via observeExecution(), or a live
 * DefaultAgentRuntime adapter in a product's CI.
 */

import type { ExecutionEvent } from "../runtime/events/bus.js";
import type { LlmJudge } from "./judge/llm-judge.js";
import { defaultEvaluatorRegistry, EvaluatorRegistry, JudgeEvaluator } from "./evaluators.js";
import type {
  EvaluationDataset,
  EvaluationReport,
  Scenario,
  ScenarioResult,
  Threshold,
  TrajectoryObservation,
} from "./types.js";

// ── Harnesses ───────────────────────────────────────────────────────────────

/** Anything that can execute a scenario and observe the trajectory. */
export interface AgentHarness {
  run(scenario: Scenario): Promise<TrajectoryObservation>;
}

/** Harness from a plain function (unit tests, recorded runs). */
export class FunctionHarness implements AgentHarness {
  constructor(private readonly fn: (scenario: Scenario) => Promise<TrajectoryObservation> | TrajectoryObservation) {}

  async run(scenario: Scenario): Promise<TrajectoryObservation> {
    return this.fn(scenario);
  }
}

// ── Observations from execution events ──────────────────────────────────────

/**
 * Build a TrajectoryObservation from a captured event stream — the bridge
 * between the kernel's EventBus and the evaluation framework. Tool calls
 * are paired by event id (tool.started → tool.completed/tool.failed).
 */
export function observeExecution(input: {
  scenario: Scenario;
  runId: string;
  agentId: string;
  status: string;
  output: string;
  events: ExecutionEvent[];
  startedAt: number;
  elapsedMs: number;
  turns?: number;
  error?: string;
}): TrajectoryObservation {
  const started = new Map<string, { name: string; args: Record<string, unknown> }>();
  const toolCalls: TrajectoryObservation["toolCalls"] = [];
  const modelCalls: TrajectoryObservation["modelCalls"] = [];
  let reasoningTurns = 0;

  for (const event of input.events) {
    switch (event.type) {
      case "tool.started":
        started.set(event.id, { name: event.name, args: event.args });
        break;
      case "tool.completed": {
        const call = started.get(event.id);
        if (call) {
          started.delete(event.id);
          toolCalls.push({ name: call.name, args: call.args, ok: true });
        }
        break;
      }
      case "tool.failed": {
        const call = started.get(event.id);
        if (call) {
          started.delete(event.id);
          toolCalls.push({ name: call.name, args: call.args, ok: false, error: event.error });
        }
        break;
      }
      case "model.answered":
        modelCalls.push({ model: event.model, tier: event.tier, promptTokens: 0, completionTokens: 0 });
        break;
      case "execution.reasoning":
        reasoningTurns++;
        break;
      default:
        break;
    }
  }
  // Started but never completed (cancelled mid-call) — still observable.
  for (const [, call] of started) toolCalls.push({ name: call.name, args: call.args, ok: false, error: "unresolved" });

  return {
    scenarioId: input.scenario.id,
    runId: input.runId,
    agentId: input.agentId,
    status: input.status,
    output: input.output,
    turns: input.turns ?? Math.max(reasoningTurns, toolCalls.length),
    toolCalls,
    modelCalls,
    startedAt: input.startedAt,
    elapsedMs: input.elapsedMs,
    totalTokens: modelCalls.reduce((s, c) => s + c.promptTokens + c.completionTokens, 0),
    ...(input.error ? { error: input.error } : {}),
  };
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface EvaluationRunOptions {
  /** Parallel scenario executions (default 4). */
  concurrency?: number;
  /** Per-scenario wall-clock timeout in ms (default 120s). */
  scenarioTimeoutMs?: number;
  /** Dataset-level metric gates (in addition to per-metric expectations). */
  thresholds?: Threshold[];
  /** LLM judge — enables rubric evaluation for scenarios that declare one. */
  judge?: LlmJudge;
  /** Progress hook (streaming results into CI logs). */
  onScenarioComplete?: (result: ScenarioResult) => void;
  /** Custom evaluator registry (overrides the default rule + judge set). */
  evaluators?: EvaluatorRegistry;
}

export class EvaluationRunner {
  private readonly harness: AgentHarness;
  private readonly evaluators: EvaluatorRegistry;
  private readonly opts: Required<Pick<EvaluationRunOptions, "concurrency" | "scenarioTimeoutMs">> &
    Omit<EvaluationRunOptions, "concurrency" | "scenarioTimeoutMs" | "evaluators">;

  constructor(harness: AgentHarness, opts: EvaluationRunOptions = {}) {
    this.harness = harness;
    this.opts = {
      concurrency: opts.concurrency ?? 4,
      scenarioTimeoutMs: opts.scenarioTimeoutMs ?? 120_000,
      ...opts,
    };
    if (opts.evaluators) {
      this.evaluators = opts.evaluators;
    } else {
      const registry = defaultEvaluatorRegistry();
      if (opts.judge) registry.register(new JudgeEvaluator({ judge: opts.judge }));
      this.evaluators = registry;
    }
  }

  /** Execute every scenario in the dataset and produce the report. */
  async run(dataset: EvaluationDataset): Promise<EvaluationReport> {
    const queue = [...dataset.scenarios];
    const results: ScenarioResult[] = [];
    const workers = Array.from({ length: Math.min(this.opts.concurrency, queue.length || 1) }, async () => {
      for (;;) {
        const scenario = queue.shift();
        if (!scenario) return;
        const result = await this.runScenario(scenario);
        results.push(result);
        this.opts.onScenarioComplete?.(result);
      }
    });
    await Promise.all(workers);

    const metricAverages = averageMetrics(results, this.opts.thresholds ?? []);
    const passed = results.filter((r) => r.pass && !r.error).length;
    const errors = results.filter((r) => r.error).length;
    const summary = {
      total: results.length,
      passed,
      failed: results.length - passed,
      errors,
      passRate: results.length > 0 ? round4(passed / results.length) : 0,
      metricAverages,
    };
    const thresholdsHold = this.thresholdsHold(results, this.opts.thresholds ?? []);
    return {
      datasetId: dataset.id,
      datasetName: dataset.name,
      runAt: new Date().toISOString(),
      results: results.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId)),
      summary,
      pass: summary.failed === 0 && thresholdsHold,
    };
  }

  private async runScenario(scenario: Scenario): Promise<ScenarioResult> {
    try {
      const observation = await withTimeout(
        this.harness.run(scenario),
        this.opts.scenarioTimeoutMs,
        `scenario "${scenario.id}" timed out`,
      );
      const { metrics, errors } = await this.evaluators.evaluateAll(scenario, observation);
      const gated = metrics.filter((m) => m.pass === false);
      return {
        scenarioId: scenario.id,
        pass: gated.length === 0 && errors.length === 0,
        metrics,
        observation,
        ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      };
    } catch (err) {
      // Harness/timeout failures produce an errored scenario, not a crash of the suite.
      const observation: TrajectoryObservation = {
        scenarioId: scenario.id,
        runId: "",
        agentId: "",
        status: "failed",
        output: "",
        turns: 0,
        toolCalls: [],
        modelCalls: [],
        startedAt: Date.now(),
        elapsedMs: 0,
        totalTokens: 0,
        error: err instanceof Error ? err.message : String(err),
      };
      return { scenarioId: scenario.id, pass: false, metrics: [], observation, error: observation.error };
    }
  }

  private thresholdsHold(results: ScenarioResult[], thresholds: Threshold[]): boolean {
    if (thresholds.length === 0) return true;
    const averages = averageMetrics(results, thresholds);
    return thresholds.every((t) => {
      const avg = averages[t.metricId];
      if (avg === undefined) return true;
      if (t.min !== undefined && avg < t.min) return false;
      if (t.max !== undefined && avg > t.max) return false;
      return true;
    });
  }
}

function averageMetrics(results: ScenarioResult[], thresholds: Threshold[]): Record<string, number> {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const result of results) {
    const seen = new Set<string>();
    for (const m of result.metrics) {
      if (seen.has(m.metricId)) continue; // one sample per scenario per metric
      seen.add(m.metricId);
      const entry = sums.get(m.metricId) ?? { sum: 0, n: 0 };
      entry.sum += m.value;
      entry.n += 1;
      sums.set(m.metricId, entry);
    }
  }
  const out: Record<string, number> = {};
  for (const [metricId, { sum, n }] of sums) {
    // Averages are meaningful for the metrics the thresholds reference;
    // raw metrics (latency/tokens) average as raw values too.
    out[metricId] = round4(sum / n);
  }
  // Ensure threshold-referenced metrics exist even when no scenario produced them.
  for (const t of thresholds) if (out[t.metricId] === undefined) out[t.metricId] = 0;
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
