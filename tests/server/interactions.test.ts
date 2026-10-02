import { ServerHarness } from "../support/server-harness.js";
import { subscribeToEvents } from "../support/sse-client.js";
import type { NexumRun } from "../../src/protocol/types.js";

describe("Unified Remote Interaction Protocol (Wave 9)", () => {
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

  it("handles remote approval resolution over HTTP API", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});

    // Configure the fake agent to request approval during execution
    let resolveApprovalHook: ((approved: boolean) => void) | null = null;
    harness.setRunHandler(async (goal: string, agent) => {
      agent.emit("onThinking", "Checking permissions...");
      const approved = await new Promise<boolean>((resolve) => {
        resolveApprovalHook = resolve;
      });
      if (!approved) {
        throw new Error("Action rejected by user");
      }
      return `Executed with approval: ${goal}`;
    });

    const { body: created } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "Deploy production build",
    });
    const runId = created.run.id;

    const sub = subscribeToEvents(harness.baseUrl, runId);

    // Register approval interaction on server
    const interactionId = "appr_12345";
    const { status: resolveStatus, body: resolveBody } = await harness.postJson<{
      resolved: boolean;
      interactionId: string;
    }>(`/runs/${runId}/interactions/${interactionId}/resolve`, {
      approved: true,
      reason: "User approved deploy",
    });

    expect(resolveStatus).toBe(200);
    expect(resolveBody.resolved).toBe(true);

    // Resume agent execution
    if (resolveApprovalHook) {
      resolveApprovalHook(true);
    }

    const terminal = await sub.waitForTerminal();
    expect(terminal.event).toBe("run.completed");
    sub.close();
  });

  it("handles clarification resolution over HTTP API", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: created } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "Choose deployment strategy",
    });
    const runId = created.run.id;

    const sub = subscribeToEvents(harness.baseUrl, runId);
    const interactionId = "clar_789";

    const { status, body } = await harness.postJson<{ resolved: boolean; interactionId: string }>(
      `/runs/${runId}/interactions/${interactionId}/resolve`,
      { selectedId: "blue-green" },
    );

    expect(status).toBe(200);
    expect(body.resolved).toBe(true);
    expect(body.interactionId).toBe(interactionId);

    const event = await sub.waitForEvent("run.clarification.resolved");
    expect((event.data as Record<string, unknown>).selectedId).toBe("blue-green");

    const terminal = await sub.waitForTerminal();
    expect(terminal.event).toBe("run.completed");
    sub.close();
  });

  it("handles MCP elicitation resolution over HTTP API", async () => {
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: created } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, {
      goal: "Query external database",
    });
    const runId = created.run.id;

    const sub = subscribeToEvents(harness.baseUrl, runId);
    const interactionId = "elicit_456";

    const { status, body } = await harness.postJson<{ resolved: boolean; interactionId: string }>(
      `/runs/${runId}/interactions/${interactionId}/resolve`,
      { response: "api-secret-key-12345" },
    );

    expect(status).toBe(200);
    expect(body.resolved).toBe(true);

    const event = await sub.waitForEvent("run.mcp_elicitation.resolved");
    expect((event.data as Record<string, unknown>).response).toBe("api-secret-key-12345");

    const terminal = await sub.waitForTerminal();
    expect(terminal.event).toBe("run.completed");
    await harness.waitForRun(runId);
    await new Promise((r) => setTimeout(r, 20));
    sub.close();
  });

  it("returns 404 when resolving an interaction for a nonexistent run", async () => {
    const { status, body } = await harness.postJson<{ error: string }>(
      "/runs/non-existent-run/interactions/test-id/resolve",
      { approved: true },
    );

    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
  });
});
