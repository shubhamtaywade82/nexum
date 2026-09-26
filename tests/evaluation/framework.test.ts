/**
 * Tests for the unified evaluation framework: metrics, evaluators, runner,
 * regression gating, and report rendering.
 */
import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEvent } from "../../src/runtime/events/bus.js";
import type { ModelGateway } from "../../src/models/gateway/model-gateway.js";
import type { ChatResponse } from "../../src/models/adapters/provider.js";
import {
  defineDataset,
  compareReports,
  type Scenario,
  type TrajectoryObservation,
  type EvaluationReport,
} from "../../src/evaluation/types.js";
import {
  argsContain,
  goalCompletion,
  toolSelectionAccuracy,
  argumentValidity,
  trajectoryEfficiency,
  recoverySuccess,
  safetyForbidden,
  runTurns,
} from "../../src/evaluation/metrics.js";
import { RuleEvaluator, JudgeEvaluator, EvaluatorRegistry } from "../../src/evaluation/evaluators.js";
import { EvaluationRunner, FunctionHarness, observeExecution } from "../../src/evaluation/runner.js";
import { renderMarkdownReport, renderRegression, ReportStore } from "../../src/evaluation/report.js";
import { LlmJudge } from "../../src/evaluation/judge/llm-judge.js";

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "s1",
    name: "Read a file",
    task: { goal: "Read package.json and report the package name" },
    expected: {},
    ...overrides,
  };
}

function observation(overrides: Partial<TrajectoryObservation> = {}): TrajectoryObservation {
  return {
    scenarioId: "s1",
    runId: "run_1",
    agentId: "devagent",
    status: "completed",
    output: "The package name is @nemesis-oss/nexum.",
    turns: 3,
    toolCalls: [],
    modelCalls: [{ model: "qwen3", tier: "local", promptTokens: 500, completionTokens: 100 }],
    startedAt: Date.now() - 4000,
    elapsedMs: 4000,
    totalTokens: 600,
    ...overrides,
  };
}

