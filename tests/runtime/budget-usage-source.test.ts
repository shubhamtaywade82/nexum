import { describe, it, expect } from "@jest/globals";
import { BudgetTracker } from "../../src/runtime/budget/budget-tracker.js";
import { BudgetManager } from "../../src/runtime/budget/budget-manager.js";

describe("BudgetTracker: model calls without provider-reported usage", () => {
  it("counts an unmetered call as a call, adds no tokens, and records it as unmetered", () => {
    const tracker = new BudgetTracker({ runId: "r", sessionId: "s" });
    tracker.consumeModelCall({ promptTokens: 100, completionTokens: 20, usageSource: "PROVIDER" });
    tracker.consumeModelCall({ usageSource: "MISSING" });

    expect(tracker.snapshot()).toMatchObject({ modelCalls: 2, totalTokens: 120, unmeteredModelCalls: 1 });
  });

  it("treats a call that arrives with no counts at all as unmetered", () => {
    const tracker = new BudgetTracker({ runId: "r", sessionId: "s" });
    tracker.consumeModelCall();
    expect(tracker.snapshot()).toMatchObject({ modelCalls: 1, totalTokens: 0, unmeteredModelCalls: 1 });
  });

  it("does not mark a fully reported call as unmetered", () => {
    const tracker = new BudgetTracker({ runId: "r", sessionId: "s" });
    tracker.consumeModelCall({ promptTokens: 5, completionTokens: 5, usageSource: "PROVIDER" });
    expect(tracker.snapshot()).toMatchObject({ modelCalls: 1, totalTokens: 10, unmeteredModelCalls: 0 });
  });

  it("still counts the part of a partial reading the provider did report", () => {
    const tracker = new BudgetTracker({ runId: "r", sessionId: "s" });
    tracker.consumeModelCall({ promptTokens: 40, usageSource: "MISSING" });
    expect(tracker.snapshot()).toMatchObject({ totalTokens: 40, unmeteredModelCalls: 1 });
  });
});

describe("BudgetManager: unmetered calls reach the parent run", () => {
  it("a child's MISSING call is visible in the parent's unmetered count", () => {
    const parent = new BudgetManager({ runId: "p", sessionId: "s" });
    const child = parent.deriveChild({ budget: {} });

    child.consumeModelCall({ usageSource: "MISSING", cloud: true });

    expect(child.snapshot().unmeteredModelCalls).toBe(1);
    expect(parent.snapshot()).toMatchObject({ modelCalls: 1, unmeteredModelCalls: 1 });
  });
});
