import { ServerHarness } from "../support/server-harness.js";
import { runs } from "../../src/persistence/schema/run.js";
import { eq } from "drizzle-orm";
import type { NexumRun } from "../../src/protocol/types.js";

describe("Recovery, Reconciliation & Graceful Shutdown (Wave 10)", () => {
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

  it("reconciles orphaned running runs on startup into interrupted state", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const orphanedRunId = "run-orphaned-123";

    // Simulate an interrupted run left in the database from a crash
    await harness.db.insert(runs).values({
      id: orphanedRunId,
      sessionId: sess.id,
      goal: "Analyze large dataset",
      status: "running",
    });

    // Restart the server to trigger startup reconciliation
    await harness.restartServer();

    // Verify run status was updated to interrupted
    const { status, body } = await harness.getJson<{ id: string; status: string; error?: string }>(
      `/runs/${orphanedRunId}`,
    );
    expect(status).toBe(200);
    expect(body.status).toBe("interrupted");
    expect(body.error).toContain("Server restarted");

    // Verify a run.interrupted event was recorded
    const { body: eventBody } = await harness.getJson<{
      events: Array<{ type: string; reason?: string }>;
    }>(`/runs/${orphanedRunId}/events`);
    expect(eventBody.events.some((e) => e.type === "run.interrupted" && e.reason === "server_restart")).toBe(true);
  });

  it("gracefully drains active runs on stop within grace period", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

    harness.setRunHandler(async (goal: string) => {
      await new Promise((r) => setTimeout(r, 60));
      return `Finished: ${goal}`;
    });

    const { body: created } = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "Perform migration" },
    );

    // Stop server with 2000ms grace period (active run finishes in ~60ms)
    await harness.stopServer(2000);

    // Verify run finished successfully before database was closed
    const runRow = await harness.db.select().from(runs).where(eq(runs.id, created.run.id));
    expect(runRow[0]?.status).toBe("completed");

    // Restart server for subsequent tests
    await harness.startServer();
  });

  it("aborts active runs when shutdown grace period expires", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

    harness.setRunHandler(async (_goal: string, agent) => {
      await new Promise<void>((_, reject) => {
        agent.execution.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
      return "done";
    });

    const { body: created } = await harness.postJson<{ run: NexumRun }>(
      `/sessions/${sess.id}/runs`,
      { goal: "Long hanging job" },
    );

    // Stop server with short grace period
    const start = Date.now();
    await harness.stopServer(50);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(1500);

    const runRow = await harness.db.select().from(runs).where(eq(runs.id, created.run.id));
    expect(runRow[0]?.status).toBe("cancelled");

    await harness.startServer();
  });
});