describe("metrics", () => {
  it("argsContain does deep-subset matching", () => {
    expect(argsContain({ path: "a.txt", mode: "r" }, { path: "a.txt" })).toBe(true);
    expect(argsContain({ nested: { a: 1, b: 2 } }, { nested: { a: 1 } })).toBe(true);
    expect(argsContain({ path: "b.txt" }, { path: "a.txt" })).toBe(false);
    expect(argsContain({}, { path: "a.txt" })).toBe(false);
  });

  it("goalCompletion requires status and output substrings", () => {
    const s = scenario({ expected: { finalOutputContains: ["package name", "@nemesis-oss/nexum"] } });
    expect(goalCompletion(s, observation()).value).toBe(1);
    const partial = goalCompletion(s, observation({ output: "The package name is unknown." }));
    expect(partial.value).toBe(0.5);
    expect(partial.pass).toBe(false);
    expect(goalCompletion(scenario(), observation({ status: "failed" })).value).toBe(0);
    expect(goalCompletion(scenario({ expected: { status: "any" } }), observation({ status: "cancelled" })).value).toBe(
      1,
    );
  });

  it("toolSelectionAccuracy and argumentValidity score expected calls", () => {
    const s = scenario({
      expected: {
        toolCalls: [{ name: "read_file", argsContains: { path: "package.json" } }, { name: "search" }],
      },
    });
    const good = observation({
      toolCalls: [
        { name: "read_file", args: { path: "package.json" }, ok: true },
        { name: "search", args: { query: "name" }, ok: true },
      ],
    });
    expect(toolSelectionAccuracy(s, good).value).toBe(1);
    expect(argumentValidity(s, good).value).toBe(1);

    const badArgs = observation({
      toolCalls: [
        { name: "read_file", args: { path: "other.json" }, ok: true },
        { name: "search", args: {}, ok: true },
      ],
    });
    expect(toolSelectionAccuracy(s, badArgs).value).toBeCloseTo(0.5);
    expect(argumentValidity(s, badArgs).value).toBe(0);

    // optional expected calls don't gate
    const optional = scenario({ expected: { toolCalls: [{ name: "lint", required: false }] } });
    expect(toolSelectionAccuracy(optional, observation()).pass).toBe(null);
  });

  it("trajectoryEfficiency penalizes excess tool calls and respects maxToolCalls", () => {
    const s = scenario({ expected: { toolCalls: [{ name: "read_file" }] } });
    const lean = observation({ toolCalls: [{ name: "read_file", args: {}, ok: true }] });
    const heavy = observation({
      toolCalls: Array.from({ length: 12 }, () => ({ name: "read_file", args: {}, ok: true })),
    });
    expect(trajectoryEfficiency(s, lean).value).toBe(1);
    const heavyMetric = trajectoryEfficiency(s, heavy);
    expect(heavyMetric.value).toBeLessThan(0.5);
    expect(heavyMetric.pass).toBe(false);

    const capped = scenario({ expected: { maxToolCalls: 2 } });
    expect(trajectoryEfficiency(capped, observation({ toolCalls: [{ name: "x", args: {}, ok: true }] })).pass).toBe(
      true,
    );
    expect(
      trajectoryEfficiency(
        capped,
        observation({ toolCalls: Array.from({ length: 3 }, (_, i) => ({ name: `x${i}`, args: {}, ok: true })) }),
      ).pass,
    ).toBe(false);
  });

  it("recoverySuccess credits later successful retries of the same tool", () => {
    const s = scenario();
    const recovered = observation({
      toolCalls: [
        { name: "shell", args: {}, ok: false, error: "timeout" },
        { name: "shell", args: {}, ok: true },
      ],
    });
    expect(recoverySuccess(s, recovered).value).toBe(1);
    const stuck = observation({ toolCalls: [{ name: "shell", args: {}, ok: false, error: "boom" }] });
    const stuckMetric = recoverySuccess(s, stuck);
    expect(stuckMetric.value).toBe(0);
    expect(stuckMetric.pass).toBe(null); // informational unless recovered
  });

  it("safetyForbidden fails when forbidden tools are used", () => {
    const s = scenario({ expected: { forbiddenTools: ["delete_file", "git"] } });
    expect(safetyForbidden(s, observation()).value).toBe(1);
    const violated = safetyForbidden(s, observation({ toolCalls: [{ name: "git", args: { op: "push" }, ok: true }] }));
    expect(violated.value).toBe(0);
    expect(violated.pass).toBe(false);
    expect(violated.details).toContain("git");
  });

  it("runTurns applies the maxTurns gate", () => {
    const s = scenario({ expected: { maxTurns: 5 } });
    expect(runTurns(s, observation({ turns: 3 })).pass).toBe(true);
    expect(runTurns(s, observation({ turns: 9 })).pass).toBe(false);
    expect(runTurns(scenario(), observation({ turns: 99 })).pass).toBe(null);
  });
});

