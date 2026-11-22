/**
 * Smoke test for the `nexum rpc` subcommand wiring in bin/cli.js.
 *
 * Verifies that the bin/cli.js file references the rpc entry point without
 * actually executing it (which would block on stdin). We grep for the
 * `if (command === 'rpc')` branch and confirm the dynamic import path.
 */
import { describe, it, expect } from "@jest/globals";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "..", "bin", "cli.js");

describe("bin/cli.js rpc wiring", () => {
  it("dispatches the 'rpc' command to dist/cli/rpc.js", () => {
    const content = readFileSync(binPath, "utf8");
    // Quote-agnostic: the pre-commit formatter owns this file's quote style.
    expect(content).toMatch(/command === ["']rpc["']/);
    expect(content).toMatch(/import\(["']\.\.\/dist\/cli\/rpc\.js["']\)/);
  });

  it("mentions rpc in the --help output", () => {
    const content = readFileSync(binPath, "utf8");
    expect(content).toMatch(/nexum rpc\s+Start JSON-RPC agent server over stdio/);
  });
});

// Runs the built CLI, so it needs dist/ (CI builds before testing).
const describeBuilt = existsSync(join(here, "..", "..", "dist", "cli", "rpc.js")) ? describe : describe.skip;

function rpcSession(requests: Array<{ method: string; params?: unknown }>): {
  status: number | null;
  lines: string[];
  byId: Map<number, { result?: unknown; error?: { message: string } }>;
} {
  const home = mkdtempSync(join(tmpdir(), "nexum-rpc-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "nexum-rpc-ws-"));
  try {
    const input = requests.map((r, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...r })).join("\n");
    const run = spawnSync(process.execPath, [binPath, "rpc", "--workspace", workspace], {
      input: `${input}\n`,
      env: { PATH: process.env.PATH, HOME: home, NEXUM_TIER: "local" },
      encoding: "utf8",
      timeout: 60_000,
    });
    const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
    const byId = new Map(lines.map((line) => JSON.parse(line)).map((m) => [m.id as number, m]));
    return { status: run.status, lines, byId };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

describeBuilt("bin/cli.js rpc process", () => {
  it("keeps stdout pure JSON-RPC and exits on stdin EOF instead of falling through to the TUI", () => {
    const { status, lines } = rpcSession([{ method: "agent.list" }]);
    expect(status).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  }, 90_000);

  it("serves tools.list, skills.list, a receivable webhook endpoint and the process subagent provider", () => {
    const secret = "s3cret";
    const rawBody = '{"a":1}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
    const { byId } = rpcSession([
      { method: "tools.list" },
      { method: "skills.list" },
      { method: "webhooks.registerEndpoint", params: { endpoint: { id: "e1", path: "/e1", secret } } },
      {
        method: "webhooks.receive",
        params: {
          endpointId: "e1",
          type: "ping",
          rawBody,
          headers: { "x-webhook-signature": sig, "x-webhook-timestamp": ts },
        },
      },
      { method: "subagents.spawn", params: { provider: "nope", goal: "x" } },
    ]);
    expect((byId.get(1)?.result as Array<{ id: string }>).map((t) => t.id)).toContain("read_file");
    expect(Array.isArray(byId.get(2)?.result)).toBe(true);
    expect(byId.get(4)?.result).toMatchObject({ verified: true });
    expect(byId.get(5)?.error?.message).toMatch(/Available: .*in-process.*process/);
  }, 90_000);
});
