import { describe, it, expect } from "@jest/globals";
import { InferenceDispatcher } from "../../src/models/gateway/inference-dispatcher.js";
import { BudgetManager } from "../../src/runtime/budget/budget-manager.js";
import { BudgetTracker } from "../../src/runtime/budget/budget-tracker.js";
import { ModelUsageLedger } from "../../src/models/observability/usage-ledger.js";
import { MonthlySpendGuard } from "../../src/models/observability/monthly-spend-guard.js";
import { Provider, type ChatResponse } from "../../src/models/adapters/provider.js";

/** A Provider double that records whether chat() was actually entered. */
class ProbeProvider extends Provider {
  chatEntered = 0;
  constructor(
    tier: "local" | "cloud",
    model: string,
    private readonly respond: () => Promise<ChatResponse>,
  ) {
    super({ tier, model });
  }
  override async chat(): Promise<ChatResponse> {
    this.chatEntered += 1;
    return this.respond();
  }
}

function okResponse(): ChatResponse {
  return {
    message: { role: "assistant", content: "ok" },
    done: true,
    prompt_eval_count: 50,
    eval_count: 10,
  } as unknown as ChatResponse;
}

function bigPromptChars(): string {
  return "x".repeat(400_000); // ~100k tokens
}

describe("InferenceDispatcher admission + ledger", () => {
  it("refuses a cloud call BEFORE dispatch when the worst-case estimate cannot fit the remaining budget", async () => {
    const provider = new ProbeProvider("cloud", "gemma4", okResponse);
    const budget = new BudgetManager({ budget: { maxCostUsd: 0.001 } });
    const dispatcher = new InferenceDispatcher({ lanes: { cloud: provider }, budget });

    await expect(
      dispatcher.dispatch({ lane: "cloud", purpose: "test" }, [{ role: "user", content: bigPromptChars() }], {}),
    ).rejects.toThrow(/refused by budget admission/);

    // THE assertion: the request never reached the provider
    expect(provider.chatEntered).toBe(0);
  });

  it("admits the call when the estimate fits, and records it on the ledger", async () => {
    const provider = new ProbeProvider("cloud", "gemma4", okResponse);
    const budget = new BudgetManager({ budget: { maxCostUsd: 1 } });
    const ledger = new ModelUsageLedger({ persist: false });
    const dispatcher = new InferenceDispatcher({ lanes: { cloud: provider }, budget, ledger });

    const response = await dispatcher.dispatch(
      { lane: "cloud", purpose: "test.admit" },
      [{ role: "user", content: "hi" }],
      {},
    );
    expect(response.routedTier).toBe("cloud");
    expect(provider.chatEntered).toBe(1);

    const records = ledger.all();
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("success");
    expect(records[0].promptTokens).toBe(50);
    expect(records[0].completionTokens).toBe(10);
    expect(records[0].costUsd).toBeCloseTo((50 / 1e6) * 0.14 + (10 / 1e6) * 0.4, 8); // catalog gemma4 rate
    expect(records[0].costUnknown).toBe(false);
    expect(records[0].retryCount).toBe(0);

    // and the budget consumed it
    expect(budget.snapshot().modelCalls).toBe(1);
    expect(budget.snapshot().costUsd).toBeCloseTo(records[0].costUsd ?? 0, 6);
  });

  it("enforces the ceiling after the call too (post-hoc throw keeps real counts)", async () => {
    const provider = new ProbeProvider("cloud", "kimi-k3.1:pro", okResponse);
    // Admission's worst-case for a "hi" prompt on kimi ($10/M out, 1024-token
    // estimate) is ~$0.0102, so a $0.02 ceiling lets the call through — then
    // the REAL cost... also lands under it. To exercise the post-hoc path we
    // instead consume the budget first: spend $0.0199 of a $0.02 ceiling so
    // admission (worst-case $0.0102 > $0.0001 remaining) would refuse — so
    // disable admission and verify the post-hoc ceiling still throws with the
    // ledger keeping the call's real counts.
    const budget = new BudgetManager({ budget: { maxCostUsd: 0.02 } });
    budget.consumeModelCall({
      promptTokens: 9_950,
      completionTokens: 0,
      costUsd: 0.0199,
      usageSource: "PROVIDER",
      cloud: true,
    });
    const ledger = new ModelUsageLedger({ persist: false });
    const dispatcher = new InferenceDispatcher({
      lanes: { cloud: provider },
      budget,
      ledger,
      admitWithinBudget: false,
    });

    await expect(
      dispatcher.dispatch({ lane: "cloud", purpose: "test.post" }, [{ role: "user", content: "hi" }], {}),
    ).rejects.toThrow();

    // the call ran (admission disabled), and the ledger recorded the
    // over-budget call WITH its real provider counts — not as unknown
    expect(provider.chatEntered).toBe(1);
    const records = ledger.all();
    expect(records).toHaveLength(1);
    expect(records[0].promptTokens).toBe(50);
    expect(records[0].completionTokens).toBe(10);
    expect(records[0].costUsd).not.toBeUndefined();
  });

  it("records failures and unknown outcomes on the ledger, then rethrows", async () => {
    const failing = new ProbeProvider("cloud", "gemma4", async () => {
      throw new TypeError("fetch failed");
    });
    const ledger = new ModelUsageLedger({ persist: false });
    const dispatcher = new InferenceDispatcher({ lanes: { cloud: failing }, ledger });

    await expect(
      dispatcher.dispatch({ lane: "cloud", purpose: "test.fail" }, [{ role: "user", content: "hi" }], {}),
    ).rejects.toThrow();

    const records = ledger.all();
    expect(records).toHaveLength(1);
    // TypeError on cloud = unknown outcome (may have billed), per isUnknownOutcome
    expect(records[0].status).toBe("unknown_outcome");
    expect(records[0].tokensUnknown).toBe(true);
    expect(records[0].costUnknown).toBe(true);
  });

  it("local calls skip admission entirely (no price needed, no ceiling check)", async () => {
    const provider = new ProbeProvider("local", "llama3.2:1b", okResponse);
    const budget = new BudgetManager({ budget: { maxCostUsd: 0.000001 } });
    const dispatcher = new InferenceDispatcher({ lanes: { local: provider }, budget });

    const response = await dispatcher.dispatch(
      { lane: "local", purpose: "test.local" },
      [{ role: "user", content: bigPromptChars() }],
      {},
    );
    expect(provider.chatEntered).toBe(1);
    expect(response.routedTier).toBe("local");
  });

  it("unpriced cloud models pass admission (unknown, not blocked)", async () => {
    const provider = new ProbeProvider("cloud", "mystery-model", okResponse);
    const budget = new BudgetManager({ budget: { maxCostUsd: 0.000001 } });
    const dispatcher = new InferenceDispatcher({ lanes: { cloud: provider }, budget });

    await expect(
      dispatcher.dispatch(
        { lane: "cloud", purpose: "test.unpriced" },
        [{ role: "user", content: bigPromptChars() }],
        {},
      ),
    ).resolves.toBeTruthy();
    expect(provider.chatEntered).toBe(1);
  });

  it("admission can be disabled to restore post-hoc-only behaviour", async () => {
    const provider = new ProbeProvider("cloud", "gemma4", okResponse);
    const budget = new BudgetTracker({ budget: { maxCostUsd: 0.001 } });
    const dispatcher = new InferenceDispatcher({
      lanes: { cloud: provider },
      budget,
      admitWithinBudget: false,
    });

    await expect(
      dispatcher.dispatch(
        { lane: "cloud", purpose: "test.noadmit" },
        [{ role: "user", content: bigPromptChars() }],
        {},
      ),
    ).resolves.toBeTruthy();
    expect(provider.chatEntered).toBe(1);
  });
});

