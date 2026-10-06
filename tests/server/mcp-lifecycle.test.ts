import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerHarness } from "../support/server-harness.js";
import { FakeAgent } from "../support/fake-agent.js";
import type { NexumRun } from "../../src/protocol/types.js";

const FIXTURE_SERVER = join(process.cwd(), "tests/fixtures/mcp-fixture-server.mjs");

async function processExited(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("MCP server lifecycle in the host", () => {
  const harness = new ServerHarness();
  const dir = mkdtempSync(join(tmpdir(), "mcp-lifecycle-"));
  const pidFile = join(dir, "pids");
  const startedPids = () => readFileSync(pidFile, "utf8").trim().split("\n").map(Number);

  beforeAll(async () => {
    await harness.start({
      createAgent: () =>
        new FakeAgent({ mcpServers: [{ name: "docs", command: process.execPath, args: [FIXTURE_SERVER, pidFile] }] }),
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("should run each configured server once for every session, and stop it with the host", async () => {
    for (let i = 0; i < 3; i++) {
      const { body: session } = await harness.postJson<{ id: string }>("/sessions", {});
      const { body } = await harness.postJson<{ run: NexumRun }>(`/sessions/${session.id}/runs`, { goal: `turn ${i}` });
      await harness.waitForRun(body.run.id);
    }
    await harness.getJson("/capabilities");

    const pids = startedPids();
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0], 0)).not.toThrow();

    await harness.stop();

    await expect(processExited(pids[0])).resolves.toBe(true);
  });
});
