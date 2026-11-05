import { ServerHarness } from "../support/server-harness.js";
import { PROTOCOL_VERSION } from "../../src/protocol/types.js";

describe("Server Lifecycle (Wave 1 Harness)", () => {
  const harness = new ServerHarness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("GET / returns server metadata", async () => {
    const { status, body } = await harness.getJson<{ name: string; protocolVersion: string }>("/");
    expect(status).toBe(200);
    expect(body.name).toBe("nexum-host");
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("GET /health returns 200 liveness", async () => {
    const { status, body } = await harness.getJson<{ status: string }>("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("GET /capabilities returns registered strategies and protocol version", async () => {
    const { status, body } = await harness.getJson<{ agents: string[]; protocolVersion: string }>("/capabilities");
    expect(status).toBe(200);
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("GET /ready returns 200 ready with deep dependency status", async () => {
    const { status, body } = await harness.getJson<{
      status: string;
      checks: { postgres: string; redis: string; runtime: string };
    }>("/ready");
    expect(status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.checks.postgres).toBe("ok");
    expect(body.checks.redis).toBe("ok");
    expect(body.checks.runtime).toBe("ok");
  });
});
