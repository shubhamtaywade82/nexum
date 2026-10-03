import { ServerHarness } from "../support/server-harness.js";
import { subscribeToEvents, type SseSubscription } from "../support/sse-client.js";
import type { FakeAgent } from "../support/fake-agent.js";
import type { NexumRun } from "../../src/protocol/types.js";

interface StartedRun {
  runId: string;
  sub: SseSubscription;
}

function useHarness(options: { interactionTimeoutMs?: number } = {}) {
  const harness = new ServerHarness();

  beforeAll(async () => {
    await harness.start(options);
  });
  afterAll(async () => {
    await harness.stop();
  });
  beforeEach(async () => {
    harness.resetRunHandler();
    await harness.pg.cleanTables();
  });

  async function startRun(
    goal: string,
    handler: (goal: string, agent: FakeAgent) => Promise<string>,
    body: Record<string, unknown> = { interactive: true },
  ): Promise<StartedRun> {
    harness.setRunHandler(handler);
    const { body: sess } = await harness.postJson<{ id: string }>("/sessions", {});
    const { body: created } = await harness.postJson<{ run: NexumRun }>(`/sessions/${sess.id}/runs`, { goal, ...body });
    return { runId: created.run.id, sub: subscribeToEvents(harness.baseUrl, created.run.id) };
  }

  function resolve(runId: string, interactionId: string, resolution: Record<string, unknown>) {
    return harness.postJson<{ resolved?: boolean; error?: string }>(
      `/runs/${runId}/interactions/${interactionId}/resolve`,
      resolution,
    );
  }

  return { harness, startRun, resolve };
}

function interactionIdOf(event: { data: unknown }): string {
  return (event.data as { interactionId: string }).interactionId;
}

