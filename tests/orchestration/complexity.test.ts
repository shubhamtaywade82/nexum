import { assessComplexity } from "../../src/orchestration/complexity.js";

describe("assessComplexity", () => {
  it("flags a numbered multi-item request", () => {
    const r = assessComplexity("Do this:\n1. add the model\n2. write a migration\n3. add specs");
    expect(r.multiStep).toBe(true);
    expect(r.signals).toContain("3-item list");
  });

  it("flags sequenced work with several distinct actions", () => {
    const r = assessComplexity("Refactor the auth module, then update the tests and finally document the change");
    expect(r.multiStep).toBe(true);
  });

  it("does not flag a single focused request", () => {
    expect(assessComplexity("fix the failing test in tests/tools/shell.test.ts").multiStep).toBe(false);
    expect(assessComplexity("rename the variable foo to bar").multiStep).toBe(false);
  });

  it("does not flag questions, even ones that mention several actions", () => {
    expect(assessComplexity("How do I add, update and remove a route, then test it?").multiStep).toBe(false);
    expect(assessComplexity("where is the checkpoint store defined?").multiStep).toBe(false);
  });

  it("ignores slash commands and empty input", () => {
    expect(assessComplexity("/plan add, then test, then deploy").multiStep).toBe(false);
    expect(assessComplexity("   ").multiStep).toBe(false);
  });
});
