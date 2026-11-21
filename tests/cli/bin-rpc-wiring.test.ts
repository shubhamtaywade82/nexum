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

describeBuilt("bin/cli.js rpc process", () => {
  it("keeps stdout pure JSON-RPC and exits on stdin EOF instead of falling through to the TUI", () => {
    const home = mkdtempSync(join(tmpdir(), "nexum-rpc-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "nexum-rpc-ws-"));
    try {
      const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.list" });
      const run = spawnSync(process.execPath, [binPath, "rpc", "--workspace", workspace], {
        input: `${request}\n`,
        env: { PATH: process.env.PATH, HOME: home, NEXUM_TIER: "local" },
        encoding: "utf8",
        timeout: 60_000,
      });
      const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
      expect(run.status).toBe(0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 90_000);
});
