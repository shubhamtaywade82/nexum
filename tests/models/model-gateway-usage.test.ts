import { describe, it, expect } from "@jest/globals";
import type { ChatMessage, ChatResponse } from "../../src/models/adapters/provider.js";
import type { ModelCatalog } from "../../src/models/catalog.js";
import { DefaultModelGateway } from "../../src/models/gateway/model-gateway.js";
import type { Router } from "../../src/models/router/router.js";
import { BudgetTracker } from "../../src/runtime/budget/budget-tracker.js";

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

function gatewayReturning(response: ChatResponse, budget: BudgetTracker): DefaultModelGateway {
  const router = { route: async () => response } as unknown as Router;
  return new DefaultModelGateway({ router, catalog: {} as ModelCatalog, budget });
}

describe("DefaultModelGateway budget accounting", () => {
  it("records the tokens of a response the provider reported", async () => {
    const budget = new BudgetTracker({ runId: "r", sessionId: "s" });
    const gateway = gatewayReturning(
      {
        message: { role: "assistant", content: "ok" },
        done: true,
        prompt_eval_count: 30,
        eval_count: 12,
        routedModel: "qwen3:8b",
        routedTier: "local",
      } as ChatResponse,
      budget,
    );

    await gateway.route("coding", messages);

    expect(budget.snapshot()).toMatchObject({ modelCalls: 1, totalTokens: 42, unmeteredModelCalls: 0 });
  });

  it("records a response without counters as unmetered: no invented tokens, no cost", async () => {
    const budget = new BudgetTracker({ runId: "r", sessionId: "s" });
    const gateway = gatewayReturning(
      {
        message: { role: "assistant", content: "ok" },
        done: true,
        routedModel: "gpt-oss:120b-cloud",
        routedTier: "cloud",
      } as ChatResponse,
      budget,
    );

    await gateway.route("coding", messages);

    expect(budget.snapshot()).toMatchObject({
      modelCalls: 1,
      totalTokens: 0,
      costUsd: 0,
      unmeteredModelCalls: 1,
    });
  });
});
