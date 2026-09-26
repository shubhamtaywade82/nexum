import { KeyManager } from "../../src/models/router/key-manager.js";
import { ModelAvailabilityChecker } from "../../src/models/router/availability.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** KeyManager only ever calls `isAvailable(key, model)` on the checker. */
function stubChecker(avail: (apiKey: string, model: string) => boolean | Promise<boolean>): ModelAvailabilityChecker {
  return {
    isAvailable: async (apiKey: string, model: string) => avail(apiKey, model),
  } as unknown as ModelAvailabilityChecker;
}

describe("KeyManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("binds an unbound key to the model on first acquire", async () => {
    const km = new KeyManager(
      ["k1", "k2"],
      stubChecker(() => true),
    );
    const key = await km.acquire("model-a");
    expect(["k1", "k2"]).toContain(key);
    expect(km.boundModels()).toEqual(["model-a"]);
  });

  it("returns the bound idle key again without re-probing", async () => {
    let probes = 0;
    const km = new KeyManager(
      ["k1"],
      stubChecker(() => (probes++, true)),
      { pollIntervalMs: 5 },
    );
    const first = await km.acquire("m");
    km.release(first);

    const second = await km.acquire("m");

    expect(second).toBe(first);
    expect(probes).toBe(1);
  });

  it("takes a spare key for the same model, and queues once the pool is exhausted", async () => {
    const km = new KeyManager(
      ["k1", "k2"],
      stubChecker(() => true),
      { pollIntervalMs: 5, acquireTimeoutMs: 2_000 },
    );
    const a1 = await km.acquire("m");
    const a2 = await km.acquire("m"); // spare key gets bound to the same model
    expect(a1).not.toBe(a2);

    const third = km.acquire("m"); // pool exhausted → queues
    let resolved: string | undefined;
    third.then((k) => {
      resolved = k;
    });
    await sleep(40);
    expect(resolved).toBeUndefined();

    km.release(a1);
    await expect(third).resolves.toBe(a1); // shares the released, already-bound key
  });

  it("concurrent acquires for different models never share a key (probe race regression)", async () => {
    // The availability probe is async; without the slot reservation inside
    // tryAcquire, both acquires used to pick the same slot, clobber each
    // other's binding, and share one key while the second sat idle.
    const km = new KeyManager(
      ["k1", "k2"],
      stubChecker(async () => {
        await sleep(20);
        return true;
      }),
      { pollIntervalMs: 5 },
    );

    const [ka, kb] = await Promise.all([km.acquire("model-a"), km.acquire("model-b")]);

    expect(ka).not.toBe(kb);
    expect(new Set(km.snapshot().map((s) => s.boundModel))).toEqual(new Set(["model-a", "model-b"]));
  });

  it("release keeps the key bound (warm) but idle", async () => {
    const km = new KeyManager(
      ["k1"],
      stubChecker(() => true),
    );
    const key = await km.acquire("m");
    km.release(key);

    expect(km.bestKeyForModel("m")).toBe(key);
    expect(km.snapshot()[0].busy).toBe(false);
  });

  it("falls through to the next unbound key when the probe says unavailable", async () => {
    const km = new KeyManager(
      ["k1", "k2"],
      stubChecker((key) => key === "k2"),
      { pollIntervalMs: 5 },
    );

    await expect(km.acquire("m")).resolves.toBe("k2");

    const k1 = km.snapshot().find((s) => s.apiKey.startsWith("k1"));
    expect(k1?.boundModel).toBe("");
  });

  it("times out and throws when no key can serve the model", async () => {
    const km = new KeyManager(
      ["k1"],
      stubChecker(() => false),
      { pollIntervalMs: 5, acquireTimeoutMs: 30 },
    );

    await expect(km.acquire("m")).rejects.toThrow(/timed out/);
  });

  it("unbind clears an idle slot's binding but refuses a busy one", async () => {
    const km = new KeyManager(
      ["k1"],
      stubChecker(() => true),
    );
    const key = await km.acquire("m");

    km.unbind(key); // still busy — refused
    expect(km.boundModels()).toEqual(["m"]);

    km.release(key);
    km.unbind(key);
    expect(km.boundModels()).toEqual([]);
  });
});
