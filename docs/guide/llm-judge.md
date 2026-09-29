# LLM-as-a-Judge

Nexum's evaluation was deterministic (benchmark scoring, episode grading, hard signals). **LLM-as-a-Judge** adds the complementary layer: a model applying a rubric to open-ended outputs, producing structured, auditable verdicts.

```
subject (input + output + context + reference)
      ↓ evaluation prompt (rubric criteria · weights · scale)
judge model  ← ScoredModelRouter, "judge" capability tag
      ↓ strict JSON verdict (tolerant extraction)
{ criteriaScores, overall, pass, explanation, confidence }
      ↓
judge history (audits) → calibration (bias · correlation · agreement)
```

## Model selection

Judges route through the **same ScoredModelRouter** as everything else — no second routing system, no hard-coded judge model:

1. **Rubric override** — `judgeModelOverride: { model, tier }` pins an explicit judge model for that rubric.
2. **Scored selection** — `gateway.select({ capability: "judge" })`; the `judge` weight vector (`structuredOutput 0.4, reasoning 0.35, availability 0.15, cost 0.1`) ranks candidates, and the top pick executes via `routeToModel`.
3. **Fallback** — with no profiled candidates, judging degrades to the `reasoning` capability instead of failing.

## Rubrics

```ts
import { defineRubric, LlmJudge } from "@nemisis-oss/nexum";

const codeReviewRubric = defineRubric({
  id: "myteam:code-review",
  name: "Code review quality",
  criteria: [
    { id: "bugs", description: "Does the review find real defects?", weight: 1.5, passScore: 0.6 },
    { id: "specificity", description: "Are comments anchored to concrete lines/behaviors?", weight: 1 },
  ],
  scaleMax: 5,
  passThreshold: 0.6,
});

const judge = new LlmJudge({ modelGateway, rubrics: [codeReviewRubric] });
const verdict = await judge.judge(
  { input: task, output: agentAnswer, context: retrievedEvidence, reference: goldAnswer },
  "myteam:code-review",
);
// verdict.criteriaScores → [{ criterionId, score, normalized, pass, rationale }]
// verdict.overall (weighted 0..1) · verdict.pass · verdict.explanation · verdict.judgeModel
```

Built-in rubrics: `builtin:answer-quality`, `builtin:task-completion`, `builtin:groundedness`.

## Robustness

- Verdict JSON is extracted tolerantly (fenced blocks, prose wrappers) and scores are clamped to the rubric scale.
- Missing/unknown criteria score 0 — never a crash.
- Unparseable verdicts throw `JudgeParseError` so evaluation callers decide policy (fail the scenario vs record an evaluation error).

## Judge history

Every verdict is recorded (`InMemoryJudgeHistory` default, `SqliteJudgeHistory` for durable audits): rubric, subject digest (sha256 — no payload bloat), criteria scores, judge model, explanation. `history.stats(rubricId)` gives count / avg score / pass rate.

## Calibration

Before verdicts gate anything, measure the judge against known-good labels:

```ts
const report = calibrateJudge(samples); // { expected: 0..1, verdict }[]
// report.bias        > 0 lenient, < 0 harsh
// report.correlation Pearson r vs labels
// report.agreement   pass/fail agreement at the threshold
// report.recommendedThreshold  threshold + bias (lenient → raise the bar)
// report.assessment  "well-calibrated" | "usable-with-adjustment" | "needs-attention"
```

A lenient judge (bias > 0) needs a *higher* cutoff: `recommendedThreshold = passThreshold + bias` makes the judge's pass set match the intended one on the labeled distribution.