describe("evaluators", () => {
  it("RuleEvaluator emits the full deterministic metric set", async () => {
    const metrics = await new RuleEvaluator().evaluate(scenario(), observation());
    const ids = metrics.map((m) => m.metricId);
    expect(ids).toContain("goal.completion");
    expect(ids).toContain("tool.selection");
    expect(ids).toContain("trajectory.efficiency");
    expect(ids).toContain("safety.forbidden");
    expect(ids).toContain("run.latency_ms");
    expect(ids).toContain("run.tokens");
  });

  it("JudgeEvaluator surfaces verdicts as metrics and judge failures as failures", async () => {
    const gateway = {
      select: () => [],
      routeToModel: async () => ({ message: { content: "" } }) as unknown as ChatResponse,
      route: async () =>
        ({
          message: {
            content: JSON.stringify({
              criteria: [
                { id: "correctness", score: 5, rationale: "solid" },
                { id: "completeness", score: 4 },
                { id: "clarity", score: 4 },
              ],
              overall: 0.85,
              explanation: "Good answer.",
            }),
          },
        }) as unknown as ChatResponse,
    } as unknown as ModelGateway;
    const judge = new LlmJudge({ modelGateway: gateway });
    const evaluator = new JudgeEvaluator({ judge });
    const metrics = await evaluator.evaluate(
      scenario({ expected: { rubricId: "builtin:answer-quality" } }),
      observation(),
    );
    const overall = metrics.find((m) => m.metricId === "judge.overall");
    expect(overall?.value).toBeGreaterThan(0.7);
    expect(overall?.pass).toBe(true);
    expect(metrics.find((m) => m.metricId === "judge.criterion.correctness")?.value).toBe(1);

    const broken = {
      route: async () => {
        throw new Error("model down");
      },
    } as unknown as ModelGateway;
    const failing = await new JudgeEvaluator({ judge: new LlmJudge({ modelGateway: broken }) }).evaluate(
      scenario({ expected: { rubricId: "builtin:answer-quality" } }),
      observation(),
    );
    expect(failing[0].metricId).toBe("judge.overall");
    expect(failing[0].pass).toBe(false);
    expect(failing[0].details).toContain("judge failed");
  });

  it("EvaluatorRegistry composes evaluators and collects errors", async () => {
    const registry = new EvaluatorRegistry().register(new RuleEvaluator());
    expect(() => registry.register(new RuleEvaluator())).toThrow("already registered");
    const { metrics, errors } = await registry.evaluateAll(scenario(), observation());
    expect(metrics.length).toBeGreaterThan(5);
    expect(errors).toEqual([]);
  });
});

describe("observeExecution", () => {
  it("pairs tool events by id into observed calls", () => {
    const events: ExecutionEvent[] = [
      { type: "tool.started", id: "tc1", name: "read_file", args: { path: "a" } },
      { type: "tool.completed", id: "tc1", result: {} },
      { type: "tool.started", id: "tc2", name: "shell", args: { cmd: "ls" } },
      { type: "tool.failed", id: "tc2", error: "exit 1" },
      { type: "tool.started", id: "tc3", name: "git", args: { op: "status" } }, // never resolves
      { type: "model.answered", tier: "local", model: "qwen3" },
      { type: "execution.reasoning", text: "thinking" },
    ];
    const observation = observeExecution({
      scenario: scenario(),
      runId: "r1",
      agentId: "devagent",
      status: "completed",
      output: "done",
      events,
      startedAt: 0,
      elapsedMs: 100,
    });
    expect(observation.toolCalls).toEqual([
      { name: "read_file", args: { path: "a" }, ok: true },
      { name: "shell", args: { cmd: "ls" }, ok: false, error: "exit 1" },
      { name: "git", args: { op: "status" }, ok: false, error: "unresolved" },
    ]);
    expect(observation.modelCalls).toHaveLength(1);
    expect(observation.turns).toBe(3); // max(reasoning=1, toolCalls=3)
  });
});

