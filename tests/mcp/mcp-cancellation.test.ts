// A cancelled call reaches the server: the server is told, and it stops its work. The slow fixture writes a marker file
// when it is cancelled, so the test can see that the cancellation travelled over the wire, not only that the caller stopped.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpServerTools } from "../../src/mcp/adapter/mcp-server-tools.js";
import { McpTrustPolicy } from "../../src/mcp/trust.js";

const SLOW = join(process.cwd(), "tests/fixtures/mcp-slow-server.mjs");

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe("cancelling a call stops the server's work", () => {
  it("the caller gets its cancellation at once, and the server is told so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cancel-"));
    const marker = join(dir, "cancelled");
    const trust = new McpTrustPolicy({ rules: [{ match: "slow", trust: "trusted" }] });
    const connected = await connectMcpServerTools(process.execPath, [SLOW, marker], { serverName: "slow", trust });
    try {
      const slow = connected.tools.find((tool) => tool.name === "slow")!;
      const controller = new AbortController();
      const started = Date.now();
      const pending = slow.call({}, { signal: controller.signal } as never);
      setTimeout(() => controller.abort(), 300);

      const out = await pending;
      expect(out.error).toBe("McpCancelled");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await until(() => existsSync(marker), 5_000)).toBe(true);
    } finally {
      await connected.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
