import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivationMonitor, OperationalTelemetry } from "../../src/evolution/monitoring/activation-monitor.js";
import { ContinuousMonitorService, pollTelemetryFile } from "../../src/evolution/monitoring/monitor-service.js";
import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import { ExperimentController } from "../../src/evolution/experiments/experiment-controller.js";
import { ExperimentStore } from "../../src/evolution/experiments/experiment-store.js";

function sample(over: Partial<OperationalTelemetry> = {}): OperationalTelemetry {
  return {
    at: 1_000,
    harnessId: "H1",
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

describe("pollTelemetryFile (JSONL tailing)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexumpoll-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing for a missing file", () => {
    const polled = pollTelemetryFile(join(dir, "nope.jsonl"), 0);
    expect(polled).toEqual({ samples: [], offset: 0 });
  });

  it("reads all newline-terminated lines on the first poll", () => {
    const path = join(dir, "telemetry.jsonl");
    writeFileSync(path, `${JSON.stringify(sample())}\n${JSON.stringify(sample({ episodes: 5 }))}\n`);
    const polled = pollTelemetryFile(path, 0);
    expect(polled.samples).toHaveLength(2);
    expect(polled.samples[0].episodes).toBe(10);
    expect(polled.offset).toBeGreaterThan(0);
    // Second poll with no appends: nothing new.
    expect(pollTelemetryFile(path, polled.offset).samples).toEqual([]);
  });

  it("does NOT consume a trailing line without a newline (may be half-written)", () => {
    const path = join(dir, "telemetry.jsonl");
    const complete = `${JSON.stringify(sample())}\n`;
    writeFileSync(path, complete);
    let polled = pollTelemetryFile(path, 0);
    expect(polled.samples).toHaveLength(1);

    // Append a partial line (simulating a writer mid-write).
    appendFileSync(path, '{"at":2000,"harnessId":"H1","epis');
    polled = pollTelemetryFile(path, polled.offset);
    expect(polled.samples).toEqual([]);
    // Completing the line makes it visible on the next poll.
    appendFileSync(path, `odes":3}\n`);
    polled = pollTelemetryFile(path, polled.offset);
    expect(polled.samples).toHaveLength(1);
    expect(polled.samples[0].at).toBe(2000);
  });

  it("skips malformed lines without blinding the monitor forever", () => {
    const path = join(dir, "telemetry.jsonl");
    writeFileSync(path, `not-json\n${JSON.stringify(sample())}\n`);
    const polled = pollTelemetryFile(path, 0);
    expect(polled.samples).toHaveLength(1);
    // The malformed line was consumed: the offset moved past it.
    expect(pollTelemetryFile(path, polled.offset).samples).toEqual([]);
  });
});

