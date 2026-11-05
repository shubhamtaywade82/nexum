import { ServerHarness } from "../support/server-harness.js";
import { createNexumHost } from "../../src/host/server.js";
import { FakeAgent } from "../support/fake-agent.js";

describe("Health/Readiness & Security (Wave 11)", () => {
  const harness = new ServerHarness();
  const TEST_TOKEN = "sec_test_token_98765";

  beforeAll(async () => {
    await harness.start({ token: TEST_TOKEN });
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    await harness.pg.cleanTables();
  });

  it("refuses to start when bound to non-loopback address without NEXUM_SERVER_TOKEN", async () => {
    const originalToken = process.env.NEXUM_SERVER_TOKEN;
    delete process.env.NEXUM_SERVER_TOKEN;

    const host = createNexumHost({
      createAgent: () => new FakeAgent().asAgent(),
      workspaceRoot: process.cwd(),
      db: harness.db,
      eventBus: harness.eventBus,
      host: "0.0.0.0",
      port: 0,
    });

    await expect(host.start()).rejects.toThrow("NEXUM_SERVER_TOKEN must be set when binding to non-loopback address");

    if (originalToken !== undefined) {
      process.env.NEXUM_SERVER_TOKEN = originalToken;
    }
  });

  it("permits unauthenticated access to health and ready probes even with token configured", async () => {
    const health = await harness.getJson<{ status: string }>("/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");

    const ready = await harness.getJson<{ status: string }>("/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe("ready");
  });

  it("rejects unauthenticated requests to protected endpoints with 401", async () => {
    const { status, body } = await harness.postJson<{ error: string }>("/sessions", {});
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");

    const listRes = await harness.getJson<{ error: string }>("/sessions");
    expect(listRes.status).toBe(401);
    expect(listRes.body.error).toBe("unauthorized");
  });

  it("rejects requests with invalid Bearer token with 401", async () => {
    const { status, body } = await harness.postJson<{ error: string }>(
      "/sessions",
      {},
      { Authorization: "Bearer wrong-token-xyz" },
    );
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("accepts requests with valid Bearer token", async () => {
    const { status, body } = await harness.postJson<{ id: string }>(
      "/sessions",
      {},
      { Authorization: `Bearer ${TEST_TOKEN}` },
    );
    expect(status).toBe(201);
    expect(body.id).toBeDefined();

    const listRes = await harness.getJson<{ sessions: Array<{ id: string }> }>("/sessions", {
      Authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(listRes.status).toBe(200);
    expect(listRes.body.sessions.length).toBe(1);
  });
});
