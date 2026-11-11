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
import { budgetUsageOf, readUsage } from "../usage-reading.js";
import { Router } from "../router/router.js";
import type { ModelCatalog } from "../catalog.js";
import { ConcurrencyGate } from "../../core/concurrency/gate.js";
import type { Capability } from "../catalog.js";
import { BudgetTracker } from "../../runtime/budget/budget-tracker.js";
import { BudgetManager } from "../../runtime/budget/budget-manager.js";
import { ModelCapabilityRegistry } from "../profiles/model-capability-registry.js";
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
  /** Optional budget tracker to record token/cost usage per call. */
  budget?: BudgetTracker;
  gates?: { local?: ConcurrencyGate; cloud?: ConcurrencyGate };
}

export class DefaultModelGateway implements ModelGateway {
  readonly registry: ModelCapabilityRegistry;
  private readonly router: Router;
  private readonly catalog: ModelCatalog;
  private readonly selectionRouter: ModelRouter;
  private readonly budget?: BudgetTracker;
  private readonly localGate: ConcurrencyGate;
  private readonly cloudGate: ConcurrencyGate;

  constructor(opts: DefaultModelGatewayOptions) {
    this.router = opts.router;
    this.catalog = opts.catalog;
    this.registry = opts.registry ?? new ModelCapabilityRegistry();
    this.selectionRouter =
      opts.selectionRouter ?? new ScoredModelRouter({ registry: this.registry, availability: opts.availability });
    this.budget = opts.budget;
    this.localGate = opts.gates?.local ?? new ConcurrencyGate({ maxConcurrent: 8, label: "model:local" });
    this.cloudGate = opts.gates?.cloud ?? new ConcurrencyGate({ maxConcurrent: 3, label: "model:cloud" });
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

  async routeToModel(
    model: string,
    tier: "local" | "cloud",
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResponse> {
    const gate = tier === "cloud" ? this.cloudGate : this.localGate;
    const response = await gate.run(() => this.router.route(capabilityForFallback(), messages, { ...opts, model }));
    this.record(response);
    return response;
  }

  profiles(): ModelCapabilityRegistry {
    return this.registry;
  }

  private record(response: ChatResponse): void {
    if (!this.budget) return;
    const reading = readUsage(response);
    // A cost needs both counts from the provider. A MISSING reading is left unpriced, never priced at zero tokens.
    const cost =
      reading.source === "PROVIDER" && response.routedModel !== undefined
        ? this.registry.estimateCostUsd(response.routedModel, reading.promptTokens ?? 0, reading.completionTokens ?? 0)
        : undefined;
    const usage = { ...budgetUsageOf(reading), costUsd: cost };
    // cloud-aware consumption when the run carries a BudgetManager
    // (review item 14: cloud calls + cloud spend are their own dimensions)
    if (this.budget instanceof BudgetManager) {
      this.budget.consumeModelCall({ ...usage, cloud: response.routedTier === "cloud" });
    } else {
      this.budget.consumeModelCall(usage);
    }
  }
}

function capabilityForFallback() {
  // routeToModel exists to pin an explicit model; the capability tag only
  // shapes candidate ordering, which the explicit model overrides.
  return "tools" as Capability;
}
