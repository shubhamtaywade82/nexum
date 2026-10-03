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

    const { status, body } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "Inspect project status",
    });

    expect(status).toBe(201);
    expect(body.run).toBeDefined();
    expect(body.run.sessionId).toBe(sess.id);

    // Await run execution to complete
    const finished = await harness.waitForRun(body.run.id);
    expect(finished.status).toBe("completed");
    expect(finished.output?.format).toBe("markdown");
    expect(finished.output?.content).toContain("Finished task: Inspect project status");
  });

  it("GET /runs/:id retrieves run metadata", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: created } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "Task metadata check",
    });

    const { status, body: fetched } = await harness.getJson<NexumRun>(`/runs/${created.run.id}`);
    expect(status).toBe(200);
    expect(fetched.id).toBe(created.run.id);
    expect(fetched.sessionId).toBe(sess.id);

    await harness.waitForRun(created.run.id);
  });

  it("POST /sessions/:id/runs rejects a presentation the server cannot produce", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

    const { status, body } = await harness.postJson<{ error: string }>(`/sessions/${sess.id}/runs`, {
      goal: "Export as unsupported OpenUI",
      presentation: {
        mode: "openui",
        openui: {
          schemaVersion: "99.0.0",
          spec: "Stack",
          schema: {},
        },
      },
    });

    expect(status).toBe(400);
    expect(body.error).toBe("unsupported_presentation");
  });

  describe("openui output", () => {
    const spec = "Stack(gap, children) — vertical layout";
    const schema = {
      $defs: {
        Stack: {
          type: "object",
          properties: {
            gap: { type: "string" },
            children: { type: "array" },
          },
        },
      },
    };

    afterEach(() => harness.resetRunHandler());

    async function runGoal(sessionId: string, payload: Record<string, unknown>): Promise<NexumRun> {
      const { body } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sessionId}/runs`, payload);
      return harness.waitForRun(body.run.id);
    }

    it("injects the client spec for the run and labels OpenUI answers as openui", async () => {
      const seenInstructions: string[] = [];
      harness.setRunHandler(async (_goal, agent) => {
        seenInstructions.push(agent.conversation.presentationInstructions);
        return '  root = Stack("md", [])\n';
      });
      const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

      const finished = await runGoal(sess.id, {
        goal: "BTC price card",
        presentation: {
          mode: "openui",
          openui: { schemaVersion: "0.3.0", spec, schema },
        },
      });

      expect(seenInstructions[0]).toContain(spec);
      expect(finished.output).toEqual({
        format: "openui",
        content: 'root = Stack("md", [])',
        schemaVersion: "0.3.0",
      });
    });

    it("labels a Markdown answer as markdown even when openui was requested", async () => {
      harness.setRunHandler(async () => "BTC is trading near its weekly high.");
      const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

      const finished = await runGoal(sess.id, {
        goal: "Explain BTC",
        presentation: {
          mode: "openui",
          openui: { schemaVersion: "0.3.0", spec, schema },
        },
      });

      expect(finished.output).toEqual({ format: "markdown", content: "BTC is trading near its weekly high." });
    });

    it("labels an invalid OpenUI answer as markdown when validation fails", async () => {
      harness.setRunHandler(async () => "root = UnknownComponent()");
      const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

      const finished = await runGoal(sess.id, {
        goal: "Explain BTC",
        presentation: {
          mode: "openui",
          openui: { schemaVersion: "0.3.0", spec, schema },
        },
      });

      expect(finished.output).toEqual({ format: "markdown", content: "root = UnknownComponent()" });
    });

    it("does not carry the spec into a later markdown run on the same session", async () => {
      const seenInstructions: string[] = [];
      harness.setRunHandler(async (_goal, agent) => {
        seenInstructions.push(agent.conversation.presentationInstructions);
        return "done";
      });
      const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

      await runGoal(sess.id, {
        goal: "first",
        presentation: {
          mode: "openui",
          openui: { schemaVersion: "0.3.0", spec, schema },
        },
      });
      await runGoal(sess.id, { goal: "second" });

      expect(seenInstructions).toEqual([expect.stringContaining(spec), ""]);
    });
  });

  it("GET /runs/:id/events streams SSE events with monotonic seq id", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: created } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "Stream test",
    });

    const sub = subscribeToEvents(harness.baseUrl, created.run.id);
    const terminal = await sub.waitForTerminal();

    expect(terminal.event).toBe("run.completed");
    expect(terminal.data.output).toEqual({ format: "markdown", content: expect.any(String) });
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
    const { body: created } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "Replay test",
    });

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
    const { body: created } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "Multi-client test",
    });

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
