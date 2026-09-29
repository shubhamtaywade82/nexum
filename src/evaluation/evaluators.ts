/**
 * Evaluators — pluggable metric producers.
 *
 *   RuleEvaluator     deterministic trajectory metrics (no I/O)
 *   JudgeEvaluator    LLM-judge verdicts as metrics (rubric per scenario)
 *   EvaluatorRegistry compose any set; failures of one evaluator surface as
 *                     evaluation errors on the scenario, not silent gaps
 */

import type { LlmJudge } from "./judge/llm-judge.js";
import type { Evaluator, MetricResult, Scenario, TrajectoryObservation } from "./types.js";
import { RULE_METRICS, runTurns } from "./metrics.js";

/** All deterministic metrics for one scenario observation. */
export class RuleEvaluator implements Evaluator {
  readonly id = "rule";

  async evaluate(scenario: Scenario, observation: TrajectoryObservation): Promise<MetricResult[]> {
    return [...RULE_METRICS, runTurns].map((fn) => fn(scenario, observation));
  }
}

export interface JudgeEvaluatorOptions {
  judge: LlmJudge;
  /** Rubric used when the scenario doesn't pin one (default builtin:answer-quality). */
  defaultRubricId?: string;
}

/** Applies the scenario's rubric to the final output via the LLM judge. */
export class JudgeEvaluator implements Evaluator {
  readonly id = "judge";

  constructor(private readonly opts: JudgeEvaluatorOptions) {}

  async evaluate(scenario: Scenario, observation: TrajectoryObservation): Promise<MetricResult[]> {
    const rubricId = scenario.expected.rubricId ?? this.opts.defaultRubricId;
    if (!rubricId) return [];
    try {
      const verdict = await this.opts.judge.judge(
        {
          input: scenario.task.goal,
          output: observation.output,
          ...(scenario.task.input ? { context: scenario.task.input } : {}),
        },
        rubricId,
      );
      const metrics: MetricResult[] = [
        {
          metricId: "judge.overall",
          value: verdict.overall,
          pass: verdict.pass,
          details: `${verdict.explanation} (model: ${verdict.judgeModel})`,
        },
      ];
      for (const score of verdict.criteriaScores) {
        metrics.push({
          metricId: `judge.criterion.${score.criterionId}`,
          value: score.normalized,
          pass: score.pass,
          ...(score.rationale ? { details: score.rationale } : {}),
        });
      }
      return metrics;
    } catch (err) {
      // A broken judge must fail visibly, not silently pass scenarios.
      return [
        {
          metricId: "judge.overall",
          value: 0,
          pass: false,
          details: `judge failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
    }
  }
}

/** Typed registry of evaluators (same pattern as RetrieverRegistry). */
export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, Evaluator>();

  register(evaluator: Evaluator): this {
    if (this.evaluators.has(evaluator.id)) {
      throw new Error(`evaluator "${evaluator.id}" is already registered`);
    }
    this.evaluators.set(evaluator.id, evaluator);
    return this;
  }

  ids(): string[] {
    return [...this.evaluators.keys()];
  }

  async evaluateAll(
    scenario: Scenario,
    observation: TrajectoryObservation,
  ): Promise<{ metrics: MetricResult[]; errors: string[] }> {
    const metrics: MetricResult[] = [];
    const errors: string[] = [];
    const settled = await Promise.allSettled(
      [...this.evaluators.values()].map((e) => e.evaluate(scenario, observation)),
    );
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") metrics.push(...result.value);
      else
        errors.push(
          `${[...this.evaluators.keys()][i]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
    });
    return { metrics, errors };
  }
}

/** Default registry: deterministic rules only (judge added by the runner when provided). */
export function defaultEvaluatorRegistry(): EvaluatorRegistry {
  return new EvaluatorRegistry().register(new RuleEvaluator());
}