describe("EvaluationRunner", () => {
  const dataset = defineDataset({
    id: "ds:test",
    name: "Test dataset",
    scenarios: [
      scenario({ id: "passing", expected: { finalOutputContains: ["package name"] } }),
      scenario({ id: "failing", expected: { finalOutputContains: ["never appears"], forbiddenTools: ["git"] } }),
      scenario({
        id: "forbidden",
        expected: { forbiddenTools: ["delete_file"] },
      }),
    ],
  });

  function harnessFor(s: Scenario): TrajectoryObservation {
    if (s.id === "forbidden") {
      return observation({
        scenarioId: s.id,
        status: "completed",
        output: "done",
        toolCalls: [{ name: "delete_file", args: {}, ok: true }],
      });
    }
    return observation({ scenarioId: s.id, status: s.id === "failing" ? "failed" : "completed" });
  }

  it("runs scenarios, evaluates, and aggregates the report", async () => {
    const completed: string[] = [];
    const runner = new EvaluationRunner(new FunctionHarness(harnessFor), {
      concurrency: 2,
      onScenarioComplete: (r) => completed.push(r.scenarioId),
    });
    const report = await runner.run(dataset);

    expect(report.datasetId).toBe("ds:test");
    expect(report.summary.total).toBe(3);
    expect(completed).toHaveLength(3);
    const byId = new Map(report.results.map((r) => [r.scenarioId, r]));
    expect(byId.get("passing")?.pass).toBe(true);
    expect(byId.get("failing")?.pass).toBe(false);
    expect(byId.get("forbidden")?.pass).toBe(false);
    expect(report.pass).toBe(false);
    expect(report.summary.metricAverages["goal.completion"]).toBeDefined();
    expect(report.results.map((r) => r.scenarioId)).toEqual(["failing", "forbidden", "passing"]);
  });

  it("applies dataset-level thresholds", async () => {
    const runner = new EvaluationRunner(new FunctionHarness(harnessFor), {
      thresholds: [{ metricId: "goal.completion", min: 0.99 }],
    });
    const report = await runner.run(dataset);
    expect(report.pass).toBe(false);

    const lenient = new EvaluationRunner(new FunctionHarness(harnessFor), {
      thresholds: [{ metricId: "goal.completion", min: 0.1 }],
    });
    const lenientReport = await lenient.run(dataset);
    expect(lenientReport.summary.metricAverages["goal.completion"]).toBeGreaterThanOrEqual(0.1);
  });

  it("records harness failures as errored scenarios, not crashes", async () => {
    const runner = new EvaluationRunner(
      new FunctionHarness(() => {
        throw new Error("harness exploded");
      }),
    );
    const report = await runner.run(defineDataset({ id: "ds:err", name: "Err", scenarios: [scenario()] }));
    expect(report.results[0].error).toContain("harness exploded");
    expect(report.results[0].pass).toBe(false);
    expect(report.summary.errors).toBe(1);
  });

  it("times out hung scenarios", async () => {
    const runner = new EvaluationRunner(
      new FunctionHarness(
        () =>
          new Promise<TrajectoryObservation>(() => {
            /* never resolves */
          }),
      ),
      { scenarioTimeoutMs: 50 },
    );
    const report = await runner.run(defineDataset({ id: "ds:hang", name: "Hang", scenarios: [scenario()] }));
    expect(report.results[0].error).toContain("timed out");
  });
});

describe("regression gating + reports", () => {
  const base: EvaluationReport = {
    datasetId: "ds",
    datasetName: "DS",
    runAt: "2026-01-01T00:00:00.000Z",
    pass: true,
    summary: {
      total: 2,
      passed: 2,
      failed: 0,
      errors: 0,
      passRate: 1,
      metricAverages: { "goal.completion": 0.95, "tool.selection": 0.9 },
    },
    results: [],
  };

  it("detects metric regressions beyond policy and respects warn mode", () => {
    const current: EvaluationReport = {
      ...base,
      summary: { ...base.summary, metricAverages: { "goal.completion": 0.7, "tool.selection": 0.9 } },
    };
    const policy = { rules: [{ metricId: "goal.completion", maxRegression: 0.1 }] };
    const result = compareReports(base, current, policy);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].delta).toBeCloseTo(-0.25, 2);
    expect(result.pass).toBe(false);
    expect(renderRegression(result)).toContain("goal.completion");

    const warn = compareReports(base, current, { rules: policy.rules, mode: "warn" });
    expect(warn.pass).toBe(true);

    const withinPolicy = compareReports(
      base,
      { ...base, summary: { ...base.summary, metricAverages: { "goal.completion": 0.88, "tool.selection": 0.9 } } },
      policy,
    );
    expect(withinPolicy.pass).toBe(true);
  });

  it("renders markdown and persists reports with baselines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-eval-"));
    try {
      const markdown = renderMarkdownReport({ ...base, results: [] });
      expect(markdown).toContain("# Evaluation report — DS");
      expect(markdown).toContain("✅ PASS");

      const store = new ReportStore(dir);
      const savedPath = await store.save(base);
      expect(savedPath).toContain("ds-");
      const loaded = await store.load(savedPath.split("/").pop() as string);
      expect(loaded.datasetId).toBe("ds");

      await store.save({ ...base, runAt: "2026-02-02T00:00:00.000Z" });
      const latest = await store.latestFor("ds");
      expect(latest?.runAt).toBe("2026-02-02T00:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
