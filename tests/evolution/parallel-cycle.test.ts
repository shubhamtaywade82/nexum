import { ChampionCandidate } from "../../src/evolution/parallel/champion.js";
import { runParallelCycle, SlotRun } from "../../src/evolution/parallel/orchestrator.js";
import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import type { ActivationEvidence } from "../../src/evolution/delivery/activation-gate.js";

/**
 * Concurrency contract of one parallel cycle. Attempts run at different speeds, and the tests
 * check that selection and delivery wait for every attempt, that delivery runs at most once, and
 * that losing workspaces are released while the champion's is held until delivery finishes.
 */

const COMMIT = (n: number) => n.toString(16).repeat(40).slice(0, 40);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function candidate(slot: number, over: Partial<ChampionCandidate> = {}): ChampionCandidate {
  return {
    slot,
    experimentId: `exp-${slot}`,
    ok: true,
    eligible: true,
    candidateCommit: COMMIT(slot + 1),
    stageB: { capability: 0.05, reliability: 0, efficiency: 0 },
    heldOutGain: 0,
    detail: `c${slot}`,
    ...over,
  };
}

interface Recorder {
  running: number;
  settledBeforeDelivery: number[];
  deliveries: number[];
  released: number[];
  maxConcurrentDeliveries: number;
  deliveringNow: number;
}

function harness(
  attempts: Array<{ delayMs: number; candidate: ChampionCandidate } | "throw">,
  options: { deliveryOk?: boolean; deliveryThrows?: boolean } = {},
) {
  const rec: Recorder = {
    running: 0,
    settledBeforeDelivery: [],
    deliveries: [],
    released: [],
    maxConcurrentDeliveries: 0,
    deliveringNow: 0,
  };
  const hooks = {
    runSlot: async (slot: number): Promise<SlotRun<{ slot: number }>> => {
      rec.running++;
      try {
        const attempt = attempts[slot];
        await sleep(attempt === "throw" ? 1 : attempt.delayMs);
        if (attempt === "throw") throw new Error(`slot ${slot} exploded`);
        return { candidate: attempt.candidate, payload: { slot }, holdsWorkspace: true };
      } finally {
        rec.running--;
      }
    },
    release: async (run: SlotRun<{ slot: number }>) => {
      rec.released.push(run.candidate.slot);
    },
    deliverChampion: async (champion: SlotRun<{ slot: number }>) => {
      rec.settledBeforeDelivery.push(rec.running);
      rec.deliveries.push(champion.candidate.slot);
      rec.deliveringNow++;
      rec.maxConcurrentDeliveries = Math.max(rec.maxConcurrentDeliveries, rec.deliveringNow);
      try {
        await sleep(5);
        if (options.deliveryThrows) throw new Error("push rejected");
        return { ok: options.deliveryOk ?? true, detail: "delivered" };
      } finally {
        rec.deliveringNow--;
      }
    },
  };
  return { hooks, rec };
}

