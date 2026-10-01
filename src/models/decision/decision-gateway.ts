/**
 * {@link DecisionGateway} — the Nexum-owned seam between Nexum callers and
 * the bounded decision engine (System One today, possibly other bounded
 * classifiers/scorers tomorrow).
 *
 * The interface intentionally exposes only Nexum domain types
 * ({@link DecisionRequest}/{@link DecisionResult}). No SDK type, no
 * `Record<string, unknown>`, no transport detail leaks through it. The
 * concrete adapter for System One lives in {@link SystemOneDecisionGateway}
 * (wave 2); tests and non-System-One callers use {@link FakeDecisionGateway}.
 *
 * Architecture (see docs for the full diagram):
 *
 *   Generation Plane        Decision Plane
 *   Provider/Router         DecisionGateway
 *     chat / tools            decide(req)
 *                              │
 *                       SystemOneDecisionGateway
 *                              │
 *                       SystemOneClient (SDK seam)
 *
 * The gateway MUST NOT:
 *   - fall back from a decision call to `Provider.chat()`
 *   - mutate the provider's model/tier/host state
 *   - hide a cloud-tier decision by silently routing to cloud chat
 *   - return prose instead of structured evidence
 */

import type { DecisionRequest, DecisionResult } from "./types.js";

export interface DecisionGateway {
  /**
   * Resolve a bounded decision request into structured model evidence.
   *
   * Throws a subclass of {@link DecisionError} on any failure; never
   * resolves to a "fallback" result silently. The caller's policy is
   * responsible for choosing a deterministic fallback when the gateway
   * throws — the gateway does not own the fallback decision.
   */
  decide(request: DecisionRequest): Promise<DecisionResult>;

  /**
   * Human-readable label of which decision engine this gateway fronts
   * (e.g. `"system-one"`, `"fake"`). Used for telemetry and diagnostics.
   */
  readonly engine: string;
}
