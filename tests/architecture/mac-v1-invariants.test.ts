/**
 * MAC v1 invariant skeleton — I1..I7 as test.todo placeholders (ADR-0001).
 *
 * Each ADR invariant is registered here in P0 with the phase that turns it
 * into a real, enforced test. Mapping to TEST-STRATEGY.md INV-1..INV-14:
 *
 *   I1 no unbounded autonomous loops            -> INV-1..INV-3  (real in P5)
 *   I2 no self-authorized execution            -> INV-4..INV-6  (real in P5)
 *   I3 no unverified predictions                -> INV-7..INV-9  (real in P4)
 *   I4 no unrestricted shared tools             -> INV-10..INV-12 (real in P1/P3)
 *   I5 no unnecessary multi-agent execution     -> INV-13..INV-14 (real in P5)
 *   I6 no agent declares its own success        -> (real in P6)
 *   I7 terminal mission states are immutable    -> (real in P5)
 *
 * This file is a registry, not a stub: the todo titles are the acceptance
 * wording the enforcing phase must implement verbatim, so a forgotten
 * invariant stays visible in every test run until it is real.
 */
import { describe, it } from "@jest/globals";

describe("MAC v1 invariants (ADR-0001 I1–I7)", () => {
  it.todo(
    "I1 / INV-1: every mission carries a hard wall-clock budget and the coordinator aborts on expiry (enforced P5)",
  );
  it.todo(
    "I1 / INV-2: model-call, tool-call and token budgets are checked before each dispatch, not after (enforced P5)",
  );
  it.todo("I1 / INV-3: child-count and replan limits cannot be raised by a model-generated decision (enforced P5)");

  it.todo("I2 / INV-4: a model-generated decision is re-validated by PolicyEngine before execution (enforced P5)");
  it.todo(
    "I2 / INV-5: approval-class actions always route through ApprovalManager regardless of autonomy profile (enforced P5)",
  );
  it.todo(
    "I2 / INV-6: every tool call passes the full pipeline registry → schema → capability → policy → budget → idempotency → executor (enforced P5)",
  );

  it.todo("I3 / INV-7: Predictor output with non-abstaining basis has a non-empty evidenceRefs list (enforced P4)");
  it.todo("I3 / INV-8: the basis enum is closed; unknown basis values fail contract validation (enforced P4)");
  it.todo("I3 / INV-9: insufficient evidence produces abstention, never a confidence score (enforced P4)");

  it.todo(
    "I4 / INV-10: role descriptors declare allowedPackIds and the runtime enforces them at dispatch (enforced P1)",
  );
  it.todo("I4 / INV-11: DelegationPolicy.inheritPolicy narrows capabilities, never widens them (enforced P3)");
  it.todo("I4 / INV-12: the capability matrix is enforced by the runtime, not by prompt text (enforced P3)");

  it.todo("I5 / INV-13: assessComplexity gates trivial requests to single-agent execution (enforced P5)");
  it.todo("I5 / INV-14: the mission policy gate cannot be bypassed by re-issuing the same request (enforced P5)");

  it.todo(
    "I6: mission completion requires deterministic verification evidence (gateTaskCompletion / Kit journal), never an agent's claim (enforced P6)",
  );
  it.todo(
    "I7: terminal mission states are immutable; late cancellation cannot rewrite a completed mission (enforced P5)",
  );
});
