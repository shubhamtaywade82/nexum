import { scoreByModel, scoreByCategory } from "../../src/benchmark/score.js";
import { formatReport, formatCategoryReport } from "../../src/benchmark/report.js";
import { BenchmarkResult } from "../../src/benchmark/types.js";

function result(overrides: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    model: "qwen3:8b",
    tier: "local",
    caseId: "c1",
    pass: true,
    latencyMs: 100,
    tokensPerSec: 20,
    tokens: 0,
    tokensEstimated: false,
    ...overrides,
  };
}

describe("scoreByModel", () => {
  it("groups results by tier+model and computes pass rate", () => {
    const results = [
      result({ model: "a", caseId: "c1", pass: true, latencyMs: 100, tokensPerSec: 10 }),
      result({ model: "a", caseId: "c2", pass: false, latencyMs: 200, tokensPerSec: 30 }),
      result({ model: "b", tier: "cloud", caseId: "c1", pass: true, latencyMs: 50, tokensPerSec: null }),
    ];

    const scores = scoreByModel(results);
    const a = scores.find((s) => s.model === "a")!;
    const b = scores.find((s) => s.model === "b")!;

    expect(a.cases).toBe(2);
    expect(a.passRate).toBe(0.5);
    expect(a.avgLatencyMs).toBe(150);
    expect(a.avgTokensPerSec).toBe(20);

    expect(b.tier).toBe("cloud");
    expect(b.passRate).toBe(1);
    expect(b.avgTokensPerSec).toBeNull();
  });

  it("returns an empty array for no results", () => {
    expect(scoreByModel([])).toEqual([]);
  });
});

describe("formatReport", () => {
  it("ranks by pass rate then latency, higher pass rate first", () => {
    const report = formatReport([
      { model: "slow-perfect", tier: "local", cases: 2, passRate: 1, avgLatencyMs: 500, avgTokensPerSec: 10 },
      { model: "fast-imperfect", tier: "local", cases: 2, passRate: 0.5, avgLatencyMs: 50, avgTokensPerSec: 40 },
    ]);

    const lines = report.split("\n");
    const perfectLine = lines.findIndex((l) => l.includes("slow-perfect"));
    const imperfectLine = lines.findIndex((l) => l.includes("fast-imperfect"));
    expect(perfectLine).toBeLessThan(imperfectLine);
    expect(report).toContain("100%");
    expect(report).toContain("50%");
  });

  it("handles no results", () => {
    expect(formatReport([])).toBe("(no benchmark results)");
  });
});

describe("scoreByCategory", () => {
  it("groups results by category (flat across models) and computes pass rate", () => {
    const results = [
      result({ category: "tool-calling", pass: true }),
      result({ category: "tool-calling", pass: false }),
      result({ model: "b", category: "reasoning", pass: true }),
    ];

    const scores = scoreByCategory(results);
    const toolCalling = scores.find((s) => s.category === "tool-calling")!;
    const reasoning = scores.find((s) => s.category === "reasoning")!;

    expect(toolCalling.cases).toBe(2);
    expect(toolCalling.passRate).toBe(0.5);
    expect(reasoning.passRate).toBe(1);
  });

  it("groups uncategorized results together", () => {
    const scores = scoreByCategory([result({ category: undefined, pass: true })]);
    expect(scores).toEqual([{ category: "uncategorized", cases: 1, passRate: 1 }]);
  });

  it("returns an empty array for no results", () => {
    expect(scoreByCategory([])).toEqual([]);
  });
});

describe("formatCategoryReport", () => {
  it("ranks by pass rate, highest first", () => {
    const report = formatCategoryReport([
      { category: "tool-calling", cases: 4, passRate: 0.5 },
      { category: "reasoning", cases: 2, passRate: 1 },
    ]);
    const lines = report.split("\n");
    expect(lines.findIndex((l) => l.includes("reasoning"))).toBeLessThan(
      lines.findIndex((l) => l.includes("tool-calling")),
    );
  });

  it("handles no results", () => {
    expect(formatCategoryReport([])).toBe("(no category results)");
  });
});
