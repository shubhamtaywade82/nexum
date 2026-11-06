/**
 * Target Formation layer for the Nexum closed-loop self-development system.
 *
 * Inspired by the Aspire findings from the Self-Developing Agents research:
 * when the goal is vague, agents spend most of their effort operationalizing
 * the *target itself* rather than improving the target capability, and only a
 * small fraction of attempted checkpoints produce retained improvements.
 *
 * The TargetEngine therefore sits BETWEEN failure diagnosis and evolution
 * planning. It refuses to answer "which file should I change?" until it has
 * answered "what capability is actually failing?" — producing an
 * `ImprovementTarget` that binds symptoms, metrics, affected components, and
 * an evaluation plan to a single capability-level objective.
 */

import { HarnessDiagnosis } from "../types.js";

/** Top-level capability axes a harness can be improved against. */
export type CapabilityArea =
  | "task_completion"
  | "code_correctness"
  | "tool_utilization"
  | "context_quality"
  | "state_continuity"
  | "verification_rigor"
  | "routing_efficiency"
  | "execution_stability";

export interface EvaluationPlanStep {
  /** Benchmark category or verifier to run, e.g. "agentic-looping". */
  suite: string;
  /** Whether the suite results count for visible or held-out evaluation. */
  split: "visible" | "held_out";
  /** Minimum sample size for the experiment to be valid. */
  minRuns: number;
}

export interface EvaluationPlan {
  /** Human-readable statement of what a successful experiment looks like. */
  successCriterion: string;
  steps: EvaluationPlanStep[];
  /** Executor models the candidate must be evaluated against (fixed-executor protocol). */
  executorModels: string[];
}

export interface ImprovementTarget {
  id: string;
  /** Capability-level objective, e.g. "repository navigation". */
  capability: CapabilityArea;
  /** Operationalized desired outcome — measurable, not vague. */
  desiredOutcome: string;
  /** Observable failure symptoms aggregated from diagnoses. */
  observableSymptoms: string[];
  /** Metrics that must move for the target to count as improved. */
  measurableMetrics: string[];
  /** Harness components (E/T/C/S/L/V/routing/memory) implicated by the target. */
  affectedComponents: string[];
  /** Confidence that this target is the true bottleneck (not a symptom). */
  confidence: number;
  evaluationPlan: EvaluationPlan;
  /** Diagnosis failure classes that motivated this target — provenance. */
  sourceFailureClasses: string[];
  createdAt: number;
}

/** Maps a low-level failure class to the capability area it attacks. */
export function capabilityAreaFor(failureClass: string): CapabilityArea {
  switch (failureClass) {
    case "premature_completion":
    case "verification_gap":
      return "verification_rigor";
    case "loop_failure":
    case "retry_failure":
      return "execution_stability";
    case "tool_argument_error":
    case "tool_selection":
    case "tool_protocol_error":
      return "tool_utilization";
    case "insufficient_context":
    case "bad_context_selection":
    case "context_overflow":
      return "context_quality";
    case "state_loss":
    case "checkpoint_failure":
      return "state_continuity";
    case "routing_failure":
      return "routing_efficiency";
    // Success-driven evolution (v2.4): wasteful successes and comparative
    // success patterns feed the same capability-level target formation.
    case "efficiency_opportunity":
      return "tool_utilization";
    case "success_pattern":
      return "execution_stability";
    default:
      return "task_completion";
  }
}

const CAPABILITY_OUTCOMES: Record<CapabilityArea, string> = {
  task_completion:
    "End-to-end task success rate on representative benchmark suites increases without verification regressions.",
  code_correctness:
    "Patches produced by the agent pass external verification (tests, lint, types) on first delivery more often.",
  tool_utilization:
    "Tool error rate drops while tool-call efficiency (calls per successful task) stays flat or improves.",
  context_quality:
    "Context overflow and bad-selection failures drop without increasing token consumption beyond the cost ceiling.",
  state_continuity: "State loss and checkpoint failures drop across long-running multi-step episodes.",
  verification_rigor:
    "False-success rate (declared success without passing verification) approaches zero on held-out tasks.",
  routing_efficiency: "Model routing failures drop and escalation latency decreases without capability regressions.",
  execution_stability: "Loop aborts and retry storms decrease without masking genuine failures as successes.",
};

const CAPABILITY_METRICS: Record<CapabilityArea, string[]> = {
  task_completion: ["capability.taskSuccessRate", "generalization.heldOutScore"],
  code_correctness: ["capability.verificationPassRate", "reliability.falseSuccessRate"],
  tool_utilization: ["reliability.toolErrorRate", "capability.taskSuccessRate"],
  context_quality: ["reliability.loopAbortRate", "efficiency.avgTokens"],
  state_continuity: ["reliability.loopAbortRate", "capability.taskSuccessRate"],
  verification_rigor: ["reliability.falseSuccessRate", "capability.verificationPassRate"],
  routing_efficiency: ["reliability.toolErrorRate", "efficiency.avgLatencyMs"],
  execution_stability: ["reliability.loopAbortRate", "reliability.falseSuccessRate"],
};

