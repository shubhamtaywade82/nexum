/**
 * A deterministic screen for text that is addressed to the judge rather than being work product: a
 * directive to ignore instructions, to assign scores, or to impersonate the prompt's own structure. The
 * judge's prompt fences untrusted text (see llm-judge.ts), but a judge model can still be steered by content
 * it reads. This screen is the part that does not depend on the model: a verdict whose inputs carry such a
 * directive is flagged, and a flagged verdict cannot pass.
 *
 * The patterns are a floor, not a classifier. A miss here is not proof the text is clean; a hit is always
 * worth a human look.
 */

const DIRECTIVES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "ignore-instructions",
    pattern: /\bignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)\b/i,
  },
  {
    label: "disregard-rubric",
    pattern:
      /\b(disregard|ignore|override|forget)\s+(the\s+|this\s+|your\s+)?(rubric|criteria|scoring|instructions)\b/i,
  },
  {
    label: "score-directive",
    pattern:
      /\b(score|rate|grade|mark)\s+(every|each|all|this)\s+(criterion|criteria|answer|response|output)\b.{0,40}\b(5|10|maximum|perfect|full)\b/i,
  },
  {
    label: "perfect-score-request",
    pattern:
      /\b(give|award|assign)\s+(it\s+|this\s+|me\s+)?(a\s+)?(perfect|full|maximum|top)\s+(score|marks|rating)\b/i,
  },
  { label: "role-impersonation", pattern: /^\s*(system|developer)\s*:/im },
  { label: "fence-forgery", pattern: /<\/?untrusted-[0-9a-f]*/i },
  {
    label: "judge-addressed",
    pattern: /\b(you are|you're)\s+(now\s+)?(the\s+)?(judge|grader|evaluator)\b.{0,80}\b(must|should|always)\b/i,
  },
];

export interface InjectionFinding {
  /** Which subject field carried the directive. */
  field: "input" | "output" | "context" | "reference";
  label: string;
}

export function screenJudgeInputs(subject: {
  input?: string;
  output: string;
  context?: string;
  reference?: string;
}): InjectionFinding[] {
  const fields: Array<[InjectionFinding["field"], string | undefined]> = [
    ["input", subject.input],
    ["output", subject.output],
    ["context", subject.context],
    ["reference", subject.reference],
  ];
  const findings: InjectionFinding[] = [];
  for (const [field, text] of fields) {
    if (!text) continue;
    for (const { label, pattern } of DIRECTIVES) {
      if (pattern.test(text)) findings.push({ field, label });
    }
  }
  return findings;
}
