import { ServerHarness } from "../support/server-harness.js";
import { subscribeToEvents } from "../support/sse-client.js";
import type { NexumRun } from "../../src/protocol/types.js";

describe("Durable Runs & SSE Replay (Waves 4, 5, 6, 7, 8)", () => {
  const harness = new ServerHarness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    await harness.pg.cleanTables();
  });

  it("POST /sessions/:id/runs returns 201 Created immediately and completes in background", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

    const { status, body } = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "Inspect project status" },
    );

    expect(status).toBe(201);
    expect(body.run).toBeDefined();
    expect(body.run.sessionId).toBe(sess.id);

    // Await run execution to complete
    const finished = await harness.waitForRun(body.run.id);
    expect(finished.status).toBe("completed");
    expect(finished.output).toContain("Finished task: Inspect project status");
  });

  it("GET /runs/:id retrieves run metadata", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: created } = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "Task metadata check" },
    );

    const { status, body: fetched } = await harness.getJson<NexumRun>(`/runs/${created.run.id}`);
    expect(status).toBe(200);
    expect(fetched.id).toBe(created.run.id);
    expect(fetched.sessionId).toBe(sess.id);

    await harness.waitForRun(created.run.id);
  });

  it("GET /runs/:id/events streams SSE events with monotonic seq id", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: created } = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "Stream test" },
    );

    const sub = subscribeToEvents(harness.baseUrl, created.run.id);
    const terminal = await sub.waitForTerminal();

    expect(terminal.event).toBe("run.completed");
    expect(sub.events.length).toBeGreaterThanOrEqual(3);

    // Verify event ordering and monotonic seq IDs
    let lastSeq = 0;
    for (const ev of sub.events) {
      expect(ev.id).toBeGreaterThan(lastSeq);
      lastSeq = ev.id;
    }
    sub.close();
  });

  it("replays past events via Last-Event-ID with zero loss", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: created } = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "Replay test" },
    );

    await harness.waitForRun(created.run.id);

    // Replay all events after sequence 1
    const sub = subscribeToEvents(harness.baseUrl, created.run.id, { lastEventId: 1 });
    await sub.waitForTerminal();

    expect(sub.events.length).toBeGreaterThan(0);
    expect(sub.events.every((e) => e.id > 1)).toBe(true);
    sub.close();
  });

  it("allows multiple independent clients to subscribe to the same run", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: created } = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "Multi-client test" },
    );

    // Client A and Client B attach simultaneously
    const subA = subscribeToEvents(harness.baseUrl, created.run.id);
    const subB = subscribeToEvents(harness.baseUrl, created.run.id);

    const [termA, termB] = await Promise.all([subA.waitForTerminal(), subB.waitForTerminal()]);

    expect(termA.event).toBe("run.completed");
    expect(termB.event).toBe("run.completed");
    expect(subA.events.map((e) => e.event)).toEqual(subB.events.map((e) => e.event));

    subA.close();
    subB.close();
  });
});
