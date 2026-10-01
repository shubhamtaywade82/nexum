/**
 * Nexum Decision Plane — public entrypoint.
 *
 * Exports the domain contract, the gateway interface, the policy, and the
 * errors. The System One adapter ({@link SystemOneDecisionGateway}) is
 * exported from `./system-one-gateway.js` and re-exported here so callers
 * that want it can import from this single module.
 *
 * The fake gateway is exported too — tests and callers using
 * `enableDecision=false` reach for it directly.
 */

export type {
  DecisionMode,
  DecisionQuestion,
  DecisionMetadata,
  DecisionRequest,
  DecisionAnswer,
  DecisionResult,
} from "./types.js";
export {
  validateDecisionRequest,
  validateDecisionQuestion,
  estimateRequestBytes,
  SYSTEM_ONE_MAX_REQUEST_BYTES,
} from "./types.js";

export type { DecisionGateway } from "./decision-gateway.js";

export { defaultDecisionPolicy, applyDecisionPolicy } from "./decision-policy.js";
export type { DecisionPolicy } from "./decision-policy.js";

export {
  DecisionError,
  DecisionUnavailableError,
  DecisionTransportError,
  DecisionProtocolError,
  DecisionPolicyError,
} from "./errors.js";

export { FakeDecisionGateway } from "./fake-gateway.js";
export type { FakeDecisionAnswer, FakeDecisionGatewayOptions } from "./fake-gateway.js";

export { SystemOneDecisionGateway, SYSTEM_ONE_ENGINE } from "./system-one-gateway.js";
export type { SystemOneClient, SystemOneEnvironment, SystemOneGatewayOptions } from "./system-one-gateway.js";