/**
 * Components that could plausibly host the true root cause for a capability
 * failure. Aspire's lesson: the component that *exhibits* the failure is often
 * not the component that *causes* it — e.g. "tool selection seems bad" may be
 * caused by context construction, model routing, tool descriptions, or
 * verification policy, not by src/tools/.
 */
const COMPONENT_CANDIDATES: Record<CapabilityArea, string[]> = {
  task_completion: ["execution", "context", "tools"],
  code_correctness: ["verification", "tools"],
  tool_utilization: ["tools", "context", "routing"],
  context_quality: ["context", "memory"],
  state_continuity: ["state", "lifecycle"],
  verification_rigor: ["verification", "lifecycle"],
  routing_efficiency: ["routing", "lifecycle"],
  execution_stability: ["execution", "lifecycle", "context"],
};

export interface TargetEngineOptions {
  /**
   * Confidence below which a target is considered not yet operationalized and
   * is refused (prevents vague-target churn).
   */
  minConfidence?: number;
  /** Executor models for the default evaluation plan (fixed-executor protocol). */
  executorModels?: string[];
  /** Minimum number of diagnoses sharing a capability before a target forms. */
  minCorroboratingDiagnoses?: number;
}

export class TargetEngine {
  private readonly minConfidence: number;
  private readonly executorModels: string[];
  private readonly minCorroboratingDiagnoses: number;

  constructor(opts: TargetEngineOptions = {}) {
    this.minConfidence = opts.minConfidence ?? 0.5;
    this.executorModels = opts.executorModels ?? ["primary"];
    this.minCorroboratingDiagnoses = opts.minCorroboratingDiagnoses ?? 1;
  }

  /**
   * Forms the single highest-value improvement target from a batch of
   * diagnoses. Returns `null` when the evidence is too weak to operationalize
   * a target — the caller should gather more telemetry rather than mutate the
   * harness on a vague goal.
   */
  formTarget(diagnoses: HarnessDiagnosis[]): ImprovementTarget | null {
    if (diagnoses.length === 0) return null;

    // 1. Aggregate diagnoses by capability area (not by component — that is
    //    the entire point of this layer).
    const byCapability = new Map<CapabilityArea, HarnessDiagnosis[]>();
    for (const d of diagnoses) {
      const area = capabilityAreaFor(d.failureClass);
      const list = byCapability.get(area) ?? [];
      list.push(d);
      byCapability.set(area, list);
    }

    // 2. Rank capability areas by corroborated confidence (mean confidence ×
    //    sqrt(count)) — corroboration across episodes matters more than one
    //    loud failure.
    let bestArea: CapabilityArea | null = null;
    let bestScore = 0;
    let bestConfidence = 0;
    for (const [area, list] of byCapability.entries()) {
      const mean = list.reduce((acc, d) => acc + d.confidence, 0) / list.length;
      const score = mean * Math.sqrt(list.length);
      if (list.length >= this.minCorroboratingDiagnoses && score > bestScore) {
        bestScore = score;
        bestArea = area;
        bestConfidence = mean;
      }
    }

    if (!bestArea || bestConfidence < this.minConfidence) return null;

    const supporting = byCapability.get(bestArea)!;

    // 3. Affected components: the diagnosed component PLUS all plausible
    //    cross-component candidates for this capability. This is what allows
    //    the downstream mutation scope to escalate when single-component
    //    experiments repeatedly fail to move the target.
    const diagnosedComponents = [...new Set(supporting.map((d) => d.component))];
    const affectedComponents = [...new Set([...diagnosedComponents, ...COMPONENT_CANDIDATES[bestArea]])];

    return {
      id: `target-${bestArea}-${Date.now()}`,
      capability: bestArea,
      desiredOutcome: CAPABILITY_OUTCOMES[bestArea],
      observableSymptoms: supporting.map((d) => `${d.failureClass}: ${d.rootCause}`),
      measurableMetrics: CAPABILITY_METRICS[bestArea],
      affectedComponents,
      confidence: bestConfidence,
      evaluationPlan: this.buildEvaluationPlan(bestArea),
      sourceFailureClasses: [...new Set(supporting.map((d) => d.failureClass))],
      createdAt: Date.now(),
    };
  }

  /** Builds a concrete, split-aware evaluation plan for the target capability. */
  buildEvaluationPlan(area: CapabilityArea): EvaluationPlan {
    const visibleSuites = visibleSuitesFor(area);
    return {
      successCriterion: `${CAPABILITY_OUTCOMES[area]} Verified on both visible and held-out splits under a frozen executor.`,
      steps: [
        ...visibleSuites.map((suite) => ({ suite, split: "visible" as const, minRuns: 3 })),
        { suite: "held-out-generalization", split: "held_out" as const, minRuns: 3 },
      ],
      executorModels: [...this.executorModels],
    };
  }
}

function visibleSuitesFor(area: CapabilityArea): string[] {
  switch (area) {
    case "verification_rigor":
    case "code_correctness":
      return ["error-recovery", "execution"];
    case "tool_utilization":
      return ["tool-calling", "execution"];
    case "context_quality":
      return ["reasoning", "thinking"];
    case "execution_stability":
      return ["agentic-looping", "error-recovery"];
    case "state_continuity":
      return ["agentic-looping"];
    case "routing_efficiency":
      return ["escalation"];
    default:
      return ["execution", "agentic-looping"];
  }
}
