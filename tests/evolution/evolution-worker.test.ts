import { EvolutionWorker, EvolutionCycleResult } from "../../src/evolution/evolution-worker.js";
import { ImprovementTarget } from "../../src/evolution/targets/target-engine.js";

function target(confidence = 0.8): ImprovementTarget {
  return {
    id: "t-1",
    capability: "tool_utilization",
    desiredOutcome: "reduce tool argument validation failures",
    observableSymptoms: ["run_shell argument validation failed"],
    measurableMetrics: ["toolErrorRate"],
    affectedComponents: ["tools"],
    confidence,
    evaluationPlan: { successCriterion: "toolErrorRate decreases", steps: [], executorModels: ["primary"] },
  };
}

describe("EvolutionWorker (persistent policy-controlled loop)", () => {
  function noSleep() {
    return Promise.resolve();
  }

  it("NEVER mutates when no target forms: runCycle is not called even once", async () => {
    const runCycle = jest.fn(async (): Promise<EvolutionCycleResult> => ({ ok: true, detail: "should not run" }));
    const worker = new EvolutionWorker({
      observe: async () => ({ target: null }),
      runCycle,
      maxCycles: 3,
      maxIdleTicks: 3,
      sleep: noSleep,
    });
    const summary = await worker.run();
    expect(runCycle).not.toHaveBeenCalled();
    expect(summary.cyclesStarted).toBe(0);
    expect(summary.idleTicks).toBe(3);
    expect(summary.stoppedReason).toBe("max-idle-ticks");
  });

  it("gathers evidence instead of mutating when target confidence is below the policy threshold", async () => {
    const runCycle = jest.fn(async (): Promise<EvolutionCycleResult> => ({ ok: true, detail: "should not run" }));
    const worker = new EvolutionWorker({
      observe: async () => ({ target: target(0.4) }),
      runCycle,
      minTargetConfidence: 0.5,
      maxIdleTicks: 2,
      sleep: noSleep,
    });
    const summary = await worker.run();
    expect(runCycle).not.toHaveBeenCalled();
    expect(summary.cyclesStarted).toBe(0);
    expect(summary.idleTicks).toBe(2);
    expect(summary.stoppedReason).toBe("max-idle-ticks");
  });

  it("runs a cycle when a confident target exists, then respects maxCycles", async () => {
    const runCycle = jest.fn(async (): Promise<EvolutionCycleResult> => ({
      ok: true,
      detail: "candidate H1 eligible",
    }));
    const worker = new EvolutionWorker({
      observe: async () => ({ target: target(0.8) }),
      runCycle,
      maxCycles: 2,
      sleep: noSleep,
    });
    const summary = await worker.run();
    expect(runCycle).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ cyclesStarted: 2, cyclesSucceeded: 2, cyclesFailed: 0 });
    expect(summary.stoppedReason).toBe("max-cycles");
  });

  it("stops after the configured number of CONSECUTIVE failures", async () => {
    const runCycle = jest.fn(async (): Promise<EvolutionCycleResult> => ({
      ok: false,
      detail: "stage verify: gate failed",
    }));
    const worker = new EvolutionWorker({
      observe: async () => ({ target: target(0.9) }),
      runCycle,
      maxConsecutiveFailures: 2,
      sleep: noSleep,
    });
    const summary = await worker.run();
    expect(runCycle).toHaveBeenCalledTimes(2);
    expect(summary.cyclesFailed).toBe(2);
    expect(summary.stoppedReason).toBe("consecutive-failures");
  });

  it("resets the consecutive-failure counter after a successful cycle", async () => {
    const results: EvolutionCycleResult[] = [
      { ok: false, detail: "fail 1" },
      { ok: true, detail: "ok 1" },
      { ok: false, detail: "fail 2" },
      { ok: true, detail: "ok 2" },
    ];
    let i = 0;
    const worker = new EvolutionWorker({
      observe: async () => ({ target: target(0.9) }),
      runCycle: async () => results[i++ % results.length],
      maxConsecutiveFailures: 2,
      maxCycles: 4,
      sleep: noSleep,
    });
    const summary = await worker.run();
    expect(summary).toMatchObject({ cyclesStarted: 4, cyclesSucceeded: 2, cyclesFailed: 2 });
    expect(summary.stoppedReason).toBe("max-cycles");
  });

  it("treats a skipped cycle as idle, not a failure", async () => {
    let call = 0;
    const worker = new EvolutionWorker({
      observe: async () => ({ target: target(0.9) }),
      runCycle: async () =>
        call++ === 0 ? { ok: false, skipped: true, detail: "no operationalizable target" } : { ok: true, detail: "ok" },
      maxCycles: 1,
      sleep: noSleep,
    });
    const summary = await worker.run();
    expect(summary.cyclesStarted).toBe(1);
    expect(summary.cyclesSucceeded).toBe(1);
    expect(summary.cyclesFailed).toBe(0);
    expect(summary.idleTicks).toBe(1);
  });

  it("recovers from observe() throwing instead of crashing the loop", async () => {
    let calls = 0;
    const runCycle = jest.fn(async (): Promise<EvolutionCycleResult> => ({ ok: true, detail: "ok" }));
    const worker = new EvolutionWorker({
      observe: async () => {
        calls++;
        if (calls === 1) throw new Error("lessons.db is locked");
        return { target: target(0.9) };
      },
      runCycle,
      maxCycles: 1,
      sleep: noSleep,
    });
    const summary = await worker.run();
    expect(summary.idleTicks).toBe(1);
    expect(summary.cyclesStarted).toBe(1);
    expect(runCycle).toHaveBeenCalledTimes(1);
  });

  it("stop() breaks the loop from outside (SIGINT semantics)", async () => {
    const runCycle = jest.fn(async (): Promise<EvolutionCycleResult> => ({ ok: true, detail: "ok" }));
    const worker = new EvolutionWorker({
      observe: async () => ({ target: target(0.9) }),
      runCycle,
      sleep: async () => {
        worker.stop();
      },
    });
    const summary = await worker.run();
    expect(summary.cyclesStarted).toBe(1);
    expect(summary.stoppedReason).toBe("stopped");
  });

  it("counts a thrown cycle as a failure rather than crashing", async () => {
    const worker = new EvolutionWorker({
      observe: async () => ({ target: target(0.9) }),
      runCycle: async () => {
        throw new Error("worktree exploded");
      },
      maxConsecutiveFailures: 1,
      sleep: noSleep,
    });
    const summary = await worker.run();
    expect(summary.cyclesFailed).toBe(1);
    expect(summary.stoppedReason).toBe("consecutive-failures");
  });
});
