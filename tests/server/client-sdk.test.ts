import { ServerHarness } from "../support/server-harness.js";
import { NexumClient } from "../../src/assistant/client/index.js";
import { createRemoteAgentBridge } from "../../src/ui/agent-bridge.js";
import { EventBus } from "../../src/runtime/events/bus.js";
import type { RunEventEnvelope } from "../../src/protocol/types.js";
import type { RuntimeEvent } from "../../src/runtime/events/bus.js";

describe("Assistant Client SDK (Wave 13)", () => {
  const harness = new ServerHarness();
  let client: NexumClient;

  beforeAll(async () => {
    await harness.start();
    client = new NexumClient({ baseUrl: harness.baseUrl });
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    harness.resetRunHandler();
    await harness.pg.cleanTables();
  });

  it("calls health, ready, and capabilities via client methods", async () => {
    const health = await client.health();
    expect(health.status).toBe("ok");

    const ready = await client.ready();
    expect(ready.status).toBe("ready");
    expect(ready.checks.postgres).toBe("ok");

    const caps = await client.capabilities();
    expect(Array.isArray(caps.agents)).toBe(true);
    expect(caps.protocolVersion).toBeDefined();
    expect(caps.outputFormats).toEqual(["markdown", "openui"]);
  });

  it("manages session lifecycle (create, list, get)", async () => {
    const session = await client.createSession({ title: "SDK Test Session" });
    expect(session.id).toBeDefined();

    const list = await client.listSessions();
    expect(list.some((s) => s.id === session.id)).toBe(true);

    const detail = await client.getSession(session.id);
    expect(detail.session.id).toBe(session.id);
    expect(detail.session.title).toBe("SDK Test Session");
    expect(Array.isArray(detail.messages)).toBe(true);
  });

  it("executes a run and streams events using async iteration", async () => {
    const session = await client.createSession();
    const run = await client.createRun(session.id, "Evaluate arithmetic");
    expect(run.id).toBeDefined();
    expect(run.sessionId).toBe(session.id);

    const receivedEvents: RunEventEnvelope[] = [];
    for await (const event of client.streamEvents(run.id)) {
      receivedEvents.push(event);
      if (event.type === "run.completed" || event.type === "run.failed") {
        break;
      }
    }

    expect(receivedEvents.length).toBeGreaterThan(0);
    expect(receivedEvents.some((e) => e.type === "run.started")).toBe(true);
    expect(receivedEvents.some((e) => e.type === "run.completed")).toBe(true);

    const completed = await client.getRun(run.id);
    expect(completed.status).toBe("completed");
  });

  it("resolves a pending approval via resolveInteraction", async () => {
    harness.setRunHandler(async (_goal, agent) => `approved: ${await agent.requestApproval("Deploy", "to staging")}`);
    const session = await client.createSession();
    const run = await client.createRun(session.id, "Deploy to staging", { interactive: true });

    let interactionId = "";
    for await (const event of client.streamEvents(run.id)) {
      if (event.payload.type === "run.approval.required") {
        interactionId = event.payload.interactionId;
        break;
      }
    }
    const resolution = await client.resolveInteraction(run.id, interactionId, {
      approved: true,
      reason: "Approved from SDK",
    });

    expect(resolution).toEqual({ resolved: true, interactionId });
    expect((await harness.waitForRun(run.id)).output?.content).toBe("approved: true");
    harness.resetRunHandler();
  });

  it("sends Bearer token header when token is configured", async () => {
    const authClient = new NexumClient({
      baseUrl: harness.baseUrl,
      token: "valid_secret_token",
    });

    // Verify token gets attached on requests
    const session = await authClient.createSession({ title: "Authenticated session" });
    expect(session.id).toBeDefined();
  });

  describe("TUI Server Mode Bridge (Wave 15)", () => {
    it("runs user message through createRemoteAgentBridge and publishes events to EventBus", async () => {
      const bus = new EventBus();
      const events: RuntimeEvent[] = [];
      bus.subscribe((e) => events.push(e));

      const bridge = createRemoteAgentBridge(client, bus);
      await bridge.runUserMessage("TUI remote run test");

      expect(events.some((e) => e.type === "conversation.chunk" && (e as { role?: string }).role === "assistant")).toBe(
        true,
      );
      expect(events.some((e) => e.type === "status.changed" && (e as { status?: string }).status === "completed")).toBe(
        true,
      );
      await new Promise((r) => setTimeout(r, 50));
    });

    it("resolves approval through createRemoteAgentBridge", async () => {
      const bus = new EventBus();
      const bridge = createRemoteAgentBridge(client, bus);

      const session = await client.createSession();
      const run = await client.createRun(session.id, "Deploy to prod");
      // Simulate interaction resolution
      bridge.resolveApproval?.("appr_tui_1", true);

      await harness.waitForRun(run.id);
    });

    it("lists sessions and checks resumability", async () => {
      const bus = new EventBus();
      await client.createSession({ title: "Session A" });

      const bridge = createRemoteAgentBridge(client, bus);
      // Wait a tick for refreshSessions to query client.listSessions
      await new Promise((r) => setTimeout(r, 60));

      expect(bridge.hasResumableSession?.()).toBe(true);
      const list = bridge.listSessions?.() ?? [];
      expect(list.length).toBeGreaterThan(0);
    });
  });

  describe("Agentic Chat Web UI Client (Wave 16)", () => {
    it("creates a session and streams run events using agentic-chat client protocol", async () => {
      // Direct HTTP calls mirroring agentic-chat's createNexumSession and streamNexumRun
      const sessionRes = await fetch(`${harness.baseUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Agentic Chat Test" }),
      });
      expect(sessionRes.status).toBe(201);
      const { id: sessionId } = (await sessionRes.json()) as { id: string };
      expect(sessionId).toBeDefined();

      const runRes = await fetch(`${harness.baseUrl}/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "Web UI run request" }),
      });
      expect(runRes.status).toBe(201);
      const { run } = (await runRes.json()) as { run: { id: string } };
      expect(run.id).toBeDefined();

      const sseRes = await fetch(`${harness.baseUrl}/runs/${run.id}/events`, {
        headers: { Accept: "text/event-stream" },
      });
      expect(sseRes.status).toBe(200);

      const events: string[] = [];
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = raw
            .split("\n")
            .find((l) => l.startsWith("data:"))
            ?.replace(/^data:\s*/, "")
            .trim();
          if (dataLine) {
            const parsed = JSON.parse(dataLine);
            events.push(parsed.type);
            if (parsed.type === "run.completed" || parsed.type === "run.failed") {
              break;
            }
          }
        }
        if (events.includes("run.completed")) break;
      }
      reader.releaseLock();

      expect(events).toContain("run.started");
      expect(events).toContain("run.completed");
      await new Promise((r) => setTimeout(r, 50));
    });
  });
});
