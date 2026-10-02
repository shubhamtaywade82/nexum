/**
 * Decision Plane error model.
 *
 * The Decision Plane is bounded — System One is not a generic chat model and
 * the errors it raises are not generic chat errors. They convey enough
 * information for the caller's policy to choose a deterministic fallback
 * without having to parse transport messages.
 *
 * The hierarchy deliberately extends Nexum's existing {@link AgentRuntimeError}
 * rather than inventing a parallel root. Decisions are not "another provider";
 * they are a bounded subsystem that participates in the same runtime error
 * reporting surface used by the Provider/Router plane.
 */

import { AgentRuntimeError } from "../errors.js";

/**
 * Base class for every Decision Plane failure. Callers that want to catch
 * "any decision-plane problem" can match on this; callers that need a
 * specific recovery strategy match on a subclass.
 */
export class DecisionError extends AgentRuntimeError {
  constructor(message: string, code: string = "DECISION_ERROR", cause?: unknown) {
    super(message, code, cause);
  }
}

/**
 * System One was not available to serve this decision. Distinct from a
 * transport failure: the request never reached the model.
 *
 * Common causes:
 *   - the runtime tier is `cloud` (System One is local-only — see
 *     contracts/overlays/systemone.yaml in the upstream SDK)
 *   - System One was disabled in Nexum configuration
 *   - the local Ollama instance is not running
 *   - the installed Ollama version predates 0.35.0
 *
 * Callers should fall back to a deterministic path, never to Provider.chat.
 */
export class DecisionUnavailableError extends DecisionError {
  constructor(message: string, cause?: unknown) {
    super(message, "DECISION_UNAVAILABLE", cause);
  }
}

/**
 * System One was reached but the request did not complete: transport
 * timeout, connection reset, rate limit, etc. The {@link cause} carries
 * the underlying transport error so the caller can still distinguish a
 * timeout from a connection reset if it needs to.
 */
export class DecisionTransportError extends DecisionError {
  constructor(message: string, cause?: unknown) {
    super(message, "DECISION_TRANSPORT_FAILURE", cause);
  }
}

/**
 * System One returned a response, but Nexum could not parse it into the
 * Decision contract: missing required fields, an out-of-band selected id,
 * malformed probabilities, etc. The wire-level raw payload is preserved on
 * the gateway's structured result so the caller can still audit it.
 */
export class DecisionProtocolError extends DecisionError {
  constructor(message: string, cause?: unknown) {
    super(message, "DECISION_PROTOCOL_ERROR", cause);
  }
}

/**
 * The decision was produced and parsed, but the caller's policy rejected
 * it (e.g. no domain met the minimum-probability threshold). This is the
 * "no-action is a valid outcome" failure mode — it is an explicit
 * deterministic decision by the caller's policy, not a System One fault.
 */
export class DecisionPolicyError extends DecisionError {
  constructor(message: string, cause?: unknown) {
    super(message, "DECISION_POLICY_VIOLATION", cause);
  }
}
