import { AllowAllPolicyEngine } from "../../src/core/policy/policy-engine.js";

/**
 * Explicit, test-only authorization for fixtures whose subject is not policy. Production code must
 * never use this: the acknowledgement and the reason are deliberately required at every call site.
 */
export function testOnlyAllowAll(reason = "test fixture: authorization is not under test"): AllowAllPolicyEngine {
  return new AllowAllPolicyEngine({ acknowledgeNoPolicy: true, reason });
}
