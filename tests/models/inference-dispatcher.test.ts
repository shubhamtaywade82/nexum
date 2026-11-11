import { describe, it, expect } from "@jest/globals";
import { Provider, ProviderError, type ChatResponse } from "../../src/models/adapters/provider.js";
import { InferenceDispatcher } from "../../src/models/gateway/inference-dispatcher.js";
import { BudgetTracker } from "../../src/runtime/budget/budget-tracker.js";

const CHAT = [{ role: "user" as const, content: "hi" }];

function reply(extra: Record<string, unknown> = {}): ChatResponse {
  return { message: { role: "assistant", content: "ok" }, done: true, ...extra } as ChatResponse;
}

describe("InferenceDispatcher", () => {
  it("sends to the named lane's provider, pins the requested model, and stamps where it ran", async () => {
    const local = new Provider({ tier: "local", model: "configured" });
    const chat = jest.spyOn(local, "chat").mockResolvedValue(reply());
    const dispatcher = InferenceDispatcher.single("primary", local);

    const response = await dispatcher.dispatch({ lane: "primary", purpose: "test", model: "pinned:8b" }, CHAT);

    expect(chat).toHaveBeenCalledWith(CHAT, expect.objectContaining({ model: "pinned:8b" }));
    expect(response.routedTier).toBe("local");
    expect(response.routedModel).toBe("pinned:8b");
  });

  it("uses the lane provider's configured model when no model is pinned", async () => {
    const local = new Provider({ tier: "local", model: "configured" });
    jest.spyOn(local, "chat").mockResolvedValue(reply());
    const response = await InferenceDispatcher.single("primary", local).dispatch(
      { lane: "primary", purpose: "test" },
      CHAT,
    );
    expect(response.routedModel).toBe("configured");
  });

  it("refuses a lane that is not configured, rather than falling through to another provider", async () => {
    const dispatcher = new InferenceDispatcher({ lanes: { primary: undefined } });
    await expect(dispatcher.dispatch({ lane: "primary", purpose: "test" }, CHAT)).rejects.toBeInstanceOf(ProviderError);
    expect(dispatcher.has("primary")).toBe(false);
  });

  it("records what the provider reported on the budget", async () => {
    const local = new Provider({ tier: "local", model: "m" });
    jest.spyOn(local, "chat").mockResolvedValue(reply({ prompt_eval_count: 30, eval_count: 12 }));
    const budget = new BudgetTracker({ runId: "r", sessionId: "s" });

    await InferenceDispatcher.single("primary", local, { budget }).dispatch({ lane: "primary", purpose: "t" }, CHAT);

    expect(budget.snapshot()).toMatchObject({ modelCalls: 1, totalTokens: 42, unmeteredModelCalls: 0 });
  });

  it("records a response without counters as unmetered, adding no tokens", async () => {
    const local = new Provider({ tier: "local", model: "m" });
    jest.spyOn(local, "chat").mockResolvedValue(reply());
    const budget = new BudgetTracker({ runId: "r", sessionId: "s" });

    await InferenceDispatcher.single("primary", local, { budget }).dispatch({ lane: "primary", purpose: "t" }, CHAT);

    expect(budget.snapshot()).toMatchObject({ modelCalls: 1, totalTokens: 0, unmeteredModelCalls: 1 });
  });

  it("holds one cloud concurrency cap across every cloud lane, not one per lane", async () => {
    const a = new Provider({ tier: "cloud", model: "a", apiKey: "k" });
    const b = new Provider({ tier: "cloud", model: "b", apiKey: "k" });
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return reply();
    };
    jest.spyOn(a, "chat").mockImplementation(slow);
    jest.spyOn(b, "chat").mockImplementation(slow);
    const dispatcher = new InferenceDispatcher({ lanes: { primary: a, quick: b } });

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        dispatcher.dispatch({ lane: i % 2 === 0 ? "primary" : "quick", purpose: "t" }, CHAT),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("two dispatchers in one process share the cloud cap, so parallel callers cannot multiply it", async () => {
    let inFlight = 0;
    let peak = 0;
    const slowCloud = (): Provider => {
      const provider = new Provider({ tier: "cloud", model: "m", apiKey: "k" });
      jest.spyOn(provider, "chat").mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return reply();
      });
      return provider;
    };
    const calls = Array.from({ length: 6 }, () =>
      InferenceDispatcher.single("engineering", slowCloud()).dispatch({ lane: "engineering", purpose: "t" }, CHAT),
    );

    await Promise.all(calls);

    expect(peak).toBeLessThanOrEqual(3);
  });

  it("port() is a ChatPort bound to its target", async () => {
    const local = new Provider({ tier: "local", model: "m" });
    const chat = jest.spyOn(local, "chat").mockResolvedValue(reply());
    const port = InferenceDispatcher.single("primary", local).port({ lane: "primary", purpose: "t", model: "p:1b" });

    await port.chat(CHAT);

    expect(chat).toHaveBeenCalledWith(CHAT, expect.objectContaining({ model: "p:1b" }));
  });
});
