import { summarizePlan } from "../../src/orchestration/plan-summary.js";
import type { PlanStep } from "../../src/orchestration/types.js";

const step = (id: string, status: PlanStep["status"]): PlanStep => ({
  id,
  description: `do ${id}`,
  status,
  dependencies: [],
  retryCount: 0,
});

describe("summarizePlan", () => {
  it("summarises a fully completed plan", () => {
    expect(summarizePlan([step("a", "completed"), step("b", "completed")])).toBe(
      "Ran as a plan: 2/2 steps completed.\n✓ do a\n✓ do b",
    );
  });

  it("calls out failures and what did not run", () => {
    const out = summarizePlan([step("a", "completed"), step("b", "failed"), step("c", "blocked")]);
    expect(out).toContain("1/3 steps completed, 1 failed");
    expect(out).toContain("/plan resumes");
    expect(out).toContain("✗ do b");
    expect(out).toContain("⊘ do c");
  });
});
