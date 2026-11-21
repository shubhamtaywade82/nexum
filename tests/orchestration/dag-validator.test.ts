import { validatePlanDag, sanitizePlanDag } from "../../src/orchestration/dag-validator.js";
import type { PlanStep } from "../../src/core/plan/plan-contracts.js";

function makeStep(id: string, dependencies: string[] = []): PlanStep {
  return {
    id,
    description: `step ${id}`,
    status: "pending",
    dependencies,
    retryCount: 0,
  };
}

describe("DAG Validator & Sanitizer", () => {
  it("validates a healthy linear and branched DAG", () => {
    const steps: PlanStep[] = [
      makeStep("s1", []),
      makeStep("s2", ["s1"]),
      makeStep("s3", ["s1"]),
      makeStep("s4", ["s2", "s3"]),
    ];

    const result = validatePlanDag(steps);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.roots).toEqual(["s1"]);
    expect(result.leaves).toEqual(["s4"]);
    expect(result.executionOrder.indexOf("s1")).toBeLessThan(result.executionOrder.indexOf("s2"));
    expect(result.executionOrder.indexOf("s2")).toBeLessThan(result.executionOrder.indexOf("s4"));
  });

  it("detects self-dependencies and unknown dependencies", () => {
    const steps: PlanStep[] = [makeStep("s1", ["s1"]), makeStep("s2", ["s99"])];

    const result = validatePlanDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining(['step "s1" depends on itself', 'step "s2" depends on unknown step "s99"']),
    );
  });

  it("detects direct and indirect dependency cycles", () => {
    const directCycle: PlanStep[] = [makeStep("s1", ["s2"]), makeStep("s2", ["s1"])];
    const directResult = validatePlanDag(directCycle);
    expect(directResult.valid).toBe(false);
    expect(directResult.errors.some((e) => e.includes("dependency cycle detected"))).toBe(true);

    const indirectCycle: PlanStep[] = [makeStep("s1", ["s3"]), makeStep("s2", ["s1"]), makeStep("s3", ["s2"])];
    const indirectResult = validatePlanDag(indirectCycle);
    expect(indirectResult.valid).toBe(false);
    expect(indirectResult.errors.some((e) => e.includes("dependency cycle detected"))).toBe(true);
  });

  it("sanitizes self-dependencies and dangling unknown dependencies", () => {
    const flawedSteps: PlanStep[] = [makeStep("s1", ["s1", "s99"]), makeStep("s2", ["s1"])];

    const sanitized = sanitizePlanDag(flawedSteps);

    expect(sanitized[0].dependencies).toEqual([]);
    expect(sanitized[1].dependencies).toEqual(["s1"]);
    const postValidation = validatePlanDag(sanitized);
    expect(postValidation.valid).toBe(true);
  });

  it("safely linearizes unresolvable cycles to preserve execution", () => {
    const cyclicalSteps: PlanStep[] = [makeStep("s1", ["s2"]), makeStep("s2", ["s1"]), makeStep("s3", ["s2"])];

    const sanitized = sanitizePlanDag(cyclicalSteps);

    expect(sanitized[0].dependencies).toEqual([]);
    expect(sanitized[1].dependencies).toEqual(["s1"]);
    expect(sanitized[2].dependencies).toEqual(["s2"]);
    const postValidation = validatePlanDag(sanitized);
    expect(postValidation.valid).toBe(true);
  });
});
