/**
 * Fixed-Executor Evaluation Protocol.
 *
 * The Self-Developing Agents work emphasizes one critical experimental
 * control: "whether evolution still works under a fixed executor". Without
 * it, you cannot distinguish
 *
 *     "the harness improved"
 * from
 *     "this particular model + harness combination scored higher".
 *
 * This module treats evaluator model, harness candidate, and task suite as
 * independently controlled variables and builds the full evaluation matrix
 * H0..Hn × executor models, producing the cells the GeneralizationGate and
 * the executor-sensitivity metric consume.
 */

import { TaskExecutionResult } from "../evaluator.js";
import { ExecutorEvaluationCell } from "../generalization/generalization-gate.js";

export interface ExecutorArm {
  /** Executor model id, e.g. "qwen3-coder", "gemini-2.5", "claude-x". */
  model: string;
  /** Runs the task suite with THIS executor and returns raw per-task results. */
  run: () => Promise<TaskExecutionResult[]> | TaskExecutionResult[];
}

export interface MatrixRunnerOptions {
  /** Splits to evaluate per (harness, executor) pair. */
  splits?: Array<"visible" | "held_out" | "transfer">;
}

/** Aggregates raw task results into a success/verification rate pair. */
export function ratesFor(
  results: TaskExecutionResult[],
  split?: "visible" | "held_out" | "transfer",
): {
  taskSuccessRate: number;
  verificationPassRate: number;
  runs: number;
} {
  // Transfer runs use a different executor, but the same suite. They decide acceptance,
  // so they take only development tasks; held-out tasks reach the record alone.
  const selected = split === "held_out" ? results.filter((r) => r.isHeldOut) : results.filter((r) => !r.isHeldOut);
  const runs = selected.length;
  return {
    taskSuccessRate: runs > 0 ? selected.filter((r) => r.success).length / runs : 0,
    verificationPassRate: runs > 0 ? selected.filter((r) => r.verificationPassed).length / runs : 0,
    runs,
  };
}

/**
 * FixedExecutorMatrix — evaluates every harness candidate under every executor
 * arm, keeping the executor frozen per arm. The result is the raw material for
 * answering "did the harness improve?" independently of any single model.
 */
export class FixedExecutorMatrix {
  /**
   * Builds matrix cells for the given harness versions and executor arms.
   * `resultsByHarness` maps harness id → per-task results under a given
   * executor; `runners` may instead supply live `run()` arms.
   */
  static async build(
    harnessIds: string[],
    arms: ExecutorArm[],
    resultsByHarness: Record<string, Record<string, TaskExecutionResult[]>>,
    opts: MatrixRunnerOptions = {},
  ): Promise<ExecutorEvaluationCell[]> {
    const cells: ExecutorEvaluationCell[] = [];
    const splits = opts.splits ?? (["visible", "held_out"] as const);

    for (const harnessId of harnessIds) {
      for (const arm of arms) {
        const results = resultsByHarness[harnessId]?.[arm.model] ?? (arm.run ? await arm.run() : []);
        for (const split of splits) {
          const { taskSuccessRate, verificationPassRate, runs } = ratesFor(results, split);
          cells.push({
            harnessId,
            executorModel: arm.model,
            split,
            taskSuccessRate,
            verificationPassRate,
            runs,
          });
        }
      }
    }
    return cells;
  }

  /**
   * Convenience: given a full cell list, returns the held-out task success
   * rates per harness for one executor — the "freeze" view used to compare
   * H0..Hn as the executor stays fixed.
   */
  static heldOutSeries(cells: ExecutorEvaluationCell[], executorModel: string): Map<string, number> {
    const series = new Map<string, number>();
    for (const c of cells) {
      if (c.executorModel === executorModel && c.split === "held_out") {
        series.set(c.harnessId, c.taskSuccessRate);
      }
    }
    return series;
  }

  /**
   * Direction agreement check (research metric): for each executor, does the
   * candidate improve on held-out? The share of executors agreeing with the
   * primary executor's direction is returned — low agreement means the
   * "improvement" is executor-specific noise.
   */
  static directionAgreement(
    cells: ExecutorEvaluationCell[],
    baselineHarnessId: string,
    candidateHarnessId: string,
  ): { agreementRate: number; perExecutor: Record<string, number> } {
    const perExecutor: Record<string, number> = {};
    const executors = new Set(cells.map((c) => c.executorModel));
    let agree = 0;
    let counted = 0;
    for (const model of executors) {
      const base = cells.find(
        (c) => c.harnessId === baselineHarnessId && c.executorModel === model && c.split === "held_out",
      );
      const cand = cells.find(
        (c) => c.harnessId === candidateHarnessId && c.executorModel === model && c.split === "held_out",
      );
      if (!base || !cand) continue;
      const delta = cand.taskSuccessRate - base.taskSuccessRate;
      perExecutor[model] = delta;
      counted++;
      if (delta > 0) agree++;
    }
    return { agreementRate: counted > 0 ? agree / counted : 0, perExecutor };
  }
}
