/**
 * In-loop critic plane — reflection inside a single execution.
 *
 *   CriticService        model critique (JSON verdict/weaknesses) with a
 *                        deterministic heuristic fallback
 *   SelfCorrectionLoop   answer → critique → feedback → regenerate, bounded
 *   VerifierService      deterministic post-condition checks
 *
 * Wired into the ReAct final-answer path via CriticPolicy (opt-in at the
 * kernel, default-on for product agents like DevAgent). Distinct from the
 * post-run learning plane (episode → grade → lesson), which stays unchanged.
 *
 * See docs/guide/critic.md.
 */

export type { CritiqueWeakness, Critique, CriticOptions, CriticSeverity } from "./critic.js";
export { CriticService, SEVERITY_ORDER, severityAtLeast } from "./critic.js";

export type { SelfCorrectionResult, SelfCorrectionOptions } from "./reflection.js";
export { SelfCorrectionLoop } from "./reflection.js";

export type { VerificationCheck, VerificationResult, VerificationReport } from "./verifier.js";
export { VerifierService, expectOutputContains, expectNoPlaceholders, expectMinLength } from "./verifier.js";
