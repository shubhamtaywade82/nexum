import { HarnessRegistry } from "../../src/evolution/registry.js";
import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import { ActivationMonitor } from "../../src/evolution/monitoring/activation-monitor.js";
import {
  RuntimeActivationController,
  RuntimeRollbackError,
} from "../../src/evolution/monitoring/runtime-activation.js";

/** Fake runtime integration: tracks the currently executing harness. */
class FakeRuntime implements RuntimeActivationController {
  readonly name = "fake-runtime";
  active = "H1";
  switchedTo: string[] = [];
  freezeCount = 0;
  failSwitchTo?: string;
  healthy: Record<string, boolean> = { H0: true, H1: true };

  activeHarness(): string {
    return this.active;
  }

  async switchTo(harnessId: string): Promise<void> {
    if (this.failSwitchTo === harnessId) throw new Error(`cannot load ${harnessId}`);
    this.switchedTo.push(harnessId);
    this.active = harnessId;
  }

  async harnessHealth(harnessId: string): Promise<boolean> {
    return this.healthy[harnessId] ?? true;
  }

  async freeze(): Promise<void> {
    this.freezeCount++;
  }
}

describe("ClosedLoopEngine runtime activation rollback", () => {
  let registry: HarnessRegistry;
  let monitor: ActivationMonitor;
  let runtime: FakeRuntime;
  let engine: ClosedLoopEngine;

  beforeEach(() => {
    registry = new HarnessRegistry(":memory:");
    monitor = new ActivationMonitor({ minSampleSize: 10 });
    runtime = new FakeRuntime();
    engine = new ClosedLoopEngine({
      registry,
      monitor,
      runtimeActivation: runtime,
      executorModels: ["qwen"],
    });
  });

  afterEach(() => {
    registry.close();
  });

  function setupActiveExperiment(): void {
    registry.saveVersion({
      id: "H0",
      commitSha: "sha-h0",
      parentId: null,
      createdAt: Date.now(),
      targetComponent: "execution",
      hypothesis: "baseline",
      metrics: {
        capability: { taskSuccessRate: 0.6, verificationPassRate: 0.8 },
        reliability: { toolErrorRate: 0.2, falseSuccessRate: 0.1, loopAbortRate: 0.1 },
        efficiency: { avgTokens: 2000, avgLatencyMs: 1200 },
        generalization: { heldOutScore: 0.5, transferScore: 0.5 },
      },
      status: "promoted",
    });
    engine.metrics.record({
      versionId: "H1",
      parentVersionId: "H0",
      visibleGain: 0.1,
      heldOutGain: 0.05,
      transferGain: 0.05,
      promoted: true,
      genuinelyBetterOnHeldOut: true,
      accepted: false,
      rolledBack: false,
      retainedBySuccessor: "unknown",
      executorModels: ["qwen"],
      executorSensitivity: 0,
    });
    engine.experiments.startExperiment({
      id: "exp-rt-1",
      parentHarness: "H0",
      parentCommit: "sha-h0",
      candidateHarness: "H1",
      candidateCommit: "sha-h1",
      targetId: "t1",
      targetCapability: "tool_utilization",
      desiredOutcome: "fewer tool errors",
      hypothesisId: "hyp-1",
      hypothesisStatement: "prune schemas",
      predictedEffect: "reliability +10%",
      executorPrimary: "qwen",
      executorTransfer: [],
    });
    registry.saveVersion({
      id: "H1",
      commitSha: "sha-h1",
      parentId: "H0",
      createdAt: Date.now(),
      targetComponent: "tools",
      hypothesis: "prune schemas",
      metrics: {
        capability: { taskSuccessRate: 0.7, verificationPassRate: 0.85 },
        reliability: { toolErrorRate: 0.15, falseSuccessRate: 0.08, loopAbortRate: 0.08 },
        efficiency: { avgTokens: 1900, avgLatencyMs: 1100 },
        generalization: { heldOutScore: 0.55, transferScore: 0.55 },
      },
      status: "validated",
    });
    for (const s of ["EVALUATING", "VALIDATED", "GENERALIZED", "ELIGIBLE", "DELIVERED"] as const) {
      engine.experiments.advance("exp-rt-1", s);
    }
    engine.reportCi("exp-rt-1", true);
    engine.reportReview("exp-rt-1", true, "maintainer");
    expect(engine.finalizeAcceptance("exp-rt-1")).toBe(true);
  }

  function sample(over: Partial<Record<string, number>> = {}) {
    return {
      at: Date.now(),
      harnessId: "H1",
      experimentId: "exp-rt-1",
      episodes: 10,
      taskSuccessRate: 0.6,
      falseSuccessRate: 0.1,
      toolErrorRate: 0.2,
      loopAbortRate: 0.1,
      verificationFailureRate: 0.2,
      avgTokens: 2000,
      avgLatencyMs: 1200,
      ...over,
    };
  }

  it("runtime rollback: freeze → switch → verify → persist (REGRESSED → ROLLBACK → ACTIVE)", async () => {
    setupActiveExperiment();
    expect(runtime.active).toBe("H1");
    monitor.ingest(sample({ taskSuccessRate: 0.4 })); // −33%: hard regression

    const health = await engine.evaluateActivationLive("exp-rt-1");
    expect(health!.status).toBe("regressed");

    // The runtime actually switched back to the parent.
    expect(runtime.active).toBe("H0");
    expect(runtime.freezeCount).toBe(1);
    expect(runtime.switchedTo).toEqual(["H0"]);

    // Registry lineage rolled back to the parent.
    expect(registry.getActiveVersion()?.id).toBe("H0");

    // Lifecycle walked ACTIVE → REGRESSED → ROLLBACK → ACTIVE(prior).
    const record = engine.experiments.record("exp-rt-1");
    expect(record.lifecycle.state).toBe("ACTIVE");
    const states = engine.experiments
      .machine("exp-rt-1")
      .transitions()
      .map((t) => t.to);
    expect(states).toContain("REGRESSED");
    expect(states).toContain("ROLLBACK");

    const switchRecord = engine.metrics.records().find((s) => s.versionId === "H1");
    expect(switchRecord?.rolledBack).toBe(true);
  });

  it("rolls back explicitly via rollbackActive and returns the audit report", async () => {
    setupActiveExperiment();
    const report = await engine.rollbackActive("exp-rt-1", "manual regression call");
    expect(report).not.toBeNull();
    expect(report!.ok).toBe(true);
    expect(report!.fromHarness).toBe("H1");
    expect(report!.toHarness).toBe("H0");
    expect(report!.runtimeSwitched).toBe(true);
    expect(report!.verifiedHealthy).toBe(true);
    expect(report!.registryRolledBack).toBe(true);
    expect(report!.lifecycleState).toBe("ACTIVE");
    expect(report!.steps.map((s) => s.step)).toEqual([
      "freeze",
      "regression_reported",
      "runtime_switch",
      "health_verification",
      "rollback_recorded",
      "registry_rolled_back",
      "reactivation_recorded",
    ]);
  });

  it("refuses to persist the rollback when the parent fails post-switch health verification", async () => {
    setupActiveExperiment();
    runtime.healthy.H0 = false;
    monitor.ingest(sample({ taskSuccessRate: 0.4 }));

    await expect(engine.evaluateActivationLive("exp-rt-1")).rejects.toBeInstanceOf(RuntimeRollbackError);

    // The runtime was restored to the original (regressed) harness and the
    // experiment stays honestly at REGRESSED — no silent "fixed" claim.
    expect(runtime.active).toBe("H1");
    expect(engine.experiments.record("exp-rt-1").lifecycle.state).toBe("REGRESSED");
    // Registry untouched: the rollback was NOT completed.
    expect(registry.getActiveVersion()?.id).toBe("H1");
  });

  it("stays at REGRESSED when the runtime cannot load the parent at all", async () => {
    setupActiveExperiment();
    runtime.failSwitchTo = "H0";
    monitor.ingest(sample({ taskSuccessRate: 0.4 }));

    await expect(engine.evaluateActivationLive("exp-rt-1")).rejects.toThrow(/cannot load H0/);
    expect(engine.experiments.record("exp-rt-1").lifecycle.state).toBe("REGRESSED");
    expect(runtime.active).toBe("H1");
  });

  it("treats freeze failures as non-blocking (rollback still completes)", async () => {
    setupActiveExperiment();
    runtime.freeze = () => {
      throw new Error("freeze endpoint down");
    };
    monitor.ingest(sample({ taskSuccessRate: 0.4 }));

    const health = await engine.evaluateActivationLive("exp-rt-1");
    expect(health!.status).toBe("regressed");
    expect(runtime.active).toBe("H0");
    expect(engine.experiments.record("exp-rt-1").lifecycle.state).toBe("ACTIVE");
  });

  it("activateOnRuntime refuses a locally finalized candidate without verified merge evidence", async () => {
    setupActiveExperiment(); // ACTIVE by local finalization: no merge was ever confirmed
    runtime.active = "H0"; // simulate the runtime still being on the parent
    const result = await engine.activateOnRuntime("exp-rt-1", undefined as never);
    expect(result.ok).toBe(false);
    expect(runtime.active).toBe("H0");
    expect(runtime.switchedTo).toEqual([]);
  });

  it("without a runtime controller, evaluateActivationLive falls back to logical rollback", async () => {
    const logicalEngine = new ClosedLoopEngine({
      registry,
      monitor,
      experimentController: engine.experiments,
      metricsTracker: engine.metrics,
      executorModels: ["qwen"],
    });
    // Rebuild the active experiment on the shared registry/monitor.
    setupActiveExperiment();
    monitor.ingest(sample({ taskSuccessRate: 0.4 }));

    const health = await logicalEngine.evaluateActivationLive("exp-rt-1");
    expect(health!.status).toBe("regressed");
    expect(registry.getActiveVersion()?.id).toBe("H0");
    // Legacy logical path parks at ROLLBACK (runtime state unknown).
    expect(logicalEngine.experiments.record("exp-rt-1").lifecycle.state).toBe("ROLLBACK");
  });

  it("beginRework re-enters the loop from CI_FAILED and CHANGES_REQUESTED", () => {
    engine.experiments.startExperiment({
      id: "exp-rework-1",
      parentHarness: "H0",
      parentCommit: "sha-h0",
      candidateHarness: "H2",
      candidateCommit: "sha-h2",
      targetId: "t2",
      targetCapability: "tool_utilization",
      desiredOutcome: "fewer tool errors",
      hypothesisId: "hyp-2",
      hypothesisStatement: "tighten schemas",
      predictedEffect: "reliability +5%",
      executorPrimary: "qwen",
      executorTransfer: [],
    });
    for (const s of ["EVALUATING", "VALIDATED", "GENERALIZED", "ELIGIBLE", "DELIVERED"] as const) {
      engine.experiments.advance("exp-rework-1", s);
    }
    engine.reportCi("exp-rework-1", false);
    expect(engine.experiments.record("exp-rework-1").lifecycle.state).toBe("CI_FAILED");

    expect(engine.beginRework("exp-rework-1")).toBe(true);
    expect(engine.experiments.record("exp-rework-1").lifecycle.state).toBe("CANDIDATE");
    // A second re-entry is not legal from CANDIDATE.
    expect(engine.beginRework("exp-rework-1")).toBe(false);
  });
});