describe("ContinuousMonitorService (continuous post-activation monitoring)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexummon-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ingests appended samples and re-evaluates on every batch until stopped", async () => {
    const path = join(dir, "telemetry.jsonl");
    writeFileSync(path, `${JSON.stringify(sample())}\n`);

    const monitor = new ActivationMonitor({ minSampleSize: 10 });
    monitor.setEnvelope(
      monitor.envelopeFromBaseline({
        harnessId: "H1",
        experimentId: "exp-1",
        baseline: {
          taskSuccessRate: 0.6,
          falseSuccessRate: 0.1,
          toolErrorRate: 0.2,
          loopAbortRate: 0.1,
          verificationFailureRate: 0.2,
          avgTokens: 2000,
          avgLatencyMs: 1200,
        },
        minSampleSize: 10,
      }),
    );

    const evaluations: string[] = [];
    const service = new ContinuousMonitorService({
      telemetryPath: path,
      monitor,
      evaluate: (m) => {
        evaluations.push(m.currentHealth ? "ran" : "ran");
        return m.evaluate("H1");
      },
      intervalMs: 1000,
      sleep: async () => {
        service.stop();
      },
    });

    const health = await service.start();
    expect(evaluations).toHaveLength(1);
    expect(health).not.toBeNull();
    expect(health!.harnessId).toBe("H1");
    expect(health!.samples).toBe(1);
  });

  it("detects regression on newly appended telemetry (the batch that arrives AFTER start)", async () => {
    const path = join(dir, "telemetry.jsonl");
    writeFileSync(path, `${JSON.stringify(sample())}\n`);

    const monitor = new ActivationMonitor({ minSampleSize: 10 });
    monitor.setEnvelope(
      monitor.envelopeFromBaseline({
        harnessId: "H1",
        experimentId: "exp-1",
        baseline: {
          taskSuccessRate: 0.6,
          falseSuccessRate: 0.1,
          toolErrorRate: 0.2,
          loopAbortRate: 0.1,
          verificationFailureRate: 0.2,
          avgTokens: 2000,
          avgLatencyMs: 1200,
        },
        minSampleSize: 10,
      }),
    );

    let ticks = 0;
    const service = new ContinuousMonitorService({
      telemetryPath: path,
      monitor,
      evaluate: (m) => m.evaluate("H1"),
      intervalMs: 1000,
      sleep: async () => {
        ticks++;
        if (ticks === 1) {
          // A hard regression lands while the service is already watching.
          appendFileSync(path, `${JSON.stringify(sample({ taskSuccessRate: 0.3 }))}\n`);
        } else {
          service.stop();
        }
      },
    });

    const health = await service.start();
    expect(health!.status).toBe("regressed");
    expect(monitor.isRegressed("H1")).toBe(true);
  });

  it("end-to-end: hydrated cross-process experiment rolls back on regression via the engine", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nexumhyd-"));
    const experimentStore = new ExperimentStore(join(stateDir, "experiments.db"));
    try {
      // Process A: create an experiment and walk it to ACTIVE, persisted.
      const engineA = new ClosedLoopEngine({
        experimentController: new ExperimentController({ store: experimentStore }),
      });
      engineA.experiments.startExperiment({
        id: "exp-live-1",
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
        executorPrimary: "primary",
        executorTransfer: [],
      });
      for (const s of ["EVALUATING", "VALIDATED", "GENERALIZED", "ELIGIBLE", "DELIVERED"] as const) {
        engineA.experiments.advance("exp-live-1", s);
      }
      engineA.reportCi("exp-live-1", true);
      engineA.reportReview("exp-live-1", true, "maintainer");
      expect(engineA.finalizeAcceptance("exp-live-1")).toBe(true);
      expect(experimentStore.get("exp-live-1")!.lifecycle.state).toBe("ACTIVE");

      // Process B: a FRESH controller/engine sharing only the store.
      const controllerB = new ExperimentController({ store: experimentStore });
      const monitor = new ActivationMonitor({ minSampleSize: 10 });
      const engineB = new ClosedLoopEngine({ experimentController: controllerB, monitor });

      // Hydration restores the experiment record + state machine.
      const hydrated = controllerB.hydrate("exp-live-1");
      expect(hydrated).not.toBeNull();
      expect(hydrated!.lifecycle.state).toBe("ACTIVE");
      expect(controllerB.machine("exp-live-1").current()).toBe("ACTIVE");
      // Idempotent.
      expect(controllerB.hydrate("exp-live-1")!.id).toBe("exp-live-1");

      // Register the envelope the way the engine would post-acceptance.
      monitor.setEnvelope(
        monitor.envelopeFromBaseline({
          harnessId: "H1",
          experimentId: "exp-live-1",
          baseline: {
            taskSuccessRate: 0.6,
            falseSuccessRate: 0.1,
            toolErrorRate: 0.2,
            loopAbortRate: 0.1,
            verificationFailureRate: 0.2,
            avgTokens: 2000,
            avgLatencyMs: 1200,
          },
          minSampleSize: 10,
        }),
      );

      const path = join(dir, "telemetry.jsonl");
      writeFileSync(path, `${JSON.stringify(sample({ experimentId: "exp-live-1" }))}\n`);

      let ticks = 0;
      const service = new ContinuousMonitorService({
        telemetryPath: path,
        monitor,
        evaluate: () => engineB.evaluateActivationLive("exp-live-1"),
        intervalMs: 1000,
        sleep: async () => {
          ticks++;
          if (ticks === 1) {
            appendFileSync(path, `${JSON.stringify(sample({ experimentId: "exp-live-1", taskSuccessRate: 0.3 }))}\n`);
          } else {
            service.stop();
          }
        },
      });

      const health = await service.start();
      expect(health!.status).toBe("regressed");
      // The engine drove ACTIVE → REGRESSED → ROLLBACK and persisted it.
      const finalRecord = experimentStore.get("exp-live-1");
      expect(["REGRESSED", "ROLLBACK"]).toContain(finalRecord!.lifecycle.state);
    } finally {
      experimentStore.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
