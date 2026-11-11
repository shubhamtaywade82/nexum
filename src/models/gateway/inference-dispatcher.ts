/**
 * InferenceDispatcher — the one place a chat request leaves Nexum for a provider.
 *
 * Every model call that can reach the cloud goes through a dispatcher. It picks the lane's provider, takes that
 * tier's concurrency slot, sends the request, and records what the provider reported. Callers hold a ChatPort (one
 * `chat` method bound to a named lane) rather than a Provider, so a call cannot skip the accounting by reaching
 * the provider directly.
 *
 * Lanes name the provider a call uses: the conversation's primary provider, the router's local and cloud pools, the
 * quick-model provider. A lane keeps its own key pool and settings; the dispatcher does not reconfigure them.
 * Concurrency gates are per tier and shared by every lane, so the cloud cap of 3 holds across the process.
 *
 * Admission (refusing a call the budget cannot cover) is added on top of this point, not in each caller.
 */

import { ConcurrencyGate } from "../../core/concurrency/gate.js";
import type { BudgetTracker } from "../../runtime/budget/budget-tracker.js";
import { BudgetManager } from "../../runtime/budget/budget-manager.js";
import {
  ProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type Provider,
} from "../adapters/provider.js";
import type { ModelCapabilityRegistry } from "../profiles/model-capability-registry.js";
import { budgetUsageOf, readUsage } from "../usage-reading.js";

/** One chat call, as a caller names it: which provider lane, why, and optionally which model to pin. */
export interface DispatchTarget {
  lane: string;
  /** Why the call happens, e.g. "chat.primary", "memory.summary". Kept with the usage record. */
  purpose: string;
  /** Model to pin for this call. Omitted: the lane provider's configured model. */
  model?: string;
}

/** The narrow port callers depend on instead of a Provider: one chat, already accounted. */
export interface ChatPort {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;
}

export interface InferenceDispatcherOptions {
  lanes: Record<string, Provider | undefined>;
  budget?: BudgetTracker;
  registry?: ModelCapabilityRegistry;
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

export class InferenceDispatcher {
  readonly localGate: ConcurrencyGate;
  readonly cloudGate: ConcurrencyGate;
  private readonly lanes: Record<string, Provider | undefined>;
  private readonly budget?: BudgetTracker;
  private readonly registry?: ModelCapabilityRegistry;

  constructor(opts: InferenceDispatcherOptions) {
    this.lanes = opts.lanes;
    this.budget = opts.budget;
    this.registry = opts.registry;
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
    const tier = provider.currentTier;
    const gate = tier === "cloud" ? this.cloudGate : this.localGate;
    const callOpts: ChatOptions = target.model !== undefined ? { ...opts, model: target.model } : opts;
    const response = await gate.run(() => provider.chat(messages, callOpts));
    response.routedTier = tier;
    response.routedModel = target.model ?? provider.currentModel;
    recordModelCall(this.budget, this.registry, response);
    return response;
  }

  port(target: DispatchTarget): ChatPort {
    return { chat: (messages, opts) => this.dispatch(target, messages, opts) };
  }
}

/**
 * Records one provider response on a budget. Missing counters are unmetered, never zero: a cost needs both counts
 * from the provider, and an absent count is not a claim that the call was free (see usage-reading.ts).
 */
export function recordModelCall(
  budget: BudgetTracker | undefined,
  registry: ModelCapabilityRegistry | undefined,
  response: ChatResponse,
): void {
  if (!budget) return;
  const reading = readUsage(response);
  const cost =
    reading.source === "PROVIDER" && response.routedModel !== undefined && registry
      ? registry.estimateCostUsd(response.routedModel, reading.promptTokens ?? 0, reading.completionTokens ?? 0)
      : undefined;
  const usage = { ...budgetUsageOf(reading), costUsd: cost };
  // cloud-aware consumption when the run carries a BudgetManager (review item 14)
  if (budget instanceof BudgetManager) {
    budget.consumeModelCall({ ...usage, cloud: response.routedTier === "cloud" });
  } else {
    budget.consumeModelCall(usage);
  }
}
