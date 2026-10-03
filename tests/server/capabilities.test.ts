import { join } from "node:path";
import { ServerHarness } from "../support/server-harness.js";
import { FakeAgent } from "../support/fake-agent.js";
import { discoverCapabilities } from "../../src/host/capabilities.js";
import type { NexumCapabilities } from "../../src/protocol/types.js";

const FIXTURE_SERVER = join(process.cwd(), "tests/fixtures/mcp-fixture-server.mjs");

describe("Capability discovery (GET /capabilities)", () => {
  const harness = new ServerHarness();

  beforeAll(async () => {
    await harness.start({
      createAgent: () =>
        new FakeAgent({
          mcpServers: [
            { name: "docs", command: process.execPath, args: [FIXTURE_SERVER] },
            { name: "restricted", command: process.execPath, args: [FIXTURE_SERVER], trust: "ask" },
          ],
        }),
    });
  });
  afterAll(async () => {
    await harness.stop();
  });

  it("should list tools, skills, models and MCP servers alongside the static capabilities", async () => {
    const { status, body } = await harness.getJson<NexumCapabilities>("/capabilities");

    expect(status).toBe(200);
    expect(body.outputFormats).toEqual(["markdown", "openui"]);
    expect(body.tools).toEqual([
      expect.objectContaining({ id: "fake_high_opted_in", risk: "high", uiInvocable: false }),
      expect.objectContaining({ id: "fake_place_order", risk: "high", uiInvocable: false }),
      expect.objectContaining({ id: "fake_quote", risk: "read", uiInvocable: true }),
      expect.objectContaining({ id: "fake_unlisted_read", risk: "read", uiInvocable: false }),
    ]);
    expect(body.skills).toEqual([
      { id: "deploy", name: "Deploy", description: "Ship a release", tags: ["ops"], scope: "global" },
    ]);
    expect(body.models).toEqual([{ name: "fake-model", capabilities: ["coding", "tools"] }]);
    expect(body.mcp).toEqual([
      { name: "docs", trust: "trusted", status: "connected", tools: 3 },
      { name: "restricted", trust: "ask", status: "denied", tools: 0 },
    ]);
  });

  it("should not expose filesystem paths, commands or arguments", async () => {
    const { body } = await harness.getJson<NexumCapabilities>("/capabilities");

    const json = JSON.stringify(body);
    expect(json).not.toContain("/home/someone");
    expect(json).not.toContain("SKILL.md");
    expect(body.mcp[0]).not.toHaveProperty("command");
    expect(body.mcp[0]).not.toHaveProperty("args");
  });

  it("should report the same UI-invocable answer that the tool endpoint enforces", async () => {
    const { body: caps } = await harness.getJson<NexumCapabilities>("/capabilities");
    const { body: session } = await harness.postJson<{ id: string }>("/sessions", {});

    for (const tool of caps.tools) {
      const { status } = await harness.postJson(`/sessions/${session.id}/tools/${tool.id}`, {
        args: { symbol: "BTCUSDT" },
      });
      expect(status === 200).toBe(tool.uiInvocable);
    }
  });
});

describe("discoverCapabilities", () => {
  it("should return an empty model list instead of waiting on a provider that never answers", async () => {
    const agent = new FakeAgent();
    agent.listModels = () => new Promise<string[]>(() => {});

    const started = Date.now();
    const { models } = await discoverCapabilities(agent.asAgent(), { modelListTimeoutMs: 50 });

    expect(models).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
