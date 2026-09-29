/**
 * LLM-as-a-Judge plane.
 *
 *   Rubric            reusable evaluation contract (criteria, weights, scale)
 *   LlmJudge          subject → prompt → judge model → structured verdict
 *   JudgeHistory      persisted verdicts (in-memory + SQLite)
 *   JudgeCalibration  verdicts vs known-good labels (bias, correlation)
 *
 * Judge model selection: ScoredModelRouter under the "judge" capability
 * tag (CAPABILITY_WEIGHTS.judge: structuredOutput + reasoning), per-rubric
 * {model, tier} overrides, reasoning-capability fallback.
 *
 * See docs/guide/llm-judge.md.
 */

export type { Rubric, RubricCriterion } from "./rubric.js";
export {
  defineRubric,
  criterionWeight,
  normalizeScore,
  builtinRubrics,
  ANSWER_QUALITY_RUBRIC,
  TASK_COMPLETION_RUBRIC,
  GROUNDEDNESS_RUBRIC,
} from "./rubric.js";

export type { JudgeVerdict, CriterionScore, JudgeHistory } from "./judge-history.js";
export { InMemoryJudgeHistory, SqliteJudgeHistory, subjectDigest, newVerdictId } from "./judge-history.js";

export type { JudgeSubject, LlmJudgeOptions } from "./llm-judge.js";
export { LlmJudge, JudgeParseError, weightedOverall } from "./llm-judge.js";

export type { CalibrationSample, CalibrationReport, CalibrationOptions } from "./calibration.js";
export { calibrateJudge, pearson } from "./calibration.js";
