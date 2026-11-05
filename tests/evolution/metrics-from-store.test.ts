import { describe, it, expect } from "@jest/globals";
import { formatHealthReport, metricsFromExperimentStore } from "../../src/evolution/cli.js";
import type { ExperimentStore } from "../../src/evolution/experiments/experiment-store.js";
import type { ExperimentRecord } from "../../src/evolution/experiments/experiment-schema.js";

function record(over: {
  id: string;
  result: ExperimentRecord["decision"]["result"];
  stageB: ExperimentRecord["decision"]["stageB"];
  state: ExperimentRecord["lifecycle"]["state"];
  capability?: number;
  generalization?: number;
}): ExperimentRecord {
  return {
    id: over.id,
    parent: { harness: "H0", commit: "a" },
    candidate: { harness: `H-${over.id}`, commit: "b" },
    target: { capability: "tool_utilization", targetId: "t", desiredOutcome: "d" },
    hypothesis: { id: "h", statement: "s", predictedEffect: "p" },
    executor: { primary: "qwen", transfer: ["gemini"] },
    evaluation: { visible: {}, held_out: {}, transfer: { transferScore: 0.7 } },
    metrics: {
      capability: over.capability ?? 0,
      reliability: 0,
      efficiency: 0,
      generalization: over.generalization ?? 0,
    },
    decision: { result: over.result, stageA: "valid", stageB: over.stageB, rationale: "" },
    ci: { status: "passed" },
    review: { state: "approved" },
    lifecycle: { state: over.state, enteredAt: 0 },
    createdAt: 0,
  };
}

function storeOf(records: ExperimentRecord[]): ExperimentStore {
  return { listAll: () => records } as unknown as ExperimentStore;
}

describe("metricsFromExperimentStore", () => {
  const records = [
    record({ id: "1", result: "eligible", stageB: "improved", state: "ACTIVE", capability: 0.1, generalization: 0.05 }),
    record({ id: "2", result: "rejected", stageB: "not_run", state: "CANDIDATE" }),
  ];

  it("never reports transfer gain, executor sensitivity or held-out verdicts the store does not hold", () => {
    const tracker = metricsFromExperimentStore(storeOf(records));
    for (const r of tracker.records()) {
      expect(r.transferGain).toBeNull();
      expect(r.executorSensitivity).toBeNull();
      expect(r.genuinelyBetterOnHeldOut).toBe("unknown");
    }
    const report = tracker.report();
    expect(report.meanTransferGain).toBeNull();
    expect(report.meanExecutorSensitivity).toBeNull();
    // Stage B "improved" is a promotion precondition — using it would make precision 100% by construction.
    expect(report.promotionPrecision).toBeNull();
  });

  it("reports gains only for experiments whose Stage B ran", () => {
    const report = metricsFromExperimentStore(storeOf(records)).report();
    expect(report.meanVisibleGain).toBeCloseTo(0.1);
    expect(report.meanHeldOutGain).toBeCloseTo(0.05);
  });

  it("renders unmeasured metrics as not measured instead of 0%", () => {
    const text = formatHealthReport(metricsFromExperimentStore(storeOf(records)).report());
    expect(text).toMatch(/Mean transfer gain:\s+n\/a \(not measured\)/);
    expect(text).toMatch(/Executor sensitivity:\s+n\/a \(not measured\)/);
    expect(text).not.toMatch(/transfer gain:\s+0\.0%/i);
  });
});
