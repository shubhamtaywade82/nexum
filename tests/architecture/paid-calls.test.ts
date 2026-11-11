/**
 * Paid model calls leave Nexum through the inference dispatcher (src/models/gateway/inference-dispatcher.ts).
 *
 * A Provider handle is what lets a caller skip the accounting: `provider.chat()` reaches the cloud without a gate,
 * a record, or an admission check. So the rule is on who may hold one. Only the models layer and the composition
 * roots that construct providers may import the Provider class. Every other module takes a ChatPort, which is a
 * lane-bound dispatch, and a new importer must be added to the allowlist below deliberately.
 */
import { describe, it, expect } from "@jest/globals";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = process.cwd();
const SRC = resolve(ROOT, "src");

/** Modules allowed to import the Provider class, each with the reason it needs to. */
const PROVIDER_IMPORTERS: Record<string, string> = {
  "src/cli/services/model-stack.ts": "CLI composition root: constructs the providers and their lanes",
  "src/cli/doctor.ts": "diagnostics: probes model listings, sends no chat",
  "src/benchmark/cli.ts": "benchmark composition root: constructs the providers and their lanes",
  "src/evolution/cli.ts": "evolution composition root: constructs the providers",
  "src/evolution/benchmarks.ts": "wraps the given provider in a single-lane dispatcher before use",
  "src/evolution/mutation/nexum-agent-runtime.ts": "wraps the given provider in a single-lane dispatcher before use",
};

/** The provider layer itself may use the class freely. */
const MODELS_PREFIX = "src/models/";

/** Only the gateway may call the router directly, because only the gateway records the result. */
const ROUTER_CALLERS = ["src/models/gateway/model-gateway.ts"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

/** Whether a module imports the identifier `Provider`, type-only imports included: a type still lets you call it. */
function importsProviderClass(source: string): boolean {
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  for (const match of source.matchAll(pattern)) {
    const names = match[1].split(",").map((name) => name.trim().replace(/^type\s+/, ""));
    if (names.includes("Provider")) return true;
  }
  return false;
}

describe("paid model calls leave through the dispatcher", () => {
  const files = sourceFiles(SRC).map((file) => ({ path: rel(file), source: readFileSync(file, "utf8") }));

  it("only the models layer and the listed composition roots import the Provider class", () => {
    const offenders = files
      .filter((file) => importsProviderClass(file.source))
      .filter((file) => !file.path.startsWith(MODELS_PREFIX) && !(file.path in PROVIDER_IMPORTERS))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("every allowlisted importer still exists and still imports Provider (no stale entries)", () => {
    for (const path of Object.keys(PROVIDER_IMPORTERS)) {
      expect(existsSync(join(ROOT, path))).toBe(true);
      const file = files.find((candidate) => candidate.path === path);
      expect(file && importsProviderClass(file.source)).toBe(true);
    }
  });

  it("only the gateway calls the router, so every router result is recorded", () => {
    const callers = files
      .filter((file) => /\brouter\.route\(/.test(file.source) && !file.path.startsWith("src/models/router/"))
      .map((file) => file.path);

    expect(callers.sort()).toEqual(ROUTER_CALLERS);
  });
});
