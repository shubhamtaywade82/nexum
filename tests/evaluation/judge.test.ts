/**
 * Tests for LLM-as-a-Judge: rubrics, judge service, history, calibration.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import type { ChatResponse } from "../../src/models/adapters/provider.js";
import type { ModelSelection } from "../../src/models/router/model-selection.js";
import { LlmJudge, JudgeParseError, weightedOverall } from "../../src/evaluation/judge/llm-judge.js";
import { defineRubric, ANSWER_QUALITY_RUBRIC } from "../../src/evaluation/judge/rubric.js";
import { InMemoryJudgeHistory, SqliteJudgeHistory, subjectDigest } from "../../src/evaluation/judge/judge-history.js";
import { calibrateJudge, pearson } from "../../src/evaluation/judge/calibration.js";
import { CAPABILITY_WEIGHTS } from "../../src/models/router/model-selection.js";

/** Verdict JSON the fake judge model returns. */
function verdictJson(scores: Record<string, number>, overall = 0.8): string {
  return JSON.stringify({
    criteria: Object.entries(scores).map(([id, score]) => ({ id, score, rationale: `${id} looks fine` })),
    overall,
    explanation: "The answer addresses the task with minor gaps.",
    confidence: 0.82,
  });
}

/** Fake gateway: records calls, returns canned judge responses. */
function fakeGateway(
  content: string,
  opts: { selections?: ModelSelection[] } = {},
): {
  gateway: ModelGateway;
  calls: { routeToModel: Array<{ model: string; tier: string }>; route: string[] };
} {
  const calls = { routeToModel: [] as Array<{ model: string; tier: string }>, route: [] as string[] };
  const gateway = {
    select: (request: { capability?: string }) => {
      if (request.capability === "judge") return opts.selections ?? [];
      return [];
    },
    routeToModel: async (model: string, tier: "local" | "cloud") => {
      calls.routeToModel.push({ model, tier });
      return { message: { content }, routedModel: model } as unknown as ChatResponse;
    },
    route: async (capability: string) => {
      calls.route.push(capability);
      return { message: { content }, routedModel: "fallback-model" } as unknown as ChatResponse;
    },
  } as unknown as ModelGateway;
  return { gateway, calls };
}

const selection = (model: string, tier: "local" | "cloud", score = 0.9): ModelSelection => ({
  model,
  tier,
  score,
  reasons: [],
});

describe("rubrics", () => {
  it("validates shape on definition", () => {
    expect(() => defineRubric({ id: "", name: "x", criteria: [{ id: "a", description: "d" }] })).toThrow();
    expect(() => defineRubric({ id: "r", name: "x", criteria: [] })).toThrow();
    expect(() => defineRubric({ id: "r", name: "x", criteria: [{ id: "", description: "d" }] })).toThrow();
    expect(ANSWER_QUALITY_RUBRIC.criteria.length).toBeGreaterThan(0);
  });

  it("judge weights exist in CAPABILITY_WEIGHTS", () => {
    expect(CAPABILITY_WEIGHTS.judge).toBeDefined();
    expect(CAPABILITY_WEIGHTS.judge.structuredOutput).toBeGreaterThan(0);
    expect(CAPABILITY_WEIGHTS.judge.reasoning).toBeGreaterThan(0);
  });
});