describe("Run interactions (approvals and clarifications)", () => {
  const { harness, startRun, resolve } = useHarness();

  it("should pause a run on an approval and continue it once approved", async () => {
    const { runId, sub } = await startRun("Deploy", async (_goal, agent) => {
      const approved = await agent.requestApproval("Deploy build", "Pushes to production");
      return `approved: ${approved}`;
    });

    const required = await sub.waitForEvent("run.approval.required");
    expect(required.data).toMatchObject({ title: "Deploy build", summary: "Pushes to production" });

    const { status, body } = await resolve(runId, interactionIdOf(required), { approved: true });
    expect(status).toBe(200);
    expect(body.resolved).toBe(true);

    expect((await sub.waitForEvent("run.approval.resolved")).data).toMatchObject({ approved: true });
    await sub.waitForTerminal();
    expect((await harness.waitForRun(runId)).output?.content).toBe("approved: true");
    sub.close();
  });

  it("should deny the tool when the approval is rejected", async () => {
    const { runId, sub } = await startRun("Deploy", async (_goal, agent) => {
      return `approved: ${await agent.requestApproval("Deploy build", "Pushes to production")}`;
    });

    const required = await sub.waitForEvent("run.approval.required");
    await resolve(runId, interactionIdOf(required), { approved: false });

    await sub.waitForTerminal();
    expect((await harness.waitForRun(runId)).output?.content).toBe("approved: false");
    sub.close();
  });

  it("should continue a run with the clarification option the user picked", async () => {
    const { runId, sub } = await startRun("Choose deployment", async (_goal, agent) => {
      const answer = await agent.requestClarification({
        id: "clar_1",
        prompt: "Strategy?",
        question: "Which strategy?",
        options: [
          { id: "blue-green", label: "Blue/green", detail: "Zero downtime" },
          { id: "rolling", label: "Rolling" },
          { id: "other", label: "Something else", isCustom: true },
        ],
      });
      return `picked: ${answer.selectedId}`;
    });

    const required = await sub.waitForEvent("run.clarification.required");
    expect(required.data).toMatchObject({
      question: "Which strategy?",
      options: [
        { id: "blue-green", label: "Blue/green", description: "Zero downtime" },
        { id: "rolling", label: "Rolling" },
      ],
    });

    await resolve(runId, interactionIdOf(required), { selectedId: "rolling" });

    await sub.waitForTerminal();
    expect((await harness.waitForRun(runId)).output?.content).toBe("picked: rolling");
    sub.close();
  });

  it("should deny approvals and skip clarifications for a run that is not interactive", async () => {
    const { runId, sub } = await startRun(
      "Headless",
      async (_goal, agent) => {
        const approved = await agent.requestApproval("Delete files", "rm -rf");
        const answer = await agent.requestClarification({
          id: "clar_2",
          prompt: "Which?",
          question: "Which?",
          options: [{ id: "a", label: "A" }],
        });
        return `approved: ${approved}, clarification: ${answer.selectedId}`;
      },
      {},
    );

    await sub.waitForTerminal();

    expect((await harness.waitForRun(runId)).output?.content).toBe("approved: false, clarification: skipped");
    expect(sub.events.map((e) => e.event)).not.toContain("run.approval.required");
    expect(sub.events.map((e) => e.event)).not.toContain("run.clarification.required");
    sub.close();
  });

  it("should reject an approval answer that omits approved, leaving it pending", async () => {
    const { runId, sub } = await startRun("Deploy", async (_goal, agent) => {
      return `approved: ${await agent.requestApproval("Deploy build", "Pushes to production")}`;
    });
    const interactionId = interactionIdOf(await sub.waitForEvent("run.approval.required"));

    const empty = await resolve(runId, interactionId, {});
    expect(empty.status).toBe(400);
    const wrongKind = await resolve(runId, interactionId, { selectedId: "yes" });
    expect(wrongKind.status).toBe(400);

    await resolve(runId, interactionId, { approved: true });
    await sub.waitForTerminal();
    expect((await harness.waitForRun(runId)).output?.content).toBe("approved: true");
    sub.close();
  });

  it("should reject a clarification answer that was not offered", async () => {
    const { runId, sub } = await startRun("Choose", async (_goal, agent) => {
      const answer = await agent.requestClarification({
        id: "clar_3",
        prompt: "Which?",
        question: "Which?",
        options: [{ id: "a", label: "A" }],
      });
      return `picked: ${answer.selectedId}`;
    });
    const interactionId = interactionIdOf(await sub.waitForEvent("run.clarification.required"));

    expect((await resolve(runId, interactionId, { selectedId: "zzz" })).status).toBe(400);

    await resolve(runId, interactionId, { selectedId: "a" });
    await sub.waitForTerminal();
    sub.close();
  });

  it("should return 409 when an interaction is resolved twice", async () => {
    const { runId, sub } = await startRun("Deploy", async (_goal, agent) => {
      await agent.requestApproval("Deploy build", "Pushes to production");
      await new Promise((r) => setTimeout(r, 200));
      return "done";
    });
    const interactionId = interactionIdOf(await sub.waitForEvent("run.approval.required"));

    expect((await resolve(runId, interactionId, { approved: true })).status).toBe(200);
    const second = await resolve(runId, interactionId, { approved: false });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe("interaction_already_resolved");
    await sub.waitForTerminal();
    sub.close();
  });

  it("should return 404 for an interaction that was never requested", async () => {
    const { runId, sub } = await startRun("Wait", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "done";
    });

    const { status, body } = await resolve(runId, "appr_made_up", { approved: true });

    expect(status).toBe(404);
    expect(body.error).toBe("interaction_not_found");
    await sub.waitForTerminal();
    sub.close();
  });

  it("should return 404 for a nonexistent run", async () => {
    const { status, body } = await harness.postJson<{ error: string }>(
      "/runs/non-existent-run/interactions/test-id/resolve",
      { approved: true },
    );

    expect(status).toBe(404);
    expect(body.error).toBe("run_not_found");
  });

  it("should cancel a run that is waiting on an approval and deny that approval", async () => {
    let approvedWhenCancelled: boolean | null = null;
    const { runId, sub } = await startRun("Deploy", async (_goal, agent) => {
      approvedWhenCancelled = await agent.requestApproval("Deploy build", "Pushes to production");
      if (agent.execution.signal?.aborted) throw new Error("aborted");
      return "should not complete";
    });
    await sub.waitForEvent("run.approval.required");

    const { body } = await harness.postJson<{ cancelled: boolean }>(`/runs/${runId}/cancel`, {});

    expect(body.cancelled).toBe(true);
    expect((await sub.waitForTerminal()).event).toBe("run.cancelled");
    expect(approvedWhenCancelled).toBe(false);
    sub.close();
  });
});

describe("Run interactions that nobody answers", () => {
  const { harness, startRun } = useHarness({ interactionTimeoutMs: 80 });

  it("should deny an approval that times out and let the run continue", async () => {
    const { runId, sub } = await startRun("Deploy", async (_goal, agent) => {
      return `approved: ${await agent.requestApproval("Deploy build", "Pushes to production")}`;
    });

    expect((await sub.waitForEvent("run.approval.resolved")).data).toMatchObject({ approved: false });
    await sub.waitForTerminal();
    expect((await harness.waitForRun(runId)).output?.content).toBe("approved: false");
    sub.close();
  });
});