describe("InferenceDispatcher monthly spend guard", () => {
  it("refuses a cloud call BEFORE dispatch when month-to-date spend crossed budget - reserve", async () => {
    const provider = new ProbeProvider("cloud", "gemma4", okResponse);
    // Ledger already holds $36 this month (48 - 12 default block threshold).
    const ledger = new ModelUsageLedger({ persist: false });
    ledger.record({
      runId: "run_earlier_session",
      purpose: "chat.primary",
      lane: "primary",
      tier: "cloud",
      model: "gemma4",
      promptTokens: 1000,
      completionTokens: 100,
      tokensUnknown: false,
      costUsd: 36,
      costUnknown: false,
      latencyMs: 100,
      retryCount: 0,
      status: "success",
    });
    const guard = new MonthlySpendGuard({ ledger });
    const dispatcher = new InferenceDispatcher({ lanes: { cloud: provider }, spendGuard: guard });

    await expect(
      dispatcher.dispatch({ lane: "cloud", purpose: "test" }, [{ role: "user", content: "hi" }], {}),
    ).rejects.toThrow(/refused by monthly spend guard/);

    // THE assertion: the request never reached the provider, even though this
    // run's own budget has no ceiling at all.
    expect(provider.chatEntered).toBe(0);
  });

  it("passes when the month's spend is below the threshold, and local calls are never guarded", async () => {
    const cloud = new ProbeProvider("cloud", "gemma4", okResponse);
    const ledger = new ModelUsageLedger({ persist: false });
    ledger.record({
      runId: "run_earlier",
      purpose: "chat.primary",
      lane: "primary",
      tier: "cloud",
      model: "gemma4",
      promptTokens: 10,
      completionTokens: 1,
      tokensUnknown: false,
      costUsd: 1,
      costUnknown: false,
      latencyMs: 5,
      retryCount: 0,
      status: "success",
    });
    const guard = new MonthlySpendGuard({ ledger });
    const dispatcher = new InferenceDispatcher({
      lanes: { cloud, local: new ProbeProvider("local", "qwen", okResponse) },
      spendGuard: guard,
    });

    await expect(
      dispatcher.dispatch({ lane: "cloud", purpose: "test" }, [{ role: "user", content: "hi" }], {}),
    ).resolves.toBeTruthy();
    await expect(
      dispatcher.dispatch({ lane: "local", purpose: "test" }, [{ role: "user", content: "hi" }], {}),
    ).resolves.toBeTruthy();
    expect(cloud.chatEntered).toBe(1);
  });
});