describe("LlmJudge", () => {
  it("produces a structured verdict from a judge model under the judge capability tag", async () => {
    const { gateway, calls } = fakeGateway(verdictJson({ correctness: 5, completeness: 4, clarity: 4 }));
    const judge = new LlmJudge({ modelGateway: gateway });
    const verdict = await judge.judge(
      { input: "Explain the tool gateway", output: "The gateway validates, checks policy, then executes." },
      "builtin:answer-quality",
    );

    expect(verdict.rubricId).toBe("builtin:answer-quality");
    expect(verdict.criteriaScores).toHaveLength(3);
    expect(verdict.criteriaScores[0].normalized).toBe(1);
    expect(verdict.pass).toBe(true);
    expect(verdict.explanation).toContain("minor gaps");
    expect(verdict.judgeModel).toBe("fallback-model");
    // No scored candidates → reasoning-capability fallback was used.
    expect(calls.route).toEqual(["reasoning"]);
    expect(verdict.overall).toBeGreaterThan(0.7);
  });

  it("routes through the scored router's top judge candidate", async () => {
    const { gateway, calls } = fakeGateway(verdictJson({ correctness: 4, completeness: 4, clarity: 5 }), {
      selections: [selection("qwen3:32b", "local"), selection("gpt-oss:20b", "local", 0.7)],
    });
    const judge = new LlmJudge({ modelGateway: gateway });
    const verdict = await judge.judge({ output: "some answer" }, "builtin:answer-quality");
    expect(calls.routeToModel).toHaveLength(1);
    expect(calls.routeToModel[0]).toEqual({ model: "qwen3:32b", tier: "local" });
    expect(verdict.judgeModel).toBe("qwen3:32b");
  });

  it("honors per-rubric model overrides", async () => {
    const { gateway, calls } = fakeGateway(verdictJson({ correctness: 5, completeness: 5, clarity: 5 }), {
      selections: [selection("router-pick", "local")],
    });
    const judge = new LlmJudge({
      modelGateway: gateway,
      rubrics: [
        defineRubric({
          id: "custom:pinned",
          name: "Pinned",
          criteria: [{ id: "quality", description: "overall quality" }],
          judgeModelOverride: { model: "llama3.3:70b", tier: "cloud" },
        }),
      ],
    });
    const verdict = await judge.judge({ output: "answer" }, "custom:pinned");
    expect(calls.routeToModel[0]).toEqual({ model: "llama3.3:70b", tier: "cloud" });
    expect(verdict.judgeModel).toBe("llama3.3:70b");
    expect(verdict.criteriaScores[0].criterionId).toBe("quality");
  });

  it("tolerates fenced JSON and prose-wrapped verdicts", async () => {
    const fenced = "```json\n" + verdictJson({ correctness: 3, completeness: 3, clarity: 3 }) + "\n```";
    const { gateway } = fakeGateway(fenced);
    const judge = new LlmJudge({ modelGateway: gateway });
    const verdict = await judge.judge({ output: "x" }, "builtin:answer-quality");
    expect(verdict.criteriaScores.every((c) => c.score === 3)).toBe(true);
  });

  it("clamps out-of-scale scores and fails unknown criteria gracefully", async () => {
    const raw = JSON.stringify({
      criteria: [
        { id: "correctness", score: 99 },
        { id: "unknown-criterion", score: 5 },
      ],
      overall: 1,
      explanation: "e",
    });
    const { gateway } = fakeGateway(raw);
    const judge = new LlmJudge({ modelGateway: gateway });
    const verdict = await judge.judge({ output: "x" }, "builtin:answer-quality");
    const correctness = verdict.criteriaScores.find((c) => c.criterionId === "correctness");
    expect(correctness?.score).toBe(5); // clamped to scaleMax
    const completeness = verdict.criteriaScores.find((c) => c.criterionId === "completeness");
    expect(completeness?.score).toBe(0); // missing from response → 0, not a crash
  });

  it("throws JudgeParseError on unparseable verdicts and unknown rubrics", async () => {
    const { gateway } = fakeGateway("I cannot answer in JSON, sorry.");
    const judge = new LlmJudge({ modelGateway: gateway });
    await expect(judge.judge({ output: "x" }, "builtin:answer-quality")).rejects.toThrow(JudgeParseError);
    await expect(judge.judge({ output: "x" }, "missing:rubric")).rejects.toThrow("unknown rubric");
  });

  it("fails verdicts below the rubric threshold", async () => {
    const { gateway } = fakeGateway(verdictJson({ correctness: 1, completeness: 1, clarity: 2 }, 0.2));
    const judge = new LlmJudge({ modelGateway: gateway });
    const verdict = await judge.judge({ output: "weak" }, "builtin:answer-quality");
    expect(verdict.pass).toBe(false);
    expect(verdict.overall).toBeLessThan(0.6);
  });

  it("records verdicts into history", async () => {
    const { gateway } = fakeGateway(verdictJson({ correctness: 4, completeness: 4, clarity: 4 }));
    const history = new InMemoryJudgeHistory();
    const judge = new LlmJudge({ modelGateway: gateway, history });
    await judge.judge({ output: "a" }, "builtin:answer-quality");
    await judge.judge({ output: "b" }, "builtin:answer-quality");
    const stats = history.stats("builtin:answer-quality");
    expect(stats.count).toBe(2);
    expect(stats.passRate).toBe(1);
    expect(history.list({ rubricId: "builtin:answer-quality" })[0].subjectDigest).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe("weightedOverall", () => {
  it("weights criteria by rubric weights", () => {
    const rubric = defineRubric({
      id: "t:w",
      name: "W",
      criteria: [
        { id: "heavy", description: "d", weight: 3 },
        { id: "light", description: "d", weight: 1 },
      ],
    });
    const overall = weightedOverall(rubric, [
      { criterionId: "heavy", score: 5, maxScore: 5, normalized: 1, pass: true },
      { criterionId: "light", score: 0, maxScore: 5, normalized: 0, pass: false },
    ]);
    expect(overall).toBeCloseTo(0.75, 3);
  });
});

describe("JudgeHistory stores", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-judge-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and filters verdicts (SQLite)", async () => {
    const history = new SqliteJudgeHistory(join(dir, "judge.db"));
    const { gateway } = fakeGateway(verdictJson({ correctness: 5, completeness: 5, clarity: 5 }));
    const judge = new LlmJudge({ modelGateway: gateway, history });
    const v1 = await judge.judge({ output: "one" }, "builtin:answer-quality");
    await judge.judge({ output: "two" }, "builtin:task-completion");

    expect(history.list({ rubricId: "builtin:answer-quality" })).toHaveLength(1);
    expect(history.list({ judgeModel: v1.judgeModel })).toHaveLength(2);
    expect(history.stats("builtin:answer-quality").count).toBe(1);

    // Round-trips across connections (order between same-ts verdicts is
    // ambiguous — assert on filtered content instead).
    history.close();
    const reopened = new SqliteJudgeHistory(join(dir, "judge.db"));
    expect(reopened.list()).toHaveLength(2);
    const answerQuality = reopened.list({ rubricId: "builtin:answer-quality" })[0];
    expect(answerQuality.criteriaScores[0].criterionId).toBe("correctness");
    reopened.close();
  });

  it("subjectDigest is stable and input-sensitive", () => {
    expect(subjectDigest(["a", "b"])).toBe(subjectDigest(["a", "b"]));
    expect(subjectDigest(["a", "b"])).not.toBe(subjectDigest(["a", "c"]));
  });
});

describe("JudgeCalibration", () => {
  const verdict = (overall: number, pass: boolean) => ({
    id: `v_${overall}`,
    rubricId: "r",
    subjectDigest: "d",
    criteriaScores: [],
    overall,
    pass,
    explanation: "",
    judgeModel: "m",
    ts: 0,
  });

  it("reports a well-calibrated judge", () => {
    const samples = [0.9, 0.7, 0.5, 0.3].map((e) => ({
      expected: e,
      verdict: verdict(Math.max(0, Math.min(1, e + 0.02)), e >= 0.6),
    }));
    const report = calibrateJudge(samples);
    expect(report.assessment).toBe("well-calibrated");
    expect(Math.abs(report.bias)).toBeLessThan(0.05);
    expect(report.correlation).toBeGreaterThan(0.9);
    expect(report.agreement).toBe(1);
  });

  it("detects lenient judges and recommends a raised threshold", () => {
    const samples = [0.9, 0.7, 0.5, 0.3].map((e) => ({
      expected: e,
      verdict: verdict(Math.min(1, e + 0.2), true),
    }));
    const report = calibrateJudge(samples, { passThreshold: 0.6 });
    expect(report.bias).toBeGreaterThan(0.15);
    expect(report.recommendedThreshold).toBeGreaterThan(0.6);
    expect(report.assessment).not.toBe("well-calibrated");
    expect(report.notes.join(" ")).toContain("lenient");
  });

  it("flags low-correlation judges as needing attention", () => {
    const samples = [0.9, 0.1, 0.9, 0.1].map((e) => ({ expected: e, verdict: verdict(1 - e, false) }));
    const report = calibrateJudge(samples);
    expect(report.correlation).toBeLessThan(0);
    expect(report.assessment).toBe("needs-attention");
  });

  it("handles empty samples and degenerate correlation", () => {
    const empty = calibrateJudge([]);
    expect(empty.count).toBe(0);
    expect(empty.assessment).toBe("needs-attention");
    expect(pearson([1, 1, 1], [0.2, 0.5, 0.9])).toBe(0);
    expect(pearson([1], [1])).toBe(0);
  });
});
