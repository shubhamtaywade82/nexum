/**
 * Models plane — public surface (review item 39 + items 17/18).
 *
 * Scored model routing, selection, capability profiles, and provider
 * transports (Ollama local/cloud). Selection is separated from transport:
 * ModelRouter → ModelSelection → ProviderAdapter.
 */

// Provider transport (Ollama local + cloud)
export {
  Provider,
  type ProviderOptions,
  type ChatMessage,
  type ChatResponse,
  type ChatOptions,
  type OllamaToolSchema,
  type Tier,
} from "./adapters/provider.js";
export {
  RateLimitError,
  ProviderError,
  TimeoutError,
  BudgetExhaustedError,
  AgentRuntimeError,
  TransportFailure,
  InferenceQualityError,
  ToolFailure,
  ConcurrencyDeniedError,
} from "./errors.js";

// Discovery + capability catalog
export { ModelCatalog, inferCapabilities, type Capability, type ModelInfo } from "./catalog.js";

// Routing (capability → model with failover)
export { Router, type RouterOptions } from "./router/router.js";
export { HeuristicRouter } from "./router/heuristic-router.js";
export { ModelAvailabilityChecker } from "./router/availability.js";
export { KeyManager } from "./router/key-manager.js";

// Profiles + scored registry (review item 17)
export { ModelCapabilityRegistry, type ProfileQuery } from "./profiles/model-capability-registry.js";
export {
  type ModelProfile,
  type ModelCapabilities,
  type ModelConstraints,
  type ModelCost,
  UNKNOWN_SCORE,
  profileFromLegacy,
  defaultConstraints,
} from "./profiles/model-profile.js";
export {
  budgetForProfile,
  sizeClassFor,
  SIZE_CLASS_DEFAULTS,
  CHARS_PER_TOKEN,
  type ModelBudget,
  type ModelBudgetOverrides,
  type ModelSizeClass,
  type ReasoningBudget,
} from "./profiles/context-budget.js";

// Gateway (review item 18)
export { DefaultModelGateway, type ModelGateway, type DefaultModelGatewayOptions } from "./gateway/model-gateway.js";

// Hybrid-stack helpers
export { LocalWorker } from "./local-worker.js";
export { Verifier } from "./verification/verifier.js";
export { SelfConsistency } from "./verification/self-consistency.js";
