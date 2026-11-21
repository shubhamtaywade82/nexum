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
import { BudgetManager, CloudSpendBudgetError } from "../../runtime/budget/budget-manager.js";
import {
  ProviderError,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type Provider,
} from "../adapters/provider.js";
import type { ModelCapabilityRegistry } from "../profiles/model-capability-registry.js";
import { budgetUsageOf, readUsage } from "../usage-reading.js";
import { ModelUsageLedger } from "../observability/usage-ledger.js";
import { MonthlySpendGuard } from "../observability/monthly-spend-guard.js";
import { estimateCallCostUsd, loadPriceTable, priceFor, type ModelPrice } from "../profiles/cloud-price-catalog.js";

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
  /** Per-call usage ledger (tokens/cost/latency/status per call, JSONL-persisted). */
  ledger?: ModelUsageLedger;
  /**
   * Price table for cost estimation on calls whose model has no profile cost.
   * Defaults to loadPriceTable() — the curated cloud catalog plus NEXUM_PRICE_FILE overrides.
   */
  prices?: Map<string, ModelPrice>;
  /**
   * Refuse a cloud call when the budget's remaining spend cannot cover a worst-case estimate of it
   * (admission control). Set to false to keep the post-hoc-only behaviour (budget throws after the
   * call returns). Default true — a spend ceiling that only fires after the money is spent is not a ceiling.
   */
  admitWithinBudget?: boolean;
  /**
   * Cross-session monthly spend guard (MonthlySpendGuard). When set and the
   * ledger's month-to-date cloud spend has crossed budget - reserve, every
   * automated cloud call is refused at admission. Composes with (not replaces)
   * the per-run budget check above.
   */
  spendGuard?: MonthlySpendGuard;
}

/**
 * One concurrency gate per tier for the whole process. Every dispatcher draws from these, so the cloud cap holds
 * across the CLI, evolution attempts and benchmark targets running in the same process, not per instance.
 * NEXUM_CLOUD_CONCURRENCY / cloudConcurrency in config resizes the cloud cap at process start (integer >= 1;
 * default 3). Anything unparseable keeps the default — a garbled env var must not disable the cap.
 */
function initialCloudConcurrency(): number {
  const raw = Number(process.env.NEXUM_CLOUD_CONCURRENCY);
  return Number.isInteger(raw) && raw >= 1 ? raw : 3;
}
const PROCESS_GATES = {
  local: new ConcurrencyGate({ maxConcurrent: 8, label: "model:local" }),
  cloud: new ConcurrencyGate({ maxConcurrent: initialCloudConcurrency(), label: "model:cloud" }),
};

export class InferenceDispatcher {
  readonly localGate: ConcurrencyGate;
  readonly cloudGate: ConcurrencyGate;
  private readonly lanes: Record<string, Provider | undefined>;
  private readonly budget?: BudgetTracker;
  private readonly registry?: ModelCapabilityRegistry;
  private readonly ledger?: ModelUsageLedger;
  private readonly prices: Map<string, ModelPrice>;
  private readonly admitWithinBudget: boolean;
  private readonly spendGuard?: MonthlySpendGuard;

  constructor(opts: InferenceDispatcherOptions) {
    this.lanes = opts.lanes;
    this.budget = opts.budget;
    this.registry = opts.registry;
    this.ledger = opts.ledger;
    this.prices = opts.prices ?? loadPriceTable();
    this.admitWithinBudget = opts.admitWithinBudget ?? true;
    this.spendGuard = opts.spendGuard;
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
    const model = target.model ?? provider.currentModel;

    // Admission (cloud only): refuse the call BEFORE it can bill when the
    // budget's remaining spend ceiling cannot cover a worst-case estimate.
    // Local calls bill nothing and skip this check.
    if (this.admitWithinBudget && tier === "cloud" && this.budget) {
      assertWithinSpendBudget(this.budget, this.prices, model, messages, opts);
    }
    // Monthly guardrail (cloud only): the cross-session spend floor from the
    // persisted ledger. Independent of the per-run budget — it blocks even
    // when this run has spent nothing, because this month's earlier sessions
    // already crossed budget - reserve.
    if (tier === "cloud" && this.spendGuard) {
      const snap = this.spendGuard.snapshot();
      if (snap.blocked) {
        throw new ProviderError(
          `cloud call to ${model} refused by monthly spend guard: $${snap.spentUsd.toFixed(2)} spent in ${snap.month} >= $${snap.blockAtUsd.toFixed(2)} block threshold. Raise NEXUM_MONTHLY_BUDGET_USD or lower NEXUM_RESERVE_USD to continue.`,
        );
      }
    }

    const startedAt = Date.now();
    let retries = 0;
    // One call, one ledger line: set once the success line (with the real
    // provider counts) is written, so a post-hoc budget throw from
    // recordModelCall does not add a second, unknown-counts failure line.
    let ledgered = false;
    try {
      const response = await gate.run(() => {
        retries += 1; // counts attempts; first attempt means retryCount 0
        return provider.chat(messages, callOpts);
      });
      response.routedTier = tier;
      response.routedModel = model;
      // Ledger BEFORE the budget consumption: recordModelCall can throw
      // (post-hoc ceiling), and the over-budget call's real token counts must
      // land in the ledger, not be lost as an unknown-tokens failure line.
      this.recordLedger(target, tier, model, response, Date.now() - startedAt, retries - 1, "success");
      ledgered = true;
      recordModelCall(this.budget, this.registry, response, this.prices);
      return response;
    } catch (err) {
      // An OutcomeUnknownError (or TypeError) on the cloud tier means the
      // request may have run and billed — record it as unknown_outcome, not error.
      if (!ledgered) {
        const unknownOutcome = tier === "cloud" && isUnknownOutcome(err);
        this.recordLedger(
          target,
          tier,
          model,
          undefined,
          Date.now() - startedAt,
          retries - 1,
          unknownOutcome ? "unknown_outcome" : "error",
          err,
        );
      }
      throw err;
    }
  }

