import { describe, it, expect } from "@jest/globals";
import { buildGoldenCodingCases } from "../../src/benchmark/cases-golden-coding.js";
import { AgenticTrajectory } from "../../src/benchmark/types.js";

function trajectory(overrides: Partial<AgenticTrajectory> = {}): AgenticTrajectory {
  return { finalContent: "", toolCallsMade: [], turns: 1, hitMaxTurns: false, ...overrides };
}

describe("buildGoldenCodingCases", () => {
  it("builds 5 golden coding cases with category golden-coding", async () => {
    const cases = await buildGoldenCodingCases();
    expect(cases).toHaveLength(5);
    for (const c of cases) {
      expect(c.category).toBe("golden-coding");
      expect(c.kind).toBe("agentic");
      expect(c.tools.length).toBeGreaterThan(0);
    }
  });

  it("coding-ts-defensive-reduce reads discounts.ts and passes on correct diagnosis", async () => {
    const cases = await buildGoldenCodingCases();
    const tsCase = cases.find((c) => c.id === "coding-ts-defensive-reduce")!;
    const fileResult = await tsCase.resolveTool("read_file", { path: "src/pricing/discounts.ts" });
    expect(String(fileResult.content)).toContain("calculateTotal");

    const passResult = tsCase.validate(
      trajectory({
        toolCallsMade: [{ name: "read_file", args: { path: "src/pricing/discounts.ts" }, result: {} }],
        finalContent:
          "If order.items is undefined, a TypeError occurs. We should use optional chaining (order.items?.reduce) or fallback to an empty array (order.items ?? []).",
      }),
    );
    expect(passResult.pass).toBe(true);

    const failResult = tsCase.validate(trajectory({ finalContent: "everything looks fine" }));
    expect(failResult.pass).toBe(false);
  });

  it("coding-react-race-cleanup detects missing cleanup in useEffect", async () => {
    const cases = await buildGoldenCodingCases();
    const reactCase = cases.find((c) => c.id === "coding-react-race-cleanup")!;
    const fileResult = await reactCase.resolveTool("read_file", { path: "src/hooks/useSearchResults.ts" });
    expect(String(fileResult.content)).toContain("useSearchResults");

    const passResult = reactCase.validate(
      trajectory({
        toolCallsMade: [{ name: "read_file", args: { path: "src/hooks/useSearchResults.ts" }, result: {} }],
        finalContent:
          "Add a cleanup function returning () => { active = false; } or use an AbortController to discard stale promise responses.",
      }),
    );
    expect(passResult.pass).toBe(true);
  });

  it("coding-node-async-error-propagation checks error forwarding to next()", async () => {
    const cases = await buildGoldenCodingCases();
    const nodeCase = cases.find((c) => c.id === "coding-node-async-error-propagation")!;
    const fileResult = await nodeCase.resolveTool("read_file", { path: "src/api/users.ts" });
    expect(String(fileResult.content)).toContain("getUser");

    const passResult = nodeCase.validate(
      trajectory({
        toolCallsMade: [{ name: "read_file", args: { path: "src/api/users.ts" }, result: {} }],
        finalContent: "Express will crash with unhandled rejection. We must wrap in try/catch and call next(err).",
      }),
    );
    expect(passResult.pass).toBe(true);
  });

  it("coding-rails-sql-injection-prevention identifies SQL injection and parameterized fix", async () => {
    const cases = await buildGoldenCodingCases();
    const railsCase = cases.find((c) => c.id === "coding-rails-sql-injection-prevention")!;
    const fileResult = await railsCase.resolveTool("read_file", { path: "app/models/account.rb" });
    expect(String(fileResult.content)).toContain("recent_activity");

    const passResult = railsCase.validate(
      trajectory({
        toolCallsMade: [{ name: "read_file", args: { path: "app/models/account.rb" }, result: {} }],
        finalContent:
          "The scope has a SQL injection vulnerability due to string interpolation. It should use parameterized query where('last_active_at >= ?', cutoff_date).",
      }),
    );
    expect(passResult.pass).toBe(true);
  });

  it("coding-patch-feature-flag validates real patch_file mutation", async () => {
    const cases = await buildGoldenCodingCases();
    const patchCase = cases.find((c) => c.id === "coding-patch-feature-flag")!;
    const patchRes = await patchCase.resolveTool("patch_file", {
      path: "src/config/features.ts",
      find: "maxRetryLimit: 1,",
      replace: "maxRetryLimit: 3,",
    });
    expect(patchRes.bytesWritten).toBeGreaterThan(0);

    const passResult = patchCase.validate(
      trajectory({
        toolCallsMade: [
          {
            name: "patch_file",
            args: { path: "src/config/features.ts", find: "maxRetryLimit: 1,", replace: "maxRetryLimit: 3," },
            result: patchRes,
          },
        ],
        finalContent: "Successfully updated maxRetryLimit to 3.",
      }),
    );
    expect(passResult.pass).toBe(true);
  });
});
