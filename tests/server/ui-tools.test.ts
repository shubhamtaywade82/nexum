import { ServerHarness } from "../support/server-harness.js";
import { fakeToolCalls } from "../support/fake-agent.js";

describe("UI tool invocation (POST /sessions/:id/tools/:name)", () => {
  const harness = new ServerHarness();
  let sessionId = "";

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    await harness.pg.cleanTables();
    fakeToolCalls.length = 0;
    ({
      body: { id: sessionId },
    } = await harness.postJson<{ id: string }>("/sessions", {}));
  });

  it("runs a read-only tool through the gateway and returns its result", async () => {
    const { status, body } = await harness.postJson(`/sessions/${sessionId}/tools/fake_quote`, {
      args: { symbol: "BTCUSDT" },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: { symbol: "BTCUSDT", price: 67000.5 } });
  });

  it("refuses a non-read tool without executing it", async () => {
    const { status, body } = await harness.postJson<{ error: string }>(
      `/sessions/${sessionId}/tools/fake_place_order`,
      { args: { symbol: "BTCUSDT" } },
    );

    expect(status).toBe(403);
    expect(body.error).toBe("tool_requires_run");
    expect(fakeToolCalls).toEqual([]);
  });

  it("returns gateway validation failures as a failed result", async () => {
    const { status, body } = await harness.postJson<{ ok: boolean; error?: { code: string } }>(
      `/sessions/${sessionId}/tools/fake_quote`,
      { args: {} },
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("ValidationError");
  });

  it("returns 404 for an unknown tool", async () => {
    const { status, body } = await harness.postJson<{ error: string }>(`/sessions/${sessionId}/tools/nope`, {});

    expect(status).toBe(404);
    expect(body.error).toBe("tool_not_found");
  });

  it("returns 404 for an unknown session", async () => {
    const { status } = await harness.postJson("/sessions/missing/tools/fake_quote", { args: { symbol: "X" } });

    expect(status).toBe(404);
  });

  it("rejects a non-object args payload", async () => {
    const { status, body } = await harness.postJson<{ error: string }>(`/sessions/${sessionId}/tools/fake_quote`, {
      args: "BTCUSDT",
    });

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });
});