  /** One ledger line per call — success, failure, or unknown outcome. Never throws. */
  private recordLedger(
    target: DispatchTarget,
    tier: "local" | "cloud",
    model: string,
    response: ChatResponse | undefined,
    latencyMs: number,
    retryCount: number,
    status: "success" | "error" | "unknown_outcome",
    err?: unknown,
  ): void {
    if (!this.ledger) return;
    try {
      const reading = response ? readUsage(response) : { source: "MISSING" as const };
      const cost =
        reading.source === "PROVIDER"
          ? (this.costFor(model, reading.promptTokens ?? 0, reading.completionTokens ?? 0) ?? undefined)
          : undefined;
      this.ledger.record({
        runId: this.budget?.runId ?? "untracked",
        purpose: target.purpose,
        lane: target.lane,
        tier,
        model,
        promptTokens: reading.promptTokens,
        cachedPromptTokens: reading.cachedPromptTokens,
        completionTokens: reading.completionTokens,
        tokensUnknown: reading.source === "MISSING",
        costUsd: cost,
        costUnknown: cost === undefined,
        latencyMs,
        retryCount,
        status,
        ...(err !== undefined ? { error: err instanceof Error ? err.constructor.name : String(err) } : {}),
      });
    } catch {
      // ledger failure must never fail the call it records
    }
  }

  /** Cost estimate: profile cost first (registry), then the price table. */
  private costFor(model: string, promptTokens: number, completionTokens: number): number | undefined {
    const fromRegistry = this.registry?.estimateCostUsd(model, promptTokens, completionTokens);
    if (fromRegistry !== undefined) return fromRegistry;
    return estimateCallCostUsd(this.prices, model, promptTokens, completionTokens);
  }

  port(target: DispatchTarget): ChatPort {
    return { chat: (messages, opts) => this.dispatch(target, messages, opts) };
  }
}

/** Errors whose cloud request may have run (and billed) despite failing. */
function isUnknownOutcome(err: unknown): boolean {
  const name = err instanceof Error ? err.constructor.name : "";
  return name === "OutcomeUnknownError" || err instanceof TypeError;
}

/**
 * Pre-call admission on the cloud tier. Estimates the worst-case cost of this
 * request (every message's content + the whole tool schema block at the
 * model's output rate) and refuses the call when that estimate alone would
 * cross the budget's remaining spend. Unpriced models and unmetered budgets
 * pass: admission cannot invent a number the price table does not have —
 * but when it CAN see the number, it must not let the call through.
 */
function assertWithinSpendBudget(
  budget: BudgetTracker,
  prices: Map<string, ModelPrice>,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
): void {
  const price = priceFor(prices, model);
  if (!price) return; // unknown price: admission is not enforceable for this model
  const limits = budget.limits();
  const maxCost = limits.maxCostUsd;
  const maxCloudSpend = budget instanceof BudgetManager ? budget.budget.maxCloudSpendUsd : undefined;
  if (maxCost === undefined && maxCloudSpend === undefined) return; // no spend ceiling to enforce

  // Worst-case prompt: sum of every message's content (rough char/4 estimate,
  // consistent with context-budget.ts's CHARS_PER_TOKEN posture).
  let promptChars = 0;
  for (const m of messages) promptChars += (m.content ?? "").length;
  const toolSchemaChars = opts.tools ? JSON.stringify(opts.tools).length : 0;
  const estPromptTokens = Math.ceil((promptChars + toolSchemaChars) / 4);
  const estOutputTokens = 1_024; // conservative default completion size
  const worstCaseUsd =
    (estPromptTokens / 1_000_000) * price.inputPerMillion + (estOutputTokens / 1_000_000) * price.outputPerMillion;

  const snap = budget.snapshot();
  const remainingCost = maxCost !== undefined ? maxCost - snap.costUsd : Number.POSITIVE_INFINITY;
  const remainingCloud =
    maxCloudSpend !== undefined && budget instanceof BudgetManager
      ? maxCloudSpend - budget.runUsage().cloudSpendUsd
      : Number.POSITIVE_INFINITY;
  const remaining = Math.min(remainingCost, remainingCloud);

  if (worstCaseUsd > remaining) {
    const err = new CloudSpendBudgetError(
      Math.round((snap.costUsd + worstCaseUsd) * 1e6) / 1e6,
      maxCloudSpend ?? maxCost!,
    );
    throw new ProviderError(
      `cloud call to ${model} refused by budget admission: worst-case $${worstCaseUsd.toFixed(4)} exceeds remaining $${remaining.toFixed(4)} (${err.message})`,
    );
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
  prices?: Map<string, ModelPrice>,
): void {
  if (!budget) return;
  const reading = readUsage(response);
  let cost: number | undefined;
  if (reading.source === "PROVIDER" && response.routedModel !== undefined) {
    if (registry) {
      cost = registry.estimateCostUsd(response.routedModel, reading.promptTokens ?? 0, reading.completionTokens ?? 0);
    }
    if (cost === undefined && prices) {
      cost = estimateCallCostUsd(
        prices,
        response.routedModel,
        reading.promptTokens ?? 0,
        reading.completionTokens ?? 0,
      );
    }
  }
  const usage = { ...budgetUsageOf(reading), costUsd: cost };
  // cloud-aware consumption when the run carries a BudgetManager (review item 14)
  if (budget instanceof BudgetManager) {
    budget.consumeModelCall({ ...usage, cloud: response.routedTier === "cloud" });
  } else {
    budget.consumeModelCall(usage);
  }
}
