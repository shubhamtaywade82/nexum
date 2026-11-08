import { ChampionCandidate, championRejection, selectChampion } from "../../src/evolution/parallel/champion.js";

const COMMIT = (n: number) => n.toString(16).repeat(40).slice(0, 40);

function attempt(slot: number, over: Partial<ChampionCandidate> = {}): ChampionCandidate {
  return {
    slot,
    experimentId: `exp-${slot}`,
    ok: true,
    eligible: true,
    candidateCommit: COMMIT(slot + 1),
    stageB: { capability: 0.05, reliability: 0.02, efficiency: 0 },
    heldOutGain: 0.01,
    detail: `c${slot}`,
    ...over,
  };
}

describe("selectChampion", () => {
  it("picks the eligible attempt with the best development deltas", () => {
    const selection = selectChampion([
      attempt(0, { stageB: { capability: 0.02, reliability: 0.01, efficiency: 0 } }),
      attempt(1, { stageB: { capability: 0.09, reliability: 0.0, efficiency: 0 } }),
      attempt(2, { stageB: { capability: 0.05, reliability: 0.05, efficiency: 0 } }),
    ]);
    expect(selection.kind).toBe("champion");
    if (selection.kind !== "champion") return;
    expect(selection.slot).toBe(1);
    expect(selection.experimentId).toBe("exp-1");
    expect(selection.reason).toContain("c1 selected");
  });

  it("breaks ties on reliability, then efficiency, then the lowest slot", () => {
    const sameCapability = (slot: number, reliability: number, efficiency: number) =>
      attempt(slot, { stageB: { capability: 0.05, reliability, efficiency } });

    const byReliability = selectChampion([sameCapability(0, 0.01, 0), sameCapability(1, 0.03, 0)]);
    expect(byReliability.kind === "champion" && byReliability.slot).toBe(1);

    const byEfficiency = selectChampion([sameCapability(0, 0.02, 0.01), sameCapability(1, 0.02, 0.04)]);
    expect(byEfficiency.kind === "champion" && byEfficiency.slot).toBe(1);

    const byLowestSlot = selectChampion([sameCapability(2, 0.02, 0.01), sameCapability(1, 0.02, 0.01)]);
    expect(byLowestSlot.kind === "champion" && byLowestSlot.slot).toBe(1);
  });

  it("never picks an attempt that is not eligible, however strong its deltas", () => {
    const selection = selectChampion([
      attempt(0, { eligible: false, stageB: { capability: 0.9, reliability: 0.9, efficiency: 0.9 } }),
      attempt(1, { stageB: { capability: 0.01, reliability: 0, efficiency: 0 } }),
    ]);
    expect(selection.kind === "champion" && selection.slot).toBe(1);
  });

  it("uses held-out results as a veto only: a held-out regression excludes the attempt, it does not rank", () => {
    const selection = selectChampion([
      attempt(0, { stageB: { capability: 0.2, reliability: 0, efficiency: 0 }, heldOutGain: -0.01 }),
      attempt(1, { stageB: { capability: 0.05, reliability: 0, efficiency: 0 }, heldOutGain: 0.5 }),
    ]);
    expect(selection.kind === "champion" && selection.slot).toBe(1);
    expect(selection.kind === "champion" && selection.reason).toContain("excluded");
  });

  it("does not rank by held-out gain: a bigger held-out gain alone does not change the champion", () => {
    const low = attempt(0, { stageB: { capability: 0.05, reliability: 0, efficiency: 0 }, heldOutGain: 0.0 });
    const high = attempt(1, { stageB: { capability: 0.05, reliability: 0, efficiency: 0 }, heldOutGain: 0.9 });
    const selection = selectChampion([low, high]);
    expect(selection.kind === "champion" && selection.slot).toBe(0);
  });

  it("selects nothing when no attempt is admissible, and says why", () => {
    const selection = selectChampion([
      attempt(0, { ok: false, eligible: false, stageB: null }),
      attempt(1, { eligible: false }),
      attempt(2, { candidateCommit: "not-a-sha" }),
      attempt(3, { stageB: null }),
    ]);
    expect(selection.kind).toBe("none");
    if (selection.kind !== "none") return;
    expect(selection.reason).toContain("c0: attempt did not produce an outcome");
    expect(selection.reason).toContain("c1: not eligible");
    expect(selection.reason).toContain("c2: no full candidate commit");
    expect(selection.reason).toContain("c3: stage B did not run");
  });

  it("is deterministic and does not mutate its input", () => {
    const input = [attempt(2), attempt(0), attempt(1)];
    const snapshot = JSON.stringify(input);
    const first = selectChampion(input);
    const second = selectChampion(input);
    expect(first).toEqual(second);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("returns an empty selection for no attempts", () => {
    const selection = selectChampion([]);
    expect(selection).toEqual({ kind: "none", ranking: [], reason: "no attempts ran" });
  });
});

describe("championRejection", () => {
  it("returns null only for a fully admissible attempt", () => {
    expect(championRejection(attempt(0))).toBeNull();
    expect(championRejection(attempt(0, { heldOutGain: null }))).toBeNull();
  });

  it("names the reason for each rejection", () => {
    expect(championRejection(attempt(0, { ok: false }))).toMatch(/did not produce an outcome/);
    expect(championRejection(attempt(0, { eligible: false }))).toMatch(/not eligible/);
    expect(championRejection(attempt(0, { candidateCommit: null }))).toMatch(/no full candidate commit/);
    expect(championRejection(attempt(0, { stageB: null }))).toMatch(/stage B/);
    expect(championRejection(attempt(0, { heldOutGain: -0.02 }))).toMatch(/held-out regression/);
  });
});
