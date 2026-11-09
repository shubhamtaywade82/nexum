import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator, OrchestratorError } from "../../src/orchestration/orchestrator.js";
import { PlanStep, StepRunner, Planner, StepOutcome } from "../../src/orchestration/types.js";
import { CheckpointStore, sanitizeResumedSteps } from "../../src/runtime/checkpoint.js";

const noopLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeStep(id: string, dependencies: string[] = [], rollbackCommand?: string): PlanStep {
  return { id, description: id, status: "pending", dependencies, retryCount: 0, rollbackCommand };
}

class StubPlanner implements Planner {
  constructor(private readonly next: (remaining: PlanStep[]) => PlanStep[] = () => []) {}
  async replan(remaining: PlanStep[]): Promise<PlanStep[]> {
    return this.next(remaining);
  }
}

describe("Orchestrator", () => {
  it("executes steps in dependency order", async () => {
    const steps = [makeStep("b", ["a"]), makeStep("a")];
    const executed: string[] = [];
    const runner: StepRunner = {
      async run(step) {
        executed.push(step.id);
        return { kind: "success", output: {} };
      },
    };

    const orchestrator = new Orchestrator({
      steps,
      runner,
      planner: new StubPlanner(),
      runRollback: async () => {},
      logger: noopLogger,
    });
    await orchestrator.run();

    expect(executed).toEqual(["a", "b"]);
  });

  it("retries a retryable failure up to the cap, then triggers a re-plan", async () => {
    const steps = [makeStep("a")];
    let attempts = 0;
    const runner: StepRunner = {
      async run(): Promise<StepOutcome> {
        attempts += 1;
        return { kind: "retryable", error: "transient" };
      },
    };
    let replanCalled = false;
    const planner = new StubPlanner((_remaining) => {
      replanCalled = true;
      return [];
    });

    const orchestrator = new Orchestrator({ steps, runner, planner, runRollback: async () => {}, logger: noopLogger });
    await orchestrator.run();

    expect(attempts).toBe(4);
    expect(replanCalled).toBe(true);
  });

  it("cascades a failure to dependent steps as skipped", async () => {
    const steps = [makeStep("a"), makeStep("b", ["a"]), makeStep("c", ["b"])];
    const runner: StepRunner = {
      async run(step): Promise<StepOutcome> {
        if (step.id === "a") return { kind: "blocking", error: "missing file" };
        return { kind: "success", output: {} };
      },
    };

    const orchestrator = new Orchestrator({
      steps,
      runner,
      planner: new StubPlanner(),
      runRollback: async () => {},
      logger: noopLogger,
    });
    const result = await orchestrator.run();

    const byId = Object.fromEntries(result.map((s) => [s.id, s.status]));
    expect(byId.a).toBe("failed");
    expect(byId.b).toBe("skipped");
    expect(byId.c).toBe("skipped");
  });

  it("rolls back completed steps in reverse chronological order when a later step fails", async () => {
    const steps = [makeStep("a", [], "rollback-a"), makeStep("b", ["a"], "rollback-b"), makeStep("c", ["b"])];
    const runner: StepRunner = {
      async run(step): Promise<StepOutcome> {
        if (step.id === "c") return { kind: "blocking", error: "cannot generate file" };
        return { kind: "success", output: {} };
      },
    };
    const rolledBack: string[] = [];

    const orchestrator = new Orchestrator({
      steps,
      runner,
      planner: new StubPlanner(),
      runRollback: async (cmd) => {
        rolledBack.push(cmd);
      },
      logger: noopLogger,
    });
    await orchestrator.run();

    expect(rolledBack).toEqual(["rollback-b", "rollback-a"]);
  });

  it("runs independent steps concurrently instead of one at a time", async () => {
    // "coder" and "reviewer" both depend only on "planner" — once it
    // completes they should overlap in-flight, not run sequentially.
    const steps = [makeStep("planner"), makeStep("coder", ["planner"]), makeStep("reviewer", ["planner"])];
    const inFlight = new Set<string>();
    let maxConcurrent = 0;

    const runner: StepRunner = {
      async run(step) {
        inFlight.add(step.id);
        maxConcurrent = Math.max(maxConcurrent, inFlight.size);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight.delete(step.id);
        return { kind: "success", output: {} };
      },
    };

    const orchestrator = new Orchestrator({
      steps,
      runner,
      planner: new StubPlanner(),
      runRollback: async () => {},
      logger: noopLogger,
    });
    await orchestrator.run();

    expect(maxConcurrent).toBe(2);
  });

  it("does not start a dependent step until its dependency's batch has completed", async () => {
    const steps = [makeStep("a"), makeStep("b", ["a"])];
    const startOrder: string[] = [];
    const runner: StepRunner = {
      async run(step) {
        startOrder.push(step.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: "success", output: {} };
      },
    };

    const orchestrator = new Orchestrator({
      steps,
      runner,
      planner: new StubPlanner(),
      runRollback: async () => {},
      logger: noopLogger,
    });
    await orchestrator.run();

    expect(startOrder).toEqual(["a", "b"]);
  });

  it("throws on a dependency cycle", async () => {
    const steps = [makeStep("a", ["b"]), makeStep("b", ["a"])];
    const orchestrator = new Orchestrator({
      steps,
      runner: { run: async () => ({ kind: "success", output: {} }) },
      planner: new StubPlanner(),
      runRollback: async () => {},
      logger: noopLogger,
    });

    await expect(orchestrator.run()).rejects.toThrow(OrchestratorError);
  });

  it("aborts after exceeding the max re-plan count instead of looping forever", async () => {
    let counter = 0;
    const runner: StepRunner = {
      async run(): Promise<StepOutcome> {
        return { kind: "blocking", error: "stuck" };
      },
    };
    const planner = new StubPlanner(() => {
      counter += 1;
      return [makeStep(`a${counter}`)];
    });

    const orchestrator = new Orchestrator({
      steps: [makeStep("a")],
      runner,
      planner,
      runRollback: async () => {},
      logger: noopLogger,
      maxReplans: 2,
    });

    await expect(orchestrator.run()).rejects.toThrow(/re-plans/);
  });

  it("invokes onStepChange with each status transition a step goes through", async () => {
    const transitions: string[] = [];
    const steps = [makeStep("s1")];
    const runner: StepRunner = {
      run: async () => ({ kind: "success", output: {} }),
    };
    const orchestrator = new Orchestrator({
      steps,
      runner,
      planner: new StubPlanner(() => []),
      runRollback: async () => {},
      onStepChange: (step) => transitions.push(`${step.id}:${step.status}`),
    });

    await orchestrator.run();

    expect(transitions).toEqual([
      "s1:analyzing",
      "s1:planning",
      "s1:implementing",
      "s1:testing",
      "s1:reviewing",
      "s1:completed",
    ]);
  });
});

