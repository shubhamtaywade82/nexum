import { ServerHarness } from "../support/server-harness.js";
import { MessageRepository } from "../../src/persistence/repositories/message-repository.js";

describe("Canonical PostgreSQL Sessions (Wave 2 & 3)", () => {
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

  it("POST /sessions creates a durable session in PostgreSQL", async () => {
    const { status, body } = await harness.postJson<{ id: string; createdAt: string }>(
      "/sessions",
      { title: "Test Auth Bug" },
    );
    expect(status).toBe(201);
    expect(body.id).toBeDefined();

    // Verify row exists in PostgreSQL
    const { status: getStatus, body: sessionBody } = await harness.getJson<{
      session: { id: string; workspaceRoot: string; messageCount: number };
      messages: unknown[];
    }>(`/sessions/${body.id}`);

    expect(getStatus).toBe(200);
    expect(sessionBody.session.id).toBe(body.id);
    expect(sessionBody.messages).toEqual([]);
  });

  it("GET /sessions lists all sessions from PostgreSQL", async () => {
    await harness.postJson("/sessions", { title: "Session A" });
    await harness.postJson("/sessions", { title: "Session B" });

    const { status, body } = await harness.getJson<{ sessions: Array<{ id: string }> }>("/sessions");
    expect(status).toBe(200);
    expect(body.sessions.length).toBe(2);
  });

  it("hydrates conversation history from PostgreSQL across restarts", async () => {
    // 1. Create a session
    const { body: created } = await harness.postJson<{ id: string }>("/sessions", {});
    const sessionId = created.id;

    // 2. Insert messages directly to PostgreSQL (simulating prior turns)
    const msgRepo = new MessageRepository(harness.db);
    await msgRepo.append(sessionId, [
      { role: "user", content: "What is 2 + 2?" },
      { role: "assistant", content: "4" },
    ]);

    // 3. Restart server on same PostgreSQL (clearing in-memory registry, keeping DB)
    await harness.restartServer();

    // 5. Query session via HTTP — should return durable history from PostgreSQL
    const { status, body } = await harness.getJson<{
      session: { id: string };
      messages: Array<{ role: string; content: string }>;
    }>(`/sessions/${sessionId}`);

    expect(status).toBe(200);
    expect(body.messages.length).toBe(2);
    expect(body.messages[0]?.role).toBe("user");
    expect(body.messages[0]?.content).toBe("What is 2 + 2?");
    expect(body.messages[1]?.role).toBe("assistant");
    expect(body.messages[1]?.content).toBe("4");
  });

  it("hydrates AgentConversation from PostgreSQL on first run", async () => {
    // 1. Create a session
    const { body: created } = await harness.postJson<{ id: string }>("/sessions", {});
    const sessionId = created.id;

    // 2. Insert messages directly to PostgreSQL
    const msgRepo = new MessageRepository(harness.db);
    await msgRepo.append(sessionId, [
      { role: "user", content: "Remember this secret: 42" },
      { role: "assistant", content: "Noted." },
    ]);

    // 3. Restart server
    await harness.restartServer();

    // 4. Trigger a run on this session
    await harness.postJson(`/sessions/${sessionId}/runs`, { goal: "What was the secret?" });

    // 5. Inspect the agent's conversation in memory
    const agent = harness.lastAgent;
    expect(agent).not.toBeNull();
    const msgs = agent!.conversation.getMessages();
    expect(msgs.some((m) => m.content === "Remember this secret: 42")).toBe(true);
  });
});
