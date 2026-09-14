/**
 * Smoke test for the `nexum rpc` subcommand wiring in bin/cli.js.
 *
 * Verifies that the bin/cli.js file references the rpc entry point without
 * actually executing it (which would block on stdin). We grep for the
 * `if (command === 'rpc')` branch and confirm the dynamic import path.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "..", "bin", "cli.js");

describe("bin/cli.js rpc wiring", () => {
  it("dispatches the 'rpc' command to dist/cli/rpc.js", () => {
    const content = readFileSync(binPath, "utf8");
    expect(content).toMatch(/command === 'rpc'/);
    expect(content).toMatch(/import\('\.\.\/dist\/cli\/rpc\.js'\)/);
  });

  it("mentions rpc in the --help output", () => {
    const content = readFileSync(binPath, "utf8");
    expect(content).toMatch(/nexum rpc\s+Start JSON-RPC agent server over stdio/);
  });
});