describe("Orchestrator checkpointing", () => {
  let dir: string;
  let checkpointPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orchestrator-checkpoint-"));
    checkpointPath = join(dir, "checkpoint.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("clears the checkpoint once the whole plan completes", async () => {
    const checkpoint = new CheckpointStore(checkpointPath);
    const steps = [makeStep("a"), makeStep("b", ["a"])];
    const orchestrator = new Orchestrator({
      steps,
      runner: { run: async () => ({ kind: "success", output: {} }) },
      planner: new StubPlanner(),
      runRollback: async () => {},
      logger: noopLogger,
      checkpoint,
    });

    await orchestrator.run();

    expect(checkpoint.load()).toBeNull();
  });

  it("leaves a checkpoint behind mid-run that reflects progress so far", async () => {
    const checkpoint = new CheckpointStore(checkpointPath);
    const steps = [makeStep("a"), makeStep("b", ["a"])];
    let seenMidRunSnapshot: string[] | null = null;

    const runner: StepRunner = {
      async run(step) {
        if (step.id === "a") {
          // Simulate a crash right after "a" finishes but before "b" starts:
          // read the checkpoint a fresh CheckpointStore instance would see.
          const snapshot = new CheckpointStore(checkpointPath).load();
          seenMidRunSnapshot = snapshot?.steps.map((s) => `${s.id}:${s.status}`) ?? null;
        }
        return { kind: "success", output: {} };
      },
    };

    const orchestrator = new Orchestrator({
      steps,
      runner,
      planner: new StubPlanner(),
      runRollback: async () => {},
      logger: noopLogger,
      checkpoint,
    });
    await orchestrator.run();

    expect(seenMidRunSnapshot).toEqual(expect.arrayContaining(["a:implementing", "b:pending"]));
  });

  it("resumes an interrupted plan without re-running completed steps", async () => {
    // "a" already completed before the crash; "b" was mid-flight (implementing)
    // when the process died, so its outcome is unknown.
    const crashedSteps: PlanStep[] = [
      { id: "a", description: "a", status: "completed", dependencies: [], retryCount: 0 },
      { id: "b", description: "b", status: "implementing", dependencies: ["a"], retryCount: 0 },
    ];
    const checkpoint = new CheckpointStore(checkpointPath);
    checkpoint.save({ steps: crashedSteps, history: [], replanCount: 0 });

    const executed: string[] = [];
    const runner: StepRunner = {
      async run(step) {
        executed.push(step.id);
        return { kind: "success", output: {} };
      },
    };

    const saved = checkpoint.load()!;
    const orchestrator = new Orchestrator({
      steps: sanitizeResumedSteps(saved.steps),
      runner,
      planner: new StubPlanner(),
      runRollback: async () => {},
      logger: noopLogger,
      checkpoint,
    });
    const result = await orchestrator.run();

    expect(executed).toEqual(["b"]);
    expect(result.find((s) => s.id === "a")?.status).toBe("completed");
    expect(result.find((s) => s.id === "b")?.status).toBe("completed");
    expect(checkpoint.load()).toBeNull();
  });
});

