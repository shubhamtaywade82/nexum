import { parseTestSummary } from "../../src/ui/test-summary.js";

describe("parseTestSummary", () => {
  it("parses Jest with failure locations", () => {
    const out = [
      "  ● Auth › logs in",
      "    expect(received).toBe(expected)",
      "      at Object.<anonymous> (tests/auth.test.ts:48:12)",
      "Tests:       1 failed, 41 passed, 42 total",
    ].join("\n");
    expect(parseTestSummary(out)).toEqual({
      passed: 41,
      failed: 1,
      failures: [{ file: "tests/auth.test.ts", line: 48, message: "Auth › logs in" }],
    });
  });
  it("parses RSpec", () => {
    const out =
      "42 examples, 2 failures\n\nrspec ./spec/auth_spec.rb:48 # Auth logs in\nrspec ./spec/user_spec.rb:102 # User saves";
    const s = parseTestSummary(out)!;
    expect(s).toMatchObject({ passed: 40, failed: 2 });
    expect(s.failures.map((f) => `${f.file}:${f.line}`)).toEqual(["spec/auth_spec.rb:48", "spec/user_spec.rb:102"]);
  });
  it("parses pytest, Vitest and Mocha summaries", () => {
    expect(
      parseTestSummary("FAILED tests/test_a.py::test_x - AssertionError\n=== 1 failed, 9 passed in 0.5s ==="),
    ).toMatchObject({
      passed: 9,
      failed: 1,
      failures: [{ file: "tests/test_a.py", line: 0 }],
    });
    expect(parseTestSummary(" Tests  2 failed | 10 passed (12)")).toMatchObject({ passed: 10, failed: 2 });
    expect(parseTestSummary("  12 passing (40ms)\n  1 failing")).toMatchObject({ passed: 12, failed: 1 });
  });
  it("returns null for unrecognized output", () => {
    expect(parseTestSummary("compiled successfully")).toBeNull();
  });
});
