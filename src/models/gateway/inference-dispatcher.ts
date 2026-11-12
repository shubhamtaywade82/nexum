/**
 * InferenceDispatcher — the one place a chat request leaves Nexum for a provider.
 *
 * Every model call reaches a provider through a dispatcher. Local calls take the local slot and are recorded. Cloud
 * calls take the cloud slot, then go through admission: a reservation for the worst case is taken before the request
 * is sent, and it is settled, released or held as unknown from what happens. Callers hold a ChatPort (one `chat`
 * method bound to a named lane) rather than a Provider, so a call cannot skip the accounting or the admission.
 *
 * A cloud call without an admission controller is refused. A cloud model without a price is refused before it is
 * sent (see the pricing catalogue).
 */

import { ConcurrencyGate } from "../../core/concurrency/gate.js";
import type { BudgetTracker } from "../../runtime/budget/budget-tracker.js";
import { BudgetManager } from "../../runtime/budget/budget-manager.js";
import {
  PaymentRequiredError,
  ProviderError,
  RateLimitError,
  TransportFailure,
  BudgetRefusedError,
  OutcomeUnknownError,
} from "../errors.js";
import {
  preDispatchNetworkCode,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type Provider,
} from "../adapters/provider.js";
import { DEFAULT_PRICE_CATALOG, type PriceCatalog } from "../profiles/pricing-catalog.js";
import { budgetUsageOf, readUsage } from "../usage-reading.js";
import { microUsdToUsd } from "../../economics/cost.js";
import { priceReading } from "../../economics/usage-cost.js";
import type { CloudAdmission, CloudLease } from "./cloud-admission.js";

/** One chat call, as a caller names it: which provider lane, why, and optionally which model to pin. */
export interface DispatchTarget {
  lane: string;
  /** Why the call happens, e.g. "chat.primary", "memory.summary". Kept with the usage record. */
  purpose: string;
  /** Model to pin for this call. Omitted: the request's model, then the lane provider's configured model. */
  model?: string;
  /** The task the call belongs to. Recorded with a cloud reservation. */
  taskId?: string;
  /** Caller's idempotency key for a paid call. See CloudAdmissionRequest.idempotencyKey. */
  idempotencyKey?: string;
}

/** The narrow port callers depend on instead of a Provider: one chat, already accounted. */
export interface ChatPort {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;
}

export interface InferenceDispatcherOptions {
  lanes: Record<string, Provider | undefined>;
  budget?: BudgetTracker;
  /** Price source for cost recording. Defaults to the shared catalogue. */
  prices?: PriceCatalog;
  /** Admission for cloud calls. Without it every cloud call is refused. */
  admission?: CloudAdmission;
  /** Override the process-wide gates (tests). Leave unset in production so every dispatcher shares one cap. */
  gates?: { local?: ConcurrencyGate; cloud?: ConcurrencyGate };
}

/**
 * One concurrency gate per tier for the whole process. Every dispatcher draws from these, so the cloud cap of 3 holds
 * across the CLI, evolution attempts and benchmark targets running in the same process, not per instance.
 */
const PROCESS_GATES = {
  local: new ConcurrencyGate({ maxConcurrent: 8, label: "model:local" }),
  cloud: new ConcurrencyGate({ maxConcurrent: 3, label: "model:cloud" }),
};

let defaultCloudAdmission: CloudAdmission | undefined;

/**
 * Installs the admission every dispatcher uses unless it was given its own. A composition root (the agent, the
 * benchmark and evolution CLIs) calls this once at startup. Until it is called, every cloud call is refused.
 */
export function installDefaultCloudAdmission(admission: CloudAdmission | undefined): void {
  defaultCloudAdmission = admission;
}

export class InferenceDispatcher {
  readonly localGate: ConcurrencyGate;
  readonly cloudGate: ConcurrencyGate;
  private readonly lanes: Record<string, Provider | undefined>;
  private readonly budget?: BudgetTracker;
  private readonly prices: PriceCatalog;
  private readonly admission?: CloudAdmission;

  constructor(opts: InferenceDispatcherOptions) {
    this.lanes = opts.lanes;
    this.budget = opts.budget;
    this.prices = opts.prices ?? DEFAULT_PRICE_CATALOG;
    this.admission = opts.admission;
    this.localGate = opts.gates?.local ?? PROCESS_GATES.local;
    this.cloudGate = opts.gates?.cloud ?? PROCESS_GATES.cloud;
  }

  /** A dispatcher with one lane, for code that owns a single provider. */
  static single(
    lane: string,
    provider: Provider,
    opts: Omit<InferenceDispatcherOptions, "lanes"> = {},
  ): InferenceDispatcher {
    return new InferenceDispatcher({ ...opts, lanes: { [lane]: provider } });
  }

  /** Whether a lane is configured. */
  has(lane: string): boolean {
    return this.lanes[lane] !== undefined;
  }

