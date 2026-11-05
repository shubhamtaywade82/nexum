/**
 * Cheap, deterministic check for "this request is several dependent steps",
 * used to suggest /plan (checkpointed, dependency-ordered, parallel, resumable)
 * instead of running everything as one long chat turn. No model call.
 */
export interface ComplexityAssessment {
  multiStep: boolean;
  score: number;
  signals: string[];
}

/** Score at which a request is treated as multi-step. */
export const MULTI_STEP_THRESHOLD = 3;

const ACTION_VERBS = [
  "implement",
  "add",
  "create",
  "build",
  "refactor",
  "migrate",
  "write",
  "update",
  "fix",
  "test",
  "deploy",
  "document",
  "rename",
  "remove",
  "extract",
  "wire",
  "integrate",
];

const QUESTION_START = /^\s*(what|why|how|where|when|which|who|is|are|does|do|can|could|explain|show|list|describe)\b/i;

export function assessComplexity(message: string): ComplexityAssessment {
  const text = message.trim();
  const signals: string[] = [];
  let score = 0;

  // Slash commands and pure questions are never plan candidates.
  if (!text || text.startsWith("/")) return { multiStep: false, score: 0, signals };

  const numberedLines = text.split("\n").filter((l) => /^\s*(\d+[.)]|[-*])\s+\S/.test(l)).length;
  if (numberedLines >= 2) {
    score += 3;
    signals.push(`${numberedLines}-item list`);
  }

  const sequencing =
    text.match(/\b(then|after that|afterwards|next|finally|once (?:that'?s )?done|step \d+)\b/gi) ?? [];
  if (sequencing.length >= 1) {
    score += Math.min(sequencing.length, 2);
    signals.push("sequenced steps");
  }

  const lower = text.toLowerCase();
  const verbs = ACTION_VERBS.filter((v) => new RegExp(`\\b${v}\\b`).test(lower));
  if (verbs.length >= 3) {
    score += 2;
    signals.push(`${verbs.length} distinct actions`);
  }

  if (
    /\b(across|every|all)\s+(the\s+)?(files?|modules?|packages?|services?|codebase|repo(sitory)?)\b|\bend[- ]to[- ]end\b/i.test(
      text,
    )
  ) {
    score += 1;
    signals.push("wide scope");
  }

  if (text.length >= 400) {
    score += 1;
    signals.push("long request");
  }

  // A question that merely mentions actions is still a question.
  if (QUESTION_START.test(text) && numberedLines < 2) score = Math.min(score, MULTI_STEP_THRESHOLD - 1);

  return { multiStep: score >= MULTI_STEP_THRESHOLD, score, signals };
}
