/**
 * Commander evaluator — stub wired for P7 (SPEC §15, TEST-STRATEGY §1/§4).
 *
 * The evaluator scores commander decisions against the evaluation-store
 * cases (invalid-DAG rejection, delegation accuracy, recovery success —
 * TEST-STRATEGY §4) once the evaluation framework lands in P7. This stub
 * declares the surface and fails closed — it never fabricates a score.
 *
 * Layering: src/agents/commander/** imports runtime/core contracts only —
 * no orchestration, ui or domains (ROADMAP P0 invariant). The evaluation
 * interfaces are mirrored structurally (same pattern as contracts.ts).
 */

import type { CommanderDecision } from "./contracts.js";

/** One scored decision (the P7 evaluation record). */
export interface CommanderDecisionEvaluation {
  decisionId: string;
  missionId: string;
  action: string;
  /** Invalid-DAG rejection: did the coordinator refuse every invalid proposal? */
  invalidDagRejected: boolean;
  /** Delegation accuracy: did requiredCapabilities match the worker's tags? */
  delegationAccuracyMet: boolean;
  /** Recovery: after an injected child failure, did the commander recover? */
  recoveredFromChildFailure: boolean;
  recordedAt: string;
}

export interface CommanderEvaluator {
  evaluate(decision: CommanderDecision): CommanderDecisionEvaluation | null;
}

/**
 * The P7 stub: the evaluation framework is not wired yet, so evaluation
 * returns null (fail-closed) — never an invented score. P7 replaces this
 * with the evaluation-store-backed implementation; the interface stays.
 */
export function createCommanderEvaluatorStub(): CommanderEvaluator {
  return {
    evaluate(): CommanderDecisionEvaluation | null {
      // Wired for P7 (evaluation/multi-agent/commander-cases.ts): until the
      // evaluation store exists there is nothing honest to report.
      return null;
    },
  };
}
