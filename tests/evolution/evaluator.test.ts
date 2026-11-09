import { CandidateEvaluator, flakyTaskIds, TaskExecutionResult } from "../../src/evolution/evaluator.js";

describe("CandidateEvaluator", () => {
  const evaluator = new CandidateEvaluator();

  it("aggregates execution results into accurate metrics", () => {
    const results: TaskExecutionResult[] = [
      {
        taskId: "t1",
        success: true,
        verificationPassed: true,
        toolCalls: 4,
        toolErrors: 0,
        tokens: 5000,
        latencyMs: 1200,
        loopAborted: false,
        isHeldOut: false,
      },
      {
        taskId: "t2",
        success: false,
        verificationPassed: false,
        toolCalls: 6,
        toolErrors: 2,
        tokens: 7000,
        latencyMs: 2000,
        loopAborted: false,
        isHeldOut: true,
      },
    ];

    const metrics = evaluator.aggregateResults(results);
    expect(metrics.capability.taskSuccessRate).toBe(0.5);
    expect(metrics.capability.verificationPassRate).toBe(0.5);
    expect(metrics.reliability.toolErrorRate).toBe(2 / 10);
    expect(metrics.efficiency.avgTokens).toBe(6000);
    expect(metrics.efficiency.avgLatencyMs).toBe(1600);
    expect(metrics.generalization.heldOutScore).toBe(0); // t2 is held-out and failed
  });

  it("handles empty results safely", () => {
    const metrics = evaluator.aggregateResults([]);
    expect(metrics.capability.taskSuccessRate).toBe(0);
    expect(metrics.efficiency.avgTokens).toBe(0);
  });
});

describe("flakyTaskIds", () => {
  const run = (taskId: string, success: boolean, sample: number): TaskExecutionResult => ({
    taskId,
    success,
    verificationPassed: success,
    toolCalls: 1,
    toolErrors: 0,
    tokens: 10,
    latencyMs: 1,
    loopAborted: false,
    sample,
  });

  it("flags a task whose repeats disagree, and not one that is consistent", () => {
    const results = [
      run("steady-pass", true, 0),
      run("steady-pass", true, 1),
      run("steady-pass", true, 2),
      run("steady-fail", false, 0),
      run("steady-fail", false, 1),
      run("flaky", true, 0),
      run("flaky", false, 1),
      run("flaky", true, 2),
    ];
    expect(flakyTaskIds(results)).toEqual(["flaky"]);
  });

  it("flags nothing when every task ran once", () => {
    expect(flakyTaskIds([run("a", true, 0), run("b", false, 0)])).toEqual([]);
  });
});
