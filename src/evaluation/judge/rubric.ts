/**
 * Rubrics — the evaluation contract an LLM judge applies.
 *
 * A rubric is the reusable half of LLM-as-a-Judge: criteria, weights, scale
 * and pass thresholds. Judges (llm-judge.ts) consume rubrics; evaluators
 * (src/evaluation) reference rubric ids from scenarios.
 */

export interface RubricCriterion {
  /** Stable id referenced by verdicts. */
  id: string;
  /** What the judge should assess, phrased as an instruction. */
  description: string;
  /** Relative weight in the overall score (default 1). */
  weight?: number;
  /** Minimum normalized score (0..1) for this criterion to pass (default 0.6). */
  passScore?: number;
}

export interface Rubric {
  /** Stable id referenced by scenarios and evaluators. */
  id: string;
  name: string;
  description?: string;
  /** The criteria (1..n, weighted). */
  criteria: RubricCriterion[];
  /** Scale maximum per criterion (default 5 — judge scores 0..max). */
  scaleMax?: number;
  /** Overall normalized pass threshold (default 0.6). */
  passThreshold?: number;
  /**
   * Pin a judge model for this rubric, overriding router selection.
   * Tier is required because routeToModel is tier-scoped.
   */
  judgeModelOverride?: { model: string; tier: "local" | "cloud" };
  /** Capability tag used for routing (default "judge"). */
  judgeCapability?: string;
}

export function defineRubric(rubric: Rubric): Rubric {
  if (!rubric.id || !rubric.name) throw new Error("rubric requires id and name");
  if (!rubric.criteria || rubric.criteria.length === 0)
    throw new Error(`rubric "${rubric.id}" requires at least one criterion`);
  for (const criterion of rubric.criteria) {
    if (!criterion.id || !criterion.description) {
      throw new Error(`rubric "${rubric.id}" has a criterion without id/description`);
    }
  }
  return rubric;
}

/** Effective criterion weight (default 1). */
export function criterionWeight(criterion: RubricCriterion): number {
  const w = criterion.weight ?? 1;
  return w > 0 ? w : 1;
}

/** Normalize a 0..scaleMax score to 0..1. */
export function normalizeScore(score: number, scaleMax: number): number {
  if (scaleMax <= 0) return 0;
  return Math.max(0, Math.min(1, score / scaleMax));
}

// ── Built-in rubrics ────────────────────────────────────────────────────────

/** General answer quality: correctness, completeness, clarity. */
export const ANSWER_QUALITY_RUBRIC: Rubric = defineRubric({
  id: "builtin:answer-quality",
  name: "Answer quality",
  description: "General-purpose quality assessment of an agent's final answer against its task.",
  criteria: [
    {
      id: "correctness",
      description: "Is the answer factually correct and free of contradictions?",
      weight: 1.5,
      passScore: 0.6,
    },
    {
      id: "completeness",
      description: "Does the answer fully address everything the task asked for?",
      weight: 1.2,
      passScore: 0.6,
    },
    { id: "clarity", description: "Is the answer clearly structured and unambiguous?", weight: 0.8, passScore: 0.5 },
  ],
  scaleMax: 5,
  passThreshold: 0.6,
});

/** Task completion: did the agent achieve the goal, not just answer politely. */
export const TASK_COMPLETION_RUBRIC: Rubric = defineRubric({
  id: "builtin:task-completion",
  name: "Task completion",
  description: "Did the agent actually complete the assigned task end to end?",
  criteria: [
    { id: "goalAchieved", description: "Was the task's primary goal achieved?", weight: 1.5, passScore: 0.6 },
    {
      id: "noRegression",
      description: "Did the work avoid breaking anything else (tests, lint, existing behavior)?",
      weight: 1,
      passScore: 0.6,
    },
    {
      id: "evidence",
      description: "Does the answer cite or show evidence for its claimed outcome (diffs, test output, sources)?",
      weight: 1,
      passScore: 0.5,
    },
  ],
  scaleMax: 5,
  passThreshold: 0.6,
});

/** Groundedness: is the answer supported by the provided context/sources? */
export const GROUNDEDNESS_RUBRIC: Rubric = defineRubric({
  id: "builtin:groundedness",
  name: "Groundedness",
  description: "Is the answer grounded in the provided context rather than invented?",
  criteria: [
    {
      id: "supported",
      description: "Are the answer's claims supported by the provided context?",
      weight: 1.5,
      passScore: 0.6,
    },
    {
      id: "noFabrication",
      description: "Does the answer avoid inventing facts, citations, APIs, or results not present in the context?",
      weight: 1.5,
      passScore: 0.6,
    },
    {
      id: "calibrated",
      description: "Does the answer acknowledge uncertainty where the context is silent?",
      weight: 0.8,
      passScore: 0.4,
    },
  ],
  scaleMax: 5,
  passThreshold: 0.65,
});

export function builtinRubrics(): Rubric[] {
  return [ANSWER_QUALITY_RUBRIC, TASK_COMPLETION_RUBRIC, GROUNDEDNESS_RUBRIC];
}
