import { randomUUID } from "node:crypto";
/**
 * Hypothesis generator for the Nexum Harness Evolution System.
 *
 * Translates an identified subsystem weakness into a scoped, testable mutation
 * hypothesis with an explicit predicted effect and evaluation criteria.
 */

import { HarnessDiagnosis, HarnessHypothesis } from "./types.js";
import { ImprovementTarget } from "./targets/target-engine.js";

/** Generates a unique hypothesis identifier from the component and a random UUID. */
function generateHypothesisId(component: string): string {
  return `hyp-${component}-${randomUUID()}`;
}

/** Formulates a concrete hypothesis from a diagnosed subsystem weakness. */
export function formulateHypothesis(diagnosis: HarnessDiagnosis): HarnessHypothesis {
  const statement = `Modifying ${diagnosis.component} to address ${diagnosis.failureClass}: ${diagnosis.proposedFix}`;
  const predictedEffect = `Expected capability delta: +${(diagnosis.expectedImpact.capability * 100).toFixed(1)}%, reliability delta: +${(diagnosis.expectedImpact.reliability * 100).toFixed(1)}%`;
  const evaluationPlan = `Run regression test suite and benchmark harness targeting ${diagnosis.component} subsystem before candidate promotion.`;

  return {
    id: generateHypothesisId(diagnosis.component),
    targetComponent: diagnosis.component,
    statement,
    predictedEffect,
    evaluationPlan,
    createdAt: Date.now(),
  };
}

/**
 * v2: formulates the hypothesis FROM the formed improvement target, so the
 * mutation is anchored on the capability outcome rather than the loudest
 * symptom. The predicted effect and evaluation criteria come from the
 * target's operationalized evaluation plan.
 */
export function formulateHypothesisFromTarget(target: ImprovementTarget): HarnessHypothesis {
  const components = target.affectedComponents.join(" + ");
  const statement = `Improving capability "${target.capability}" by mutating [${components}] to achieve: ${target.desiredOutcome}`;
  const predictedEffect = `Must move: ${target.measurableMetrics.join(", ")}. Target confidence ${(target.confidence * 100).toFixed(0)}%.`;
  const evaluationPlan = target.evaluationPlan.successCriterion;

  return {
    id: generateHypothesisId(target.capability),
    targetComponent: target.affectedComponents[0] as HarnessHypothesis["targetComponent"],
    statement,
    predictedEffect,
    evaluationPlan,
    createdAt: Date.now(),
  };
}