// CheckpointStore has persisted history and replanCount all along, but
// Orchestrator had no way to accept them, so Agent.resumePlannedTask dropped
// both: a resumed run replanned with an empty history (the model never saw the
// failures that caused the checkpoint) and with the replan budget reset to
// zero (so a crash-loop could never exhaust it).
describe("Orchestrator resume state", () => {
  it("carries a checkpoint's history into the planner", async () => {
    const priorHistory = [{ stepId: "a", outcome: { kind: "fatal", error: "compile error" } as StepOutcome, at: 1 }];
    const seen: unknown[] = [];
    const planner: Planner = {
      async replan(_remaining, history) {
        seen.push(...history);
        return [];
      },
    };
    const runner: StepRunner = {
      async run() {
        return { kind: "fatal", error: "still broken" };
      },
    };

    const orchestrator = new Orchestrator({
      steps: [makeStep("a")],
      runner,
      planner,
      runRollback: jest.fn(async () => {}),
      logger: noopLogger,
      history: priorHistory,
    });
    await orchestrator.run();

    expect(seen).toContainEqual(priorHistory[0]);
  });

  it("resumes the replan budget instead of restarting it", async () => {
    const planner = new StubPlanner((remaining) => remaining.map((s) => ({ ...s, status: "pending" as const })));
    const runner: StepRunner = {
      async run() {
        return { kind: "fatal", error: "always fails" };
      },
    };

    const orchestrator = new Orchestrator({
      steps: [makeStep("a")],
      runner,
      planner,
      runRollback: jest.fn(async () => {}),
      logger: noopLogger,
      maxReplans: 3,
      replanCount: 3, // budget already spent before the crash
    });

    await expect(orchestrator.run()).rejects.toThrow(OrchestratorError);
  });

  it("does not mutate the caller's history array", async () => {
    const priorHistory = [{ stepId: "a", outcome: { kind: "success", output: {} } as StepOutcome, at: 1 }];
    const orchestrator = new Orchestrator({
      steps: [makeStep("a")],
      runner: {
        async run() {
          return { kind: "success", output: {} };
        },
      },
      planner: new StubPlanner(),
      runRollback: jest.fn(async () => {}),
      logger: noopLogger,
      history: priorHistory,
    });
    await orchestrator.run();

    expect(priorHistory).toHaveLength(1);
  });
});

