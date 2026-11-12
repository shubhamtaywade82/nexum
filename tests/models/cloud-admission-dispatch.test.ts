import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { InferenceDispatcher } from "../../src/models/gateway/inference-dispatcher.js";
import { ConcurrencyGate } from "../../src/core/concurrency/gate.js";
import {
  BudgetRefusedError,
  OutcomeUnknownError,
  PaymentRequiredError,
  RateLimitError,
  TimeoutError,
  TransportFailure,
} from "../../src/models/errors.js";
import { Provider, ProviderError, type ChatResponse } from "../../src/models/adapters/provider.js";
import { UnpricedModelError, DEFAULT_PRICE_CATALOG } from "../../src/models/profiles/pricing-catalog.js";
import { BudgetLedger } from "../../src/economics/ledger/budget-ledger.js";
import { LedgerCloudAdmission, inputTokenBound } from "../../src/economics/cloud-admission.js";
import { reservationBoundMicroUsd } from "../../src/economics/cost.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const MODEL = "gpt-oss:120b-cloud";
const CHAT = [{ role: "user" as const, content: "hello" }];
const DOLLAR = 1_000_000;

let ledger: BudgetLedger;

afterEach(() => {
  ledger?.close();
});

function setup(opts: { capMicro?: number | null; maxCloudConcurrency?: number; maxOutputTokens?: number } = {}) {
  const cap = opts.capMicro === undefined ? 46 * DOLLAR : opts.capMicro;
  ledger = new BudgetLedger({ path: ":memory:", clock: () => NOW, maxCloudConcurrency: opts.maxCloudConcurrency ?? 3 });
  const admission = new LedgerCloudAdmission({
    ledger,
    prices: DEFAULT_PRICE_CATALOG,
    accountId: "acct",
    monthlyCapMicro: cap,
    clock: () => NOW,
    ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
  });
  const provider = new Provider({ tier: "cloud", model: MODEL, apiKey: "test-key" });
  const dispatcher = new InferenceDispatcher({
    lanes: { primary: provider },
    admission,
    gates: { cloud: new ConcurrencyGate({ maxConcurrent: 10 }) },
  });
  const target = { lane: "primary", purpose: "chat.primary", taskId: "task-1" };
  return { admission, provider, dispatcher, target };
}

function reservationRows(): Array<{
  state: string;
  settledMicro: number | null;
  boundMicro: number;
  releaseProof: string | null;
}> {
  return ledger.reservationsOf("acct").map((r) => ({
    state: r.state,
    settledMicro: r.settledMicro,
    boundMicro: r.boundMicro,
    releaseProof: r.releaseProof,
  }));
}

function exact(prompt: number, cached: number, completion: number): ChatResponse {
  return {
    message: { role: "assistant", content: "ok" },
    done: true,
    prompt_eval_count: prompt,
    prompt_eval_cached_count: cached,
    eval_count: completion,
  } as ChatResponse;
}

