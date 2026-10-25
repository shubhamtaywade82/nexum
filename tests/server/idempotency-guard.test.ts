import { ServerHarness } from "../support/server-harness.js";
import type { NexumRun } from "../../src/protocol/types.js";

// The replay rules over HTTP: a key is bound to its request body and its route, and a refused
// attempt does not consume the key.
describe("Idempotency-Key is bound to its body and route", () => {
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

  it("refuses a key reused with a different body, and creates no second session", async () => {
    const key = "idem-body-conflict-1";
    const first = await harness.postJson<{ id: string }>("/sessions", { title: "one" }, { "Idempotency-Key": key });
    expect(first.status).toBe(201);

    const reused = await harness.postJson<{ error: string }>("/sessions", { title: "two" }, { "Idempotency-Key": key });
    expect(reused.status).toBe(422);
    expect(reused.body).toMatchObject({ error: "idempotency_key_reused" });

    const list = await harness.getJson<{ sessions: unknown[] }>("/sessions");
    expect(list.body.sessions).toHaveLength(1);
  });

  it("does not replay a run from another session under the same key", async () => {
    const a = (await harness.postJson<{ id: string }>("/sessions", {})).body;
    const b = (await harness.postJson<{ id: string }>("/sessions", {})).body;
    const key = "idem-route-scope-1";

    const runA = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${a.id}/runs`,
      { goal: "same goal" },
      { "Idempotency-Key": key },
    );
    expect(runA.status).toBe(201);

    const runB = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${b.id}/runs`,
      { goal: "same goal" },
      { "Idempotency-Key": key },
    );
    expect(runB.status).toBe(201);
    expect(runB.body.run.id).not.toBe(runA.body.run.id);
    expect(runB.body.run.sessionId).toBe(b.id);

    await harness.waitForRun(runA.body.run.id);
    await harness.waitForRun(runB.body.run.id);
  });

  it("releases a key whose attempt was refused, so the same key can run once the session is free", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.setRunHandler(async (goal) => {
      if (goal === "blocking") await gate;
      return `done: ${goal}`;
    });

    const blocking = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, { goal: "blocking" });
    expect(blocking.status).toBe(201);

    const refused = await harness.postJson<{ error: string }>(
      `/sessions/${sess.id}/runs`,
      { goal: "retry me" },
      { "Idempotency-Key": "idem-release-1" },
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "run_in_progress" });

    release();
    await harness.waitForRun(blocking.body.run.id);

    const retried = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "retry me" },
      { "Idempotency-Key": "idem-release-1" },
    );
    expect(retried.status).toBe(201);
    await harness.waitForRun(retried.body.run.id);
  });
});