// A planner revision is model output. Each malformed revision must be rejected
// without crashing the run and without writing a corrupted graph to the checkpoint.
describe("Orchestrator replan validation", () => {
  let dir: string;
  let checkpointPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orchestrator-revision-"));
    checkpointPath = join(dir, "checkpoint.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** "a" completes, "x" fails permanently, "y" waits on "a": the batch-1 failure triggers a replan with remaining=[y]. */
  function runnerFailingX(executed: string[]): StepRunner {
    return {
      async run(step) {
        executed.push(step.id);
        return step.id === "x" ? { kind: "blocking", error: "broken" } : { kind: "success", output: {} };
      },
    };
  }

  it("rejects a revision that overwrites a completed step instead of re-running it", async () => {
    const executed: string[] = [];
    const warn = jest.fn();
    const planner: Planner = {
      async replan() {
        return [makeStep("a"), makeStep("z")];
      },
    };
    const orchestrator = new Orchestrator({
      steps: [makeStep("a"), makeStep("x"), makeStep("y", ["a"])],
      runner: runnerFailingX(executed),
      planner,
      runRollback: async () => {},
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    const result = await orchestrator.run();

    expect(executed.filter((id) => id === "a")).toHaveLength(1);
    expect(executed).not.toContain("z");
    expect(executed).toContain("y");
    expect(result.find((s) => s.id === "a")?.status).toBe("completed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("overwrites completed step a"));
  });

  it("rejects a revision with an unknown dependency without crashing or checkpointing it", async () => {
    const executed: string[] = [];
    const checkpoint = new CheckpointStore(checkpointPath);
    const saveSpy = jest.spyOn(checkpoint, "save");
    const planner: Planner = {
      async replan() {
        return [makeStep("y", ["ghost"])];
      },
    };
    const orchestrator = new Orchestrator({
      steps: [makeStep("a"), makeStep("x"), makeStep("y", ["a"])],
      runner: runnerFailingX(executed),
      planner,
      runRollback: async () => {},
      logger: noopLogger,
      checkpoint,
    });

    await expect(orchestrator.run()).resolves.toBeDefined();
    expect(executed).toContain("y"); // the original step still runs
    for (const [data] of saveSpy.mock.calls) {
      expect(data.steps.map((s) => s.id)).not.toContain("ghost");
    }
  });

  it("rejects a revision containing a dependency cycle", async () => {
    const executed: string[] = [];
    const warn = jest.fn();
    const planner: Planner = {
      async replan() {
        return [makeStep("c", ["d"]), makeStep("d", ["c"])];
      },
    };
    const orchestrator = new Orchestrator({
      steps: [makeStep("a"), makeStep("x"), makeStep("y", ["a"])],
      runner: runnerFailingX(executed),
      planner,
      runRollback: async () => {},
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    const result = await orchestrator.run();

    expect(executed).not.toContain("c");
    expect(executed).not.toContain("d");
    expect(result.map((s) => s.id)).toEqual(["a", "x", "y"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("can never run"));
  });

  it("rejects a revision that depends on a failed step, which can never complete", async () => {
    const executed: string[] = [];
    const warn = jest.fn();
    const planner: Planner = {
      async replan() {
        return [makeStep("b", ["a"])];
      },
    };
    const runner: StepRunner = {
      async run(step) {
        executed.push(step.id);
        return { kind: "blocking", error: "broken" };
      },
    };
    const orchestrator = new Orchestrator({
      steps: [makeStep("a"), makeStep("b", ["a"])],
      runner,
      planner,
      runRollback: async () => {},
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    const result = await orchestrator.run();

    expect(executed).toEqual(["a"]);
    expect(result.find((s) => s.id === "b")?.status).toBe("skipped");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dependency a is failed"));
  });

  it("rejects a revision that is not an array", async () => {
    const warn = jest.fn();
    const planner: Planner = {
      replan: async () => undefined as unknown as PlanStep[],
    };
    const orchestrator = new Orchestrator({
      steps: [makeStep("a")],
      runner: {
        async run(): Promise<StepOutcome> {
          return { kind: "blocking", error: "broken" };
        },
      },
      planner,
      runRollback: async () => {},
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    const result = await orchestrator.run();

    expect(result[0].status).toBe("failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not an array"));
  });

  it("adopts a valid revision and normalizes planner-supplied status and retry budget", async () => {
    const executed: string[] = [];
    const planner: Planner = {
      async replan(remaining) {
        expect(remaining.map((s) => s.id)).toEqual(["b"]);
        return [
          // A planner may not mint a completed step: "a" re-enters as pending and must actually run.
          { ...makeStep("a"), status: "completed", retryCount: 7 },
          { ...makeStep("b", ["a"]), status: "skipped" },
        ];
      },
    };
    let attempts = 0;
    const runner: StepRunner = {
      async run(step) {
        executed.push(step.id);
        if (step.id !== "a") return { kind: "success", output: {} };
        attempts += 1;
        return attempts === 1 ? { kind: "blocking", error: "first try fails" } : { kind: "success", output: {} };
      },
    };
    const orchestrator = new Orchestrator({
      steps: [makeStep("a"), makeStep("b", ["a"])],
      runner,
      planner,
      runRollback: async () => {},
      logger: noopLogger,
    });
    const result = await orchestrator.run();

    expect(executed).toEqual(["a", "a", "b"]);
    expect(result).toEqual([
      expect.objectContaining({ id: "a", status: "completed", retryCount: 0 }),
      expect.objectContaining({ id: "b", status: "completed" }),
    ]);
  });
});