describe("runParallelCycle", () => {
  it("delivers exactly one champion when several attempts succeed at once", async () => {
    const { hooks, rec } = harness([
      { delayMs: 30, candidate: candidate(0) },
      { delayMs: 5, candidate: candidate(1, { stageB: { capability: 0.09, reliability: 0, efficiency: 0 } }) },
      { delayMs: 15, candidate: candidate(2) },
    ]);

    const result = await runParallelCycle(3, hooks);

    expect(result.ok).toBe(true);
    expect(rec.deliveries).toEqual([1]);
    expect(rec.maxConcurrentDeliveries).toBe(1);
    expect(result.selection.kind === "champion" && result.selection.slot).toBe(1);
  });

  it("starts delivery only after every attempt has settled", async () => {
    const { hooks, rec } = harness([
      { delayMs: 40, candidate: candidate(0) },
      { delayMs: 2, candidate: candidate(1) },
      { delayMs: 20, candidate: candidate(2) },
    ]);

    await runParallelCycle(3, hooks);

    expect(rec.settledBeforeDelivery).toEqual([0]);
  });

  it("releases every losing workspace, and releases the champion's only after delivery", async () => {
    const order: string[] = [];
    const { hooks } = harness([
      { delayMs: 1, candidate: candidate(0) },
      { delayMs: 1, candidate: candidate(1, { stageB: { capability: 0.5, reliability: 0, efficiency: 0 } }) },
      { delayMs: 1, candidate: candidate(2) },
    ]);
    const wrapped = {
      ...hooks,
      release: async (run: SlotRun<{ slot: number }>) => {
        order.push(`release c${run.candidate.slot}`);
      },
      deliverChampion: async (champion: SlotRun<{ slot: number }>) => {
        order.push(`deliver c${champion.candidate.slot}`);
        return { ok: true, detail: "delivered" };
      },
    };

    await runParallelCycle(3, wrapped);

    expect(order).toEqual(["release c0", "release c2", "deliver c1", "release c1"]);
  });

  it("never delivers when no attempt is eligible, and releases every workspace", async () => {
    const { hooks, rec } = harness([
      { delayMs: 1, candidate: candidate(0, { eligible: false }) },
      { delayMs: 1, candidate: candidate(1, { ok: false, eligible: false, stageB: null }) },
      { delayMs: 1, candidate: candidate(2, { heldOutGain: -0.1 }) },
    ]);

    const result = await runParallelCycle(3, hooks);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^no champion:/);
    expect(rec.deliveries).toEqual([]);
    expect(rec.released.sort()).toEqual([0, 1, 2]);
  });

  it("keeps a crashed attempt visible and still selects among the rest", async () => {
    const { hooks, rec } = harness([
      "throw",
      { delayMs: 2, candidate: candidate(1) },
      { delayMs: 3, candidate: candidate(2, { stageB: { capability: 0.2, reliability: 0, efficiency: 0 } }) },
    ]);

    const result = await runParallelCycle(3, hooks);

    expect(rec.deliveries).toEqual([2]);
    const crashed = result.runs.find((run) => run.candidate.slot === 0);
    expect(crashed?.candidate.detail).toContain("attempt crashed: slot 0 exploded");
  });

  it("reports a failed delivery and still releases the champion's workspace", async () => {
    const { hooks, rec } = harness([{ delayMs: 1, candidate: candidate(0) }], { deliveryOk: false });

    const result = await runParallelCycle(1, hooks);

    expect(result.ok).toBe(false);
    expect(result.delivery).toEqual({ ok: false, detail: "delivered" });
    expect(rec.released).toEqual([0]);
  });

  it("survives a delivery that throws: the error is reported and the workspace is still released", async () => {
    const { hooks, rec } = harness([{ delayMs: 1, candidate: candidate(0) }], { deliveryThrows: true });

    const result = await runParallelCycle(1, hooks);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("delivery failed: push rejected");
    expect(rec.released).toEqual([0]);
  });

  it("refuses a cycle with no slots", async () => {
    const { hooks } = harness([]);
    await expect(runParallelCycle(0, hooks)).rejects.toThrow(/at least one slot/);
  });
});

describe("candidate engines cannot deliver or activate", () => {
  // The parallel CLI builds candidate slots with neither a GitHub adapter nor a runtime controller.
  // These checks pin that the engine itself refuses both, so the guard is structural, not a convention.
  const candidateEngine = () => new ClosedLoopEngine({ executorModels: ["qwen"] });

  it("refuses to activate a runtime when no controller is wired", async () => {
    const result = await candidateEngine().activateOnRuntime("exp-any", {} as ActivationEvidence);
    expect(result).toEqual({ ok: false, reason: "no runtime controller is wired" });
  });

  it("refuses to deliver a champion when no GitHub adapter is wired", async () => {
    await expect(
      candidateEngine().deliverChampion({
        experimentId: "exp-any",
        artifact: {} as never,
        outcome: { delivery: {} } as never,
      }),
    ).rejects.toThrow(/requires ClosedLoopEngineOptions.githubDelivery/);
  });
});