  async dispatch(target: DispatchTarget, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const provider = this.lanes[target.lane];
    if (!provider) throw new ProviderError(`no provider lane "${target.lane}" configured for ${target.purpose}`);
    if (provider.currentTier === "cloud") return this.dispatchCloud(target, provider, messages, opts);

    const model = target.model ?? opts.model ?? provider.currentModel;
    const callOpts: ChatOptions = target.model !== undefined ? { ...opts, model: target.model } : opts;
    const response = await this.localGate.run(() => provider.chat(messages, callOpts));
    response.routedTier = "local";
    response.routedModel = model;
    recordModelCall(this.budget, this.prices, response);
    return response;
  }

  port(target: DispatchTarget): ChatPort {
    return { chat: (messages, opts) => this.dispatch(target, messages, opts) };
  }

  private async dispatchCloud(
    target: DispatchTarget,
    provider: Provider,
    messages: ChatMessage[],
    opts: ChatOptions,
  ): Promise<ChatResponse> {
    const admission = this.admission ?? defaultCloudAdmission;
    if (!admission) {
      throw new BudgetRefusedError(
        `cloud call for ${target.purpose} has no admission controller; it is refused, not sent`,
        "NO_ADMISSION",
      );
    }
    const model = target.model ?? opts.model ?? provider.currentModel;
    return this.cloudGate.run(async () => {
      const decision = admission.admit({
        purpose: target.purpose,
        taskId: target.taskId ?? "unassigned",
        model,
        messages,
        tools: opts.tools,
        maxOutputTokens: numPredictOf(opts),
        ...(target.idempotencyKey !== undefined ? { idempotencyKey: target.idempotencyKey } : {}),
      });
      if (decision.kind === "REFUSED") throw new BudgetRefusedError(decision.reason, decision.code);

      const lease = decision.lease;
      const callOpts: ChatOptions = {
        ...opts,
        model,
        // The reservation is sized from this cap, so the provider must be held to it.
        options: { ...(opts.options ?? {}), num_predict: lease.maxOutputTokens },
      };
      let response: ChatResponse;
      try {
        response = await provider.chat(messages, callOpts);
      } catch (err) {
        settleFailure(admission, lease, err);
        throw err;
      }
      admission.settle(lease, response);
      response.routedTier = "cloud";
      response.routedModel = model;
      recordModelCall(this.budget, this.prices, response);
      return response;
    });
  }
}

function numPredictOf(opts: ChatOptions): number | undefined {
  const value = opts.options?.num_predict;
  return typeof value === "number" ? value : undefined;
}

/**
 * Decides what a failed cloud call means for its reservation. Only a failure that proves nothing ran releases the hold:
 * a 429 or 402 response, or a connection that never opened. Anything else (a timeout, a reset, a 5xx, an unclassified
 * error) may have run the request, so its hold stays until reconciliation.
 */
function settleFailure(admission: CloudAdmission, lease: CloudLease, err: unknown): void {
  if (err instanceof OutcomeUnknownError) {
    admission.markUnknown(lease, err.message);
    return;
  }
  if (err instanceof RateLimitError) {
    admission.releaseUnexecuted(lease, { kind: "HTTP_STATUS", status: 429 });
    return;
  }
  if (err instanceof PaymentRequiredError) {
    admission.releaseUnexecuted(lease, { kind: "HTTP_STATUS", status: 402 });
    return;
  }
  if (err instanceof TransportFailure) {
    // Only a pre-dispatch network code proves the socket never opened. The error's own `code` ("TRANSPORT_FAILURE")
    // is not a network code, so it is skipped by the classifier.
    const code = preDispatchNetworkCode(err);
    if (code !== undefined) {
      admission.releaseUnexecuted(lease, { kind: "PRE_DISPATCH_TRANSPORT", code });
      return;
    }
  }
  admission.markUnknown(lease, `cloud call failed after dispatch: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Records one provider response on a budget. Missing counters are unmetered, never zero: a cost needs both counts
 * from the provider, and an absent count is not a claim that the call was free (see usage-reading.ts).
 */
export function recordModelCall(budget: BudgetTracker | undefined, prices: PriceCatalog, response: ChatResponse): void {
  if (!budget) return;
  const reading = readUsage(response);
  // Cost comes from the catalogue version in force now. A reading without the counts, or a model with no price
  // (every local model), has no cost: it is left undefined, never zero.
  let cost: number | undefined;
  if (response.routedTier === "cloud" && response.routedModel !== undefined) {
    const version = prices.priceAt(response.routedModel, new Date());
    const priced = version ? priceReading(reading, version) : undefined;
    cost = priced !== undefined ? microUsdToUsd(priced.costMicroUsd) : undefined;
  }
  const usage = { ...budgetUsageOf(reading), costUsd: cost };
  // cloud-aware consumption when the run carries a BudgetManager (review item 14)
  if (budget instanceof BudgetManager) {
    budget.consumeModelCall({ ...usage, cloud: response.routedTier === "cloud" });
  } else {
    budget.consumeModelCall(usage);
  }
}