describe("cloud calls are admitted before they are sent (N-9)", () => {
  it("refuses a cloud call with no admission controller, and sends nothing", async () => {
    const provider = new Provider({ tier: "cloud", model: MODEL, apiKey: "k" });
    const chat = jest.spyOn(provider, "chat").mockResolvedValue(exact(1, 0, 1));
    const dispatcher = new InferenceDispatcher({
      lanes: { primary: provider },
      gates: { cloud: new ConcurrencyGate({ maxConcurrent: 1 }) },
    });

    await expect(dispatcher.dispatch({ lane: "primary", purpose: "t" }, CHAT)).rejects.toMatchObject({
      reason: "NO_ADMISSION",
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it("refuses an unpriced cloud model before anything is sent, and reserves nothing", async () => {
    const { dispatcher, provider, target } = setup();
    const chat = jest.spyOn(provider, "chat").mockResolvedValue(exact(1, 0, 1));

    await expect(dispatcher.dispatch({ ...target, model: "gemma4:31b" }, CHAT)).rejects.toBeInstanceOf(
      UnpricedModelError,
    );
    expect(chat).not.toHaveBeenCalled();
    expect(ledger.reservationsOf("acct")).toHaveLength(0);
  });

  it("settles an admitted call to its exact cost, and pins the output cap on the request", async () => {
    const { dispatcher, provider, target } = setup();
    const chat = jest.spyOn(provider, "chat").mockResolvedValue(exact(500, 500, 100));

    const response = await dispatcher.dispatch(target, CHAT);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[1]).toMatchObject({ model: MODEL, options: { num_predict: 4096 } });
    // 500 × $0.15 + 500 × $0.014 + 100 × $0.60 per million = 142 µ$
    expect(reservationRows()).toEqual([expect.objectContaining({ state: "SETTLED", settledMicro: 142 })]);
    const details = ledger.events(ledger.reservationsOf("acct")[0]!.reservationId).map((e) => e.detail ?? "");
    expect(details.some((d) => d.startsWith("basis=EXACT"))).toBe(true);
    expect(response.routedTier).toBe("cloud");
    expect(response.routedModel).toBe(MODEL);
  });

  it("settles at the reservation bound when the provider reports no counters, never at zero", async () => {
    const { dispatcher, provider, target } = setup();
    jest
      .spyOn(provider, "chat")
      .mockResolvedValue({ message: { role: "assistant", content: "ok" }, done: true } as ChatResponse);

    await dispatcher.dispatch(target, CHAT);

    const [row] = reservationRows();
    expect(row).toMatchObject({ state: "SETTLED" });
    expect(row!.settledMicro).toBe(row!.boundMicro);
    expect(row!.settledMicro).toBeGreaterThan(0);
  });

  it("refuses a call whose worst case does not fit under the cycle cap, and sends nothing", async () => {
    const { dispatcher, provider, target } = setup({ capMicro: 1 });
    const chat = jest.spyOn(provider, "chat").mockResolvedValue(exact(1, 0, 1));

    await expect(dispatcher.dispatch(target, CHAT)).rejects.toMatchObject({ reason: "BUDGET_EXCEEDED" });
    expect(chat).not.toHaveBeenCalled();
  });

  it("refuses an output cap above the ceiling", async () => {
    const { dispatcher, provider, target } = setup();
    const chat = jest.spyOn(provider, "chat").mockResolvedValue(exact(1, 0, 1));

    await expect(dispatcher.dispatch({ ...target }, CHAT, { options: { num_predict: 100_000 } })).rejects.toMatchObject(
      { reason: "OUTPUT_CAP_EXCEEDED" },
    );
    expect(chat).not.toHaveBeenCalled();
  });

  it("refuses with a budget error, not a provider error, so the router does not fail over", async () => {
    const { dispatcher, provider, target } = setup({ capMicro: 1 });
    jest.spyOn(provider, "chat").mockResolvedValue(exact(1, 0, 1));
    await expect(dispatcher.dispatch(target, CHAT)).rejects.toBeInstanceOf(BudgetRefusedError);
  });

  it("leaves local calls unaccounted: no reservation, no admission", async () => {
    ledger = new BudgetLedger({ path: ":memory:", clock: () => NOW });
    const local = new Provider({ tier: "local", model: "llama3.2" });
    jest.spyOn(local, "chat").mockResolvedValue(exact(10, 0, 10));
    const dispatcher = new InferenceDispatcher({
      lanes: { primary: local },
      gates: { local: new ConcurrencyGate({ maxConcurrent: 1 }) },
    });

    const response = await dispatcher.dispatch({ lane: "primary", purpose: "t" }, CHAT);
    expect(response.routedTier).toBe("local");
    expect(ledger.reservationsOf("acct")).toHaveLength(0);
  });
});

describe("the outcome of a failed cloud call decides its reservation", () => {
  it("holds the reservation and does not send again after a timeout that may have run the request", async () => {
    const { dispatcher, provider, target } = setup();
    const chat = jest.spyOn(provider, "chat").mockRejectedValue(new OutcomeUnknownError("timed out after dispatch"));

    await expect(dispatcher.dispatch(target, CHAT)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(reservationRows()).toEqual([expect.objectContaining({ state: "UNKNOWN_USAGE" })]);
  });

  it("holds a plain transport timeout as unknown, since the request may have executed", async () => {
    const { dispatcher, provider, target } = setup();
    jest.spyOn(provider, "chat").mockRejectedValue(new TimeoutError("no response"));
    await expect(dispatcher.dispatch(target, CHAT)).rejects.toBeInstanceOf(TransportFailure);
    expect(reservationRows()).toEqual([expect.objectContaining({ state: "UNKNOWN_USAGE" })]);
  });

  it("releases the reservation on a 429, which proves the request was rejected before it ran", async () => {
    const { dispatcher, provider, target } = setup();
    jest.spyOn(provider, "chat").mockRejectedValue(new RateLimitError("busy", 1000));
    await expect(dispatcher.dispatch(target, CHAT)).rejects.toBeInstanceOf(RateLimitError);
    expect(reservationRows()).toEqual([expect.objectContaining({ state: "RELEASED" })]);
    expect(reservationRows()[0]!.releaseProof).toContain("429");
  });

  it("releases the reservation on a 402, which proves nothing was billed", async () => {
    const { dispatcher, provider, target } = setup();
    jest.spyOn(provider, "chat").mockRejectedValue(new PaymentRequiredError("payment required"));
    await expect(dispatcher.dispatch(target, CHAT)).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(reservationRows()).toEqual([expect.objectContaining({ state: "RELEASED" })]);
  });

  it("releases on a connection refused before the socket opened", async () => {
    const { dispatcher, provider, target } = setup();
    const refused = new TransportFailure(
      "connect failed",
      null,
      Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
    );
    jest.spyOn(provider, "chat").mockRejectedValue(refused);
    await expect(dispatcher.dispatch(target, CHAT)).rejects.toBeInstanceOf(TransportFailure);
    expect(reservationRows()).toEqual([expect.objectContaining({ state: "RELEASED" })]);
  });

  it("holds an unclassified provider error as unknown: a 5xx may have run the request", async () => {
    const { dispatcher, provider, target } = setup();
    jest.spyOn(provider, "chat").mockRejectedValue(new ProviderError("internal server error"));
    await expect(dispatcher.dispatch(target, CHAT)).rejects.toBeInstanceOf(ProviderError);
    expect(reservationRows()).toEqual([expect.objectContaining({ state: "UNKNOWN_USAGE" })]);
  });

  it("holds the next call of the same account while an unknown outcome is open, against the same cap", async () => {
    // Room for exactly one worst case: the first call fits, and the held worst case then blocks the second.
    const oneWorstCase = reservationBoundMicroUsd(
      inputTokenBound(CHAT, undefined),
      4096,
      DEFAULT_PRICE_CATALOG.requirePrice(MODEL, NOW),
    );
    const { dispatcher, provider, target } = setup({ capMicro: oneWorstCase + 1 });
    jest.spyOn(provider, "chat").mockRejectedValueOnce(new OutcomeUnknownError("first"));
    await expect(dispatcher.dispatch(target, CHAT)).rejects.toBeInstanceOf(OutcomeUnknownError);

    const sentBefore = jest.mocked(provider.chat).mock.calls.length;
    await expect(dispatcher.dispatch(target, CHAT)).rejects.toMatchObject({ reason: "BUDGET_EXCEEDED" });
    expect(jest.mocked(provider.chat).mock.calls.length).toBe(sentBefore);
  });
});

describe("cloud concurrency is shared through the ledger (N-9)", () => {
  it("admits no more concurrent reservations than the ledger allows, across dispatchers", async () => {
    const { admission, target } = setup({ maxCloudConcurrency: 2 });
    const providerA = new Provider({ tier: "cloud", model: MODEL, apiKey: "k" });
    const release: Array<() => void> = [];
    jest
      .spyOn(providerA, "chat")
      .mockImplementation(() => new Promise<ChatResponse>((resolve) => release.push(() => resolve(exact(1, 0, 1)))));
    const d1 = new InferenceDispatcher({
      lanes: { primary: providerA },
      admission,
      gates: { cloud: new ConcurrencyGate({ maxConcurrent: 10 }) },
    });
    const d2 = new InferenceDispatcher({
      lanes: { primary: providerA },
      admission,
      gates: { cloud: new ConcurrencyGate({ maxConcurrent: 10 }) },
    });

    const inFlight = [d1.dispatch(target, CHAT), d1.dispatch(target, CHAT)];
    await new Promise((r) => setImmediate(r));
    await expect(d2.dispatch(target, CHAT)).rejects.toMatchObject({ reason: "CLOUD_CONCURRENCY" });

    release.forEach((r) => r());
    await Promise.all(inFlight);
  });
});

describe("the worst-case input bound", () => {
  it("grows with the serialized request, including tool schemas and per-message overhead", () => {
    const small = inputTokenBound(CHAT, undefined);
    const withTools = inputTokenBound(CHAT, [{ name: "read_file", parameters: { path: "string" } }]);
    const twoMessages = inputTokenBound([...CHAT, { role: "assistant", content: "hi" }], undefined);
    expect(withTools).toBeGreaterThan(small);
    expect(twoMessages).toBeGreaterThan(small);
  });
});
