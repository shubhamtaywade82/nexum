import { HELD_OUT_SPLIT_VERSION, heldOutSplitDigest, isHeldOutCase } from "../../src/evolution/heldout-split.js";
import { heldOutReport } from "../../src/evolution/engine-v2.js";
import { TaskExecutionResult } from "../../src/evolution/evaluator.js";

function task(taskId: string, success: boolean, isHeldOut: boolean): TaskExecutionResult {
  return {
    taskId,
    success,
    verificationPassed: success,
    toolCalls: 1,
    toolErrors: 0,
    tokens: 100,
    latencyMs: 10,
    loopAborted: false,
    isHeldOut,
  };
}

describe("held-out split", () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `case-${i}`);

  it("assigns every case the same way on every call: the split is frozen, not random per run", () => {
    for (const id of ids.slice(0, 50)) {
      expect(isHeldOutCase(id)).toBe(isHeldOutCase(id));
    }
  });

  it("holds out roughly one case in five, so the held-out set is large enough to read", () => {
    const held = ids.filter(isHeldOutCase).length;
    expect(held).toBeGreaterThan(150);
    expect(held).toBeLessThan(250);
  });

  it("digests the assignment independently of input order and duplicates", () => {
    const sample = ids.slice(0, 40);
    const shuffled = [...sample].reverse();
    expect(heldOutSplitDigest(sample)).toBe(heldOutSplitDigest([...shuffled, ...sample]));
  });

  it("digests differently for a different case set, so a report names the suite it measured", () => {
    expect(heldOutSplitDigest(ids.slice(0, 40))).not.toBe(heldOutSplitDigest(ids.slice(1, 41)));
  });

  it("is versioned, so reassigning cases is a visible change", () => {
    expect(HELD_OUT_SPLIT_VERSION).toMatch(/^heldout-split-v\d+$/);
  });
});

describe("heldOutReport", () => {
  it("reports the candidate minus baseline success rate over held-out tasks only", () => {
    const report = heldOutReport(
      [task("d1", true, false), task("h1", true, true), task("h2", false, true)],
      [task("d1", false, false), task("h1", false, true), task("h2", false, true)],
    );
    expect(report.candidateRuns).toBe(2);
    expect(report.candidateSuccessRate).toBe(0.5);
    expect(report.baselineSuccessRate).toBe(0);
    expect(report.gain).toBe(0.5);
  });

  it("reports the gain as unmeasured when either side ran no held-out task", () => {
    const report = heldOutReport([task("d1", true, false)], [task("d1", false, false)]);
    expect(report.candidateRuns).toBe(0);
    expect(report.candidateSuccessRate).toBeNull();
    expect(report.gain).toBeNull();
  });
});
