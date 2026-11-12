/**
 * ModelGateway — the runtime's single port to model inference.
 *
 * Wraps the Provider/Router/Catalog stack behind one facade so
 * strategies and the runtime never touch providers directly, and every
 * model call flows through:
 *
 *   capability → ScoredModelRouter (selection, review item 17/18)
 *      → registry candidates → Router (failover execution)
 *      → per-tier ConcurrencyGate → ProviderAdapter (transport)
 *
 * Selection is separated from transport (review item 18): `select()`
 * returns ranked ModelSelections without executing anything; `route()`
 * executes through the failover router under tier gates.
 */

import type { ChatMessage, ChatOptions, ChatResponse } from "../adapters/provider.js";
import { Router } from "../router/router.js";
import type { ModelCatalog } from "../catalog.js";
import type { Capability } from "../catalog.js";
import { BudgetTracker } from "../../runtime/budget/budget-tracker.js";
import { ModelCapabilityRegistry } from "../profiles/model-capability-registry.js";
import { DEFAULT_PRICE_CATALOG, type PriceCatalog } from "../profiles/pricing-catalog.js";
import { recordModelCall, type InferenceDispatcher } from "./inference-dispatcher.js";
import { ScoredModelRouter } from "../router/scored-router.js";
import type { ModelRouter, ModelSelection, RouteRequest } from "../router/model-selection.js";

export interface ModelGateway {
  /** Route one chat request by capability. Never mutates provider state. */
  route(capability: Capability, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;
  /** Route bypassing capability selection (explicit model). */
  routeToModel(
    model: string,
    tier: "local" | "cloud",
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResponse>;
  /** The capability registry the gateway routes from. */
  profiles(): ModelCapabilityRegistry;
  /** Scored selection without execution (review item 18). */
  select(request: RouteRequest): ModelSelection[];
}

export interface DefaultModelGatewayOptions {
  router: Router;
  catalog: ModelCatalog;
  registry?: ModelCapabilityRegistry;
  /** Scored selection router (review item 17); default built from the registry. */
  selectionRouter?: ModelRouter;
  /** Availability probe feeding the scored router (optional). */
  availability?: (model: string) => number | undefined;
  /**
   * Optional budget tracker to record token/cost usage per call. Give the same tracker to the dispatcher: a call
   * routed through the gateway records once, on whichever path carried it.
   */
  budget?: BudgetTracker;
  /** Price source for cloud calls and cost estimates. Defaults to the shared catalogue. */
  prices?: PriceCatalog;
  /**
   * Dispatcher for explicit-model calls (`routeToModel`). Its lanes must include `catalog.local` and/or
   * `catalog.cloud`, the router's own providers, so the model pin reaches the same providers the router uses.
   */
  dispatcher?: InferenceDispatcher;
}

export class DefaultModelGateway implements ModelGateway {
  readonly registry: ModelCapabilityRegistry;
  private readonly router: Router;
  private readonly catalog: ModelCatalog;
  private readonly selectionRouter: ModelRouter;
  private readonly budget?: BudgetTracker;
  private readonly dispatcher?: InferenceDispatcher;
  private readonly prices: PriceCatalog;

  constructor(opts: DefaultModelGatewayOptions) {
    this.router = opts.router;
    this.catalog = opts.catalog;
    this.registry = opts.registry ?? new ModelCapabilityRegistry();
    this.prices = opts.prices ?? DEFAULT_PRICE_CATALOG;
    this.selectionRouter =
      opts.selectionRouter ??
      new ScoredModelRouter({ registry: this.registry, availability: opts.availability, prices: this.prices });
    this.budget = opts.budget;
    this.dispatcher = opts.dispatcher;
  }

  /** Scored selection over the registry — no execution (review item 18). */
  select(request: RouteRequest): ModelSelection[] {
    return this.selectionRouter.select(request);
  }

  async route(capability: Capability, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    const response = await this.router.route(capability, messages, opts);
    this.record(response);
    return response;
  }

  /**
   * Pins one model on one tier. Goes through the dispatcher directly, not the router: the router chooses its own
   * candidate and would overwrite the requested model name. The dispatcher records the call itself.
   */
  async routeToModel(
    model: string,
    tier: "local" | "cloud",
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResponse> {
    if (!this.dispatcher) {
      throw new Error(`routeToModel("${model}"): the gateway has no dispatcher, so an explicit model cannot be pinned`);
    }
    return this.dispatcher.dispatch({ lane: `catalog.${tier}`, purpose: "routeToModel", model }, messages, opts);
  }

  profiles(): ModelCapabilityRegistry {
    return this.registry;
  }

  /** Router-path calls record here; the dispatcher's explicit-model calls record in the dispatcher. */
  private record(response: ChatResponse): void {
    recordModelCall(this.budget, this.prices, response);
  }
}
