/**
 * GeneralizationGate — the "did it really generalize?" barrier.
 *
 * Encodes the Self-Developing Agents held-out / fixed-executor protocol:
 *
 *  - Visible improvement alone is NOT evidence. The research found visible
 *    improvement frequently failed to transfer to held-out tasks, and only a
 *    small minority of declared final versions were best on held-out eval.
 *
 *  - The executor must be treated as an independently controlled variable:
 *    evaluator model, harness candidate, and task suite are separated so the
 *    gate can answer "did the HARNESS improve?" rather than "did this
 *    particular model + harness combination improve?".
 *
 * The gate consumes a fixed-executor evaluation matrix (harness versions ×
 * executor models) and grants GENERALIZED only when the candidate improves or
 * holds steady on held-out tasks for the primary executor AND does not
 * collapse under any transfer executor.
 */

/** One cell of the fixed-executor evaluation matrix. */
export interface ExecutorEvaluationCell {
  harnessId: string;
  executorModel: string;
  split: "visible" | "held_out" | "transfer";
  taskSuccessRate: number;
  verificationPassRate: number;
  runs: number;
}

export interface GeneralizationGateOptions {
  /** Minimum runs per matrix cell for the cell to be usable. */
  minRunsPerCell?: number;
  /** Maximum tolerated held-out regression vs baseline per executor (0..1). */
  maxHeldOutRegression?: number;
  /** Maximum tolerated transfer regression on ANY transfer executor (0..1). */
  maxTransferRegression?: number;
}

export interface GeneralizationVerdict {
  generalized: boolean;
  rationale: string;
  /** Per-executor held-out deltas (candidate − baseline). */
  heldOutDeltas: Record<string, number>;
  /** Per-executor transfer deltas (candidate − baseline). */
  transferDeltas: Record<string, number>;
  /** Executor sensitivity: spread of held-out deltas across executors (null with fewer than 2). */
  executorSensitivity: number | null;
  violations: string[];
}

export class GeneralizationGate {
  private readonly minRunsPerCell: number;
  private readonly maxHeldOutRegression: number;
  private const_maxTransferRegression: number;

  constructor(opts: GeneralizationGateOptions = {}) {
    this.minRunsPerCell = opts.minRunsPerCell ?? 2;
    this.maxHeldOutRegression = opts.maxHeldOutRegression ?? 0.05;
    this.const_maxTransferRegression = opts.maxTransferRegression ?? 0.1;
  }

  /**
   * Evaluates the fixed-executor matrix. `cells` must contain candidate and
   * baseline rows for the primary executor; transfer executors are optional
   * but required for a full GENERALIZED pass when provided in `transferExecutors`.
   */
  evaluate(
    cells: ExecutorEvaluationCell[],
    baselineHarnessId: string,
    candidateHarnessId: string,
    transferExecutors: string[] = [],
  ): GeneralizationVerdict {
    const violations: string[] = [];
    const heldOutDeltas: Record<string, number> = {};
    const transferDeltas: Record<string, number> = {};

    const candidateCells = cells.filter((c) => c.harnessId === candidateHarnessId);
    const baselineCells = cells.filter((c) => c.harnessId === baselineHarnessId);
    const executors = [...new Set([...candidateCells, ...baselineCells].map((c) => c.executorModel))];

    for (const model of executors) {
      const candHeld = candidateCells.find((c) => c.executorModel === model && c.split === "held_out");
      const baseHeld = baselineCells.find((c) => c.executorModel === model && c.split === "held_out");

      if (candHeld && baseHeld) {
        if (candHeld.runs < this.minRunsPerCell || baseHeld.runs < this.minRunsPerCell) {
          violations.push(`Insufficient runs for held-out evaluation under ${model}`);
          continue;
        }
        const delta = candHeld.taskSuccessRate - baseHeld.taskSuccessRate;
        heldOutDeltas[model] = delta;
        if (delta < -this.maxHeldOutRegression) {
          violations.push(
            `Held-out regression under ${model}: ${(delta * 100).toFixed(1)}% (limit −${(this.maxHeldOutRegression * 100).toFixed(1)}%)`,
          );
        }
      }
    }

    for (const model of transferExecutors) {
      const candTransfer = candidateCells.find((c) => c.executorModel === model && c.split === "transfer");
      const baseTransfer = baselineCells.find((c) => c.executorModel === model && c.split === "transfer");
      if (!candTransfer || !baseTransfer) {
        violations.push(`Missing transfer evaluation cells for executor ${model}`);
        continue;
      }
      if (candTransfer.runs < this.minRunsPerCell || baseTransfer.runs < this.minRunsPerCell) {
        violations.push(`Insufficient runs for transfer evaluation under ${model}`);
        continue;
      }
      const delta = candTransfer.taskSuccessRate - baseTransfer.taskSuccessRate;
      transferDeltas[model] = delta;
      if (delta < -this.const_maxTransferRegression) {
        violations.push(
          `Transfer regression under ${model}: ${(delta * 100).toFixed(1)}% (limit −${(this.const_maxTransferRegression * 100).toFixed(1)}%)`,
        );
      }
    }

    const deltas = Object.values(heldOutDeltas);
    const executorSensitivity = deltas.length > 1 ? Math.max(...deltas) - Math.min(...deltas) : null;

    const generalized = violations.length === 0 && Object.keys(heldOutDeltas).length > 0;
    const rationale = generalized
      ? `Candidate holds or improves on held-out evaluation across ${Object.keys(heldOutDeltas).length} executor(s); executor sensitivity ${executorSensitivity === null ? "n/a (needs ≥2 executors)" : `${(executorSensitivity * 100).toFixed(1)}%`}.`
      : violations.length > 0
        ? `Generalization gate failed: ${violations.join("; ")}`
        : "Generalization gate failed: no usable held-out evaluation cells.";

    return { generalized, rationale, heldOutDeltas, transferDeltas, executorSensitivity, violations };
  }
}
