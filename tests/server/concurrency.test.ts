import { ServerHarness } from "../support/server-harness.js";
import type { NexumRun } from "../../src/protocol/types.js";

describe("Concurrency & Idempotency (Wave 12)", () => {
  const harness = new ServerHarness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    harness.resetRunHandler();
    await harness.pg.cleanTables();
  });

  it("returns cached session for repeated POST /sessions with the same Idempotency-Key", async () => {
    const key = "idemp_sess_key_111";
    const res1 = await harness.postJson<{ id: string }>("/sessions", {}, { "Idempotency-Key": key });
    expect(res1.status).toBe(201);
    expect(res1.body.id).toBeDefined();

    const res2 = await harness.postJson<{ id: string }>("/sessions", {}, { "Idempotency-Key": key });
    expect(res2.status).toBe(201);
    expect(res2.body.id).toBe(res1.body.id);

    // Without idempotency key, mints a new unique session
    const res3 = await harness.postJson<{ id: string }>("/sessions", {});
    expect(res3.status).toBe(201);
    expect(res3.body.id).not.toBe(res1.body.id);
  });

  it("returns cached run for repeated POST /sessions/:id/runs with the same Idempotency-Key", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const key = "idemp_run_key_222";

    const res1 = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "Sync records" },
      { "Idempotency-Key": key },
    );
    expect(res1.status).toBe(201);
    expect(res1.body.run.id).toBeDefined();

    // Immediate retry with the same key returns the existing run rather than 409
    const res2 = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "Sync records" },
      { "Idempotency-Key": key },
    );
    expect(res2.status).toBe(201);
    expect(res2.body.run.id).toBe(res1.body.run.id);

    await harness.waitForRun(res1.body.run.id);
  });

  it("enforces same-session run serialization with 409 Conflict when a run is in progress", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

    let releaseFirstRun: (() => void) | null = null;
    harness.setRunHandler(async (goal: string) => {
      if (goal === "First long run") {
        await new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });
      }
      return `Done: ${goal}`;
    });

    const res1 = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "First long run",
    });
    expect(res1.status).toBe(201);

    // Attempt second run on the same session while first run is in progress
    const res2 = await harness.postJson<{ error: string; runId?: string }>(`/sessions/${sess.id}/runs`, {
      goal: "Second concurrent run",
    });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toBe("run_in_progress");
    expect(res2.body.runId).toBe(res1.body.run.id);

    // Release first run and wait for it to complete
    if (releaseFirstRun) {
      (releaseFirstRun as () => void)();
    }
    await harness.waitForRun(res1.body.run.id);

    // After first run completes, new run on the session succeeds
    const res3 = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "Third run after completion",
    });
    expect(res3.status).toBe(201);
    await harness.waitForRun(res3.body.run.id);
  });

  it("allows concurrent runs across different sessions without conflict", async () => {
    const { body: sessA } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: sessB } = await harness.postJson<{ id: string }>("/sessions", {});

    const waiters: Array<() => void> = [];
    harness.setRunHandler(async (goal: string) => {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
      return `Done: ${goal}`;
    });

    // Start run on session A
    const resA = await harness.postJson<{ run: NexumRun }>(`/sessions/${sessA.id}/runs`, {
      goal: "Session A job",
    });
    expect(resA.status).toBe(201);

    // Concurrently start run on session B — should succeed
    const resB = await harness.postJson<{ run: NexumRun }>(`/sessions/${sessB.id}/runs`, {
      goal: "Session B job",
    });
    expect(resB.status).toBe(201);

    // Wait until both background runs have entered the handler and suspended
    const startWait = Date.now();
    while (waiters.length < 2 && Date.now() - startWait < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Release all waiting runs
    while (waiters.length > 0) {
      waiters.pop()?.();
    }

    await harness.waitForRun(resA.body.run.id);
    await harness.waitForRun(resB.body.run.id);
  });
});
