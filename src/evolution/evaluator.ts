/**
 * Candidate Evaluator for scoring harness versions across Self-Eval, Unified-Eval,
 * and Transfer-Eval modes.
 *
 * Prevents overfitting to a single model by measuring cross-model transferability.
 */

import { EvaluationMetrics } from "./types.js";

export type EvaluationMode = "self_eval" | "unified_eval" | "transfer_eval";

export interface EvaluationTask {
  id: string;
  category: string;
  isHeldOut?: boolean;
}

export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  verificationPassed: boolean;
  toolCalls: number;
  toolErrors: number;
  tokens: number;
  /** True when `tokens` is an estimate because the provider reported no usage counts. */
  tokensEstimated?: boolean;
  latencyMs: number;
  loopAborted: boolean;
  isHeldOut?: boolean;
}

export class CandidateEvaluator {
  /** Aggregates a batch of task execution results into standard EvaluationMetrics. */
  aggregateResults(results: TaskExecutionResult[], transferResults: TaskExecutionResult[] = []): EvaluationMetrics {
    if (results.length === 0) {
      return {
        capability: { taskSuccessRate: 0, verificationPassRate: 0 },
        reliability: { toolErrorRate: 0, falseSuccessRate: 0, loopAbortRate: 0 },
        efficiency: { avgTokens: 0, avgLatencyMs: 0 },
        generalization: { heldOutScore: 0, transferScore: 0 },
      };
    }

    const total = results.length;
    const successes = results.filter((r) => r.success).length;
    const verified = results.filter((r) => r.verificationPassed).length;
    const loopAborts = results.filter((r) => r.loopAborted).length;
    const falseSuccess = results.filter((r) => r.success && !r.verificationPassed).length;

    const totalCalls = results.reduce((acc, r) => acc + r.toolCalls, 0) || 1;
    const totalErrors = results.reduce((acc, r) => acc + r.toolErrors, 0);

    const avgTokens = Math.round(results.reduce((acc, r) => acc + r.tokens, 0) / total);
    const avgLatencyMs = Math.round(results.reduce((acc, r) => acc + r.latencyMs, 0) / total);

    const heldOutTasks = results.filter((r) => r.isHeldOut);
    const heldOutScore =
      heldOutTasks.length > 0 ? heldOutTasks.filter((r) => r.success).length / heldOutTasks.length : successes / total;

    const transferScore =
      transferResults.length > 0
        ? transferResults.filter((r) => r.success).length / transferResults.length
        : heldOutScore;

    return {
      capability: {
        taskSuccessRate: successes / total,
        verificationPassRate: verified / total,
      },
      reliability: {
        toolErrorRate: totalErrors / totalCalls,
        falseSuccessRate: falseSuccess / total,
        loopAbortRate: loopAborts / total,
      },
      efficiency: {
        avgTokens,
        avgLatencyMs,
      },
      generalization: {
        heldOutScore,
        transferScore,
      },
    };
  }
}
