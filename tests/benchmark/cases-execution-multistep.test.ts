import { buildExecutionCases } from "../../src/benchmark/cases-execution.js";
import type { AgenticBenchmarkCase, AgenticToolCall, AgenticTrajectory } from "../../src/benchmark/types.js";

type Plan = Array<[name: string, args: Record<string, unknown>]>;

// The multi-step execution cases run the real read_file and search_code tools against the
// fixture workspace, so these runs also check that the fixtures say what the validators expect.
async function run(testCase: AgenticBenchmarkCase, plan: Plan, final: string): Promise<AgenticTrajectory> {
  const toolCallsMade: AgenticToolCall[] = [];
  for (const [name, args] of plan) {
    toolCallsMade.push({ name, args, result: await testCase.resolveTool(name, args) });
  }
  return { finalContent: final, toolCallsMade, turns: plan.length + 1, hitMaxTurns: false };
}

describe("multi-step execution cases", () => {
  let cases: AgenticBenchmarkCase[];
  const find = (id: string) => cases.find((c) => c.id === id)!;

  beforeAll(async () => {
    cases = await buildExecutionCases();
  });

  it("reads config/app.json, then the matching changelog entry", async () => {
    const c = find("execution-read-two-files");
    const config = await c.resolveTool("read_file", { path: "config/app.json" });
    expect(JSON.stringify(config)).toContain("1.4.2");
    const changelog = await c.resolveTool("read_file", { path: "CHANGELOG.md" });
    expect(JSON.stringify(changelog)).toContain("offline mode");

    const good = await run(
      c,
      [
        ["read_file", { path: "config/app.json" }],
        ["read_file", { path: "CHANGELOG.md" }],
      ],
      "Version 1.4.2 added offline mode for the ledger view.",
    );
    expect(c.validate(good)).toEqual({ pass: true });
    const guessed = await run(c, [["read_file", { path: "CHANGELOG.md" }]], "It added offline mode.");
    expect(c.validate(guessed).pass).toBe(false);
  });

  it("finds computeTax with search_code and reports GST_RATE", async () => {
    const c = find("execution-search-then-read");
    const hits = await c.resolveTool("search_code", { query: "function computeTax" });
    expect(JSON.stringify(hits)).toContain("tax.ts");

    const good = await run(
      c,
      [
        ["search_code", { query: "function computeTax" }],
        ["read_file", { path: "src/billing/tax.ts" }],
      ],
      "computeTax in src/billing/tax.ts uses GST_RATE = 0.18.",
    );
    expect(c.validate(good)).toEqual({ pass: true });
    const unsearched = await run(c, [["read_file", { path: "src/billing/tax.ts" }]], "It uses 0.18.");
    expect(c.validate(unsearched).pass).toBe(false);
  });

  it("names only the file that defines handleRefund", async () => {
    const c = find("execution-find-defining-file");
    const hits = await c.resolveTool("search_code", { query: "function handleRefund" });
    expect(JSON.stringify(hits)).toContain("refunds.ts");
    expect(JSON.stringify(hits)).not.toContain("charges.ts");

    const good = await run(c, [["search_code", { query: "function handleRefund" }]], "src/payments/refunds.ts");
    expect(c.validate(good)).toEqual({ pass: true });
    const wrong = await run(c, [["search_code", { query: "handle" }]], "It is in src/payments/charges.ts.");
    expect(c.validate(wrong).pass).toBe(false);
  });

  it("reports the missing roadmap instead of inventing a Q3 goal", async () => {
    const c = find("execution-missing-file-honest");
    const missing = await c.resolveTool("read_file", { path: "docs/ROADMAP.md" });
    expect(missing).toHaveProperty("error");

    const good = await run(c, [["read_file", { path: "docs/ROADMAP.md" }]], "docs/ROADMAP.md does not exist.");
    expect(c.validate(good)).toEqual({ pass: true });
    const invented = await run(c, [["read_file", { path: "docs/ROADMAP.md" }]], "The Q3 goal is to ship mobile.");
    expect(c.validate(invented).pass).toBe(false);
  });

  it("keeps the original search case on the auth TODO: the new fixtures add no TODO", async () => {
    const c = find("execution-real-search-code");
    const result = (await c.resolveTool("search_code", { query: "TODO" })) as { matches: Array<{ path: string }> };
    expect(result.matches.map((m) => m.path)).toEqual(["src/auth.ts"]);
  });
});
