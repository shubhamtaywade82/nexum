import { evaluateEscalation } from "../../src/policy/escalation.js";

describe("Policy - Escalation", () => {
  it("escalates when multiFile or schemaChange flags are set", () => {
    const res = evaluateEscalation({ multiFile: true, schemaChange: true });
    expect(res.escalate).toBe(true);
    expect(res.reasons).toContain("multi_file");
    expect(res.reasons).toContain("schema_change");
  });

  it("escalates on unresolved task failure", () => {
    const res = evaluateEscalation({ localFailed: true }, { testsFailed: true });
    expect(res.escalate).toBe(true);
    expect(res.reasons).toContain("local_failed_unresolved");
  });

  it("does not escalate when no escalation flags or failures are present", () => {
    const res = evaluateEscalation({});
    expect(res.escalate).toBe(false);
  });
});
