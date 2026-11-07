/**
 * TaskPrioritizer — ranks pending tasks using the weighted factors from
 * policies.yml §3.
 *
 * rank = w.impact * scoring.impact
 *      + w.frequency * observedFrequency
 *      + w.evidence_confidence * evidenceConfidence
 *      + w.potential * scoring.potential
 *      + w.dependency_importance * dependencyImportance
 *      + w.feasibility * scoring.feasibility
 *
 * Tasks below `min_confidence_to_act` are routed to investigate-further,
 * regardless of rank.
 *
 * Architecture: docs/evolution/architecture.md
 */

import { PoliciesFile, TaskDefinition } from "./types.js";
import { TaskRegistry } from "./task-registry.js";

export interface PrioritizationInput {
  task: TaskDefinition;
  /** Observed frequency of the problem in the evidence window, in [0, 1]. */
  observedFrequency: number;
  /** Confidence from the most recent report, in [0, 1]. 0 if no report yet. */
  evidenceConfidence: number;
}

export interface PrioritizationOutput {
  task: TaskDefinition;
  rank: number;
  /** Whether the task should be executed now or routed to investigate-further. */
  route: "execute" | "investigate_further";
  /** Per-factor contributions, for debugging and audit. */
  contributions: {
    impact: number;
    frequency: number;
    evidence_confidence: number;
    potential: number;
    dependency_importance: number;
    feasibility: number;
  };
  /** Whether the task was below the confidence floor. */
  belowConfidenceFloor: boolean;
}

export class TaskPrioritizer {
  constructor(
    private readonly policies: PoliciesFile,
    private readonly registry: TaskRegistry,
  ) {}

  /**
   * Ranks a batch of pending tasks. Output is sorted by rank descending.
   * Tasks routed to investigate-further are returned after execute-routed
   * tasks, sorted by their (still-computed) rank.
   */
  rank(inputs: PrioritizationInput[]): PrioritizationOutput[] {
    const w = this.policies.ranking.weights;
    const minConf = this.policies.ranking.min_confidence_to_act;
    const maxDepImportance = this.computeMaxDepImportance(inputs.map((i) => i.task.id));

    const outputs = inputs.map((inp) => {
      const depCount = this.registry.dependentCount(inp.task.id);
      // Normalize dependency importance: 0 if no dependents, 1 if this task
      // has the most dependents in the batch.
      const dependencyImportance = maxDepImportance > 0 ? depCount / maxDepImportance : 0;

      const contributions = {
        impact: w.impact * inp.task.scoring.impact,
        frequency: w.frequency * inp.observedFrequency,
        evidence_confidence: w.evidence_confidence * inp.evidenceConfidence,
        potential: w.potential * inp.task.scoring.potential,
        dependency_importance: w.dependency_importance * dependencyImportance,
        feasibility: w.feasibility * inp.task.scoring.feasibility,
      };

      const rank =
        contributions.impact +
        contributions.frequency +
        contributions.evidence_confidence +
        contributions.potential +
        contributions.dependency_importance +
        contributions.feasibility;

      const belowConfidenceFloor = inp.evidenceConfidence < minConf && inp.evidenceConfidence > 0;
      // A task with NO evidence yet (e.g. a fresh task) is allowed to execute
      // its first diagnose run; the floor only applies once we have a report.
      const route: PrioritizationOutput["route"] =
        belowConfidenceFloor && inp.evidenceConfidence > 0 ? "investigate_further" : "execute";

      return {
        task: inp.task,
        rank,
        route,
        contributions,
        belowConfidenceFloor,
      };
    });

    // Sort: execute first by rank desc, then investigate_further by rank desc.
    outputs.sort((a, b) => {
      if (a.route !== b.route) return a.route === "execute" ? -1 : 1;
      return b.rank - a.rank;
    });
    return outputs;
  }

  private computeMaxDepImportance(ids: string[]): number {
    let max = 0;
    for (const id of ids) {
      const c = this.registry.dependentCount(id);
      if (c > max) max = c;
    }
    return max;
  }
}
