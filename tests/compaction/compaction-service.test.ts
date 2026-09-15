/**
 * Tests for the CompactionService.
 */
import { describe, it, expect } from "@jest/globals";
import {
  CompactionService,
  CompactionPolicy,
  TokenEstimator,
  RuleBasedSummaryProvider,
  HistoryReducer,
  type ConversationMessage,
} from "../../src/compaction/index.js";

describe("TokenEstimator", () => {
  const estimator = new TokenEstimator();

  it("estimates tokens as chars/4", () => {
    expect(estimator.estimate("hello world!")).toBe(Math.ceil(12 / 4));
  });

  it("adds overhead per message", () => {
    const msg: ConversationMessage = { role: "user", content: "hello" };
    const tokens = estimator.estimateMessage(msg);
    // 5 chars / 4 = 2 tokens, + 4 overhead = 6
    expect(tokens).toBe(Math.ceil(5 / 4) + 4);
  });

  it("sums tokens across a conversation", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const total = estimator.estimateConversation(messages);
    expect(total).toBeGreaterThan(0);
  });
});

describe("CompactionPolicy", () => {
  const policy = new CompactionPolicy();

  it("returns shouldCompact=false when under trigger", () => {
    const decision = policy.decide({
      messages: [{ role: "user", content: "hi" }],
      contextWindow: 8000,
    });
    expect(decision.shouldCompact).toBe(false);
  });

  it("returns shouldCompact=true when over trigger", () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "user", content: "x".repeat(200) });
      messages.push({ role: "assistant", content: "y".repeat(200) });
    }
    const decision = policy.decide({
      messages,
      contextWindow: 4000,
    });
    expect(decision.shouldCompact).toBe(true);
    expect(decision.messagesToCompact).toBeGreaterThan(0);
    expect(decision.messagesToKeep).toBeGreaterThanOrEqual(6);
  });

  it("respects keepRecentMessages", () => {
    const policy = new CompactionPolicy({ keepRecentMessages: 10 });
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "user", content: "x".repeat(200) });
    }
    const decision = policy.decide({ messages, contextWindow: 4000 });
    expect(decision.messagesToKeep).toBeGreaterThanOrEqual(10);
  });
});

describe("RuleBasedSummaryProvider", () => {
  it("summarizes a conversation with user/assistant/tool turns", async () => {
    const provider = new RuleBasedSummaryProvider();
    const messages: ConversationMessage[] = [
      { role: "user", content: "Fix the bug in auth.ts" },
      { role: "assistant", content: "I'll investigate the auth module." },
      { role: "tool", name: "read_file", toolCallId: "tc_1", content: "file contents..." },
      { role: "assistant", content: "Found the bug, applying fix." },
    ];
    const summary = await provider.summarize(messages);
    expect(summary).toContain("Compacted History");
    expect(summary).toContain("4 messages");
    expect(summary).toContain("Original Goal");
    expect(summary).toContain("Fix the bug");
    expect(summary).toContain("Tool Calls Made");
    expect(summary).toContain("read_file");
  });

  it("handles empty conversation", async () => {
    const provider = new RuleBasedSummaryProvider();
    const summary = await provider.summarize([]);
    expect(summary).toContain("empty history");
  });
});

describe("HistoryReducer", () => {
  it("replaces oldest N messages with a summary system message", () => {
    const reducer = new HistoryReducer();
    const messages: ConversationMessage[] = [
      { role: "system", content: "You are a helpful agent." },
      { role: "user", content: "first message" },
      { role: "assistant", content: "first response" },
      { role: "user", content: "second message" },
      { role: "assistant", content: "second response" },
    ];
    const decision = {
      shouldCompact: true,
      estimatedTokens: 1000,
      budget: 4000,
      messagesToCompact: 2,
      messagesToKeep: 3,
      reason: "test",
    };
    const reduced = reducer.reduce(messages, decision, "summary text");
    // System message preserved + summary + 3 kept = 5
    expect(reduced.length).toBe(5);
    expect(reduced[0].role).toBe("system");
    expect(reduced[0].content).toContain("helpful agent");
    expect(reduced[1].role).toBe("system");
    expect(reduced[1].content).toContain("Compacted History");
    expect(reduced[1].content).toContain("summary text");
    // After compaction: kept messages start at index 2 (first response was messages[2]).
    expect(reduced[2].content).toBe("first response");
    expect(reduced[3].content).toBe("second message");
    expect(reduced[4].content).toBe("second response");
  });

  it("is a no-op when shouldCompact is false", () => {
    const reducer = new HistoryReducer();
    const messages: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const decision = {
      shouldCompact: false,
      estimatedTokens: 10,
      budget: 4000,
      messagesToCompact: 0,
      messagesToKeep: 1,
      reason: "under trigger",
    };
    const reduced = reducer.reduce(messages, decision, "");
    expect(reduced).toEqual(messages);
  });
});

describe("CompactionService", () => {
  it("does not compact when under budget", async () => {
    const service = new CompactionService();
    const messages: ConversationMessage[] = [{ role: "user", content: "hi" }];
    const result = await service.compact({ messages, contextWindow: 8000 });
    expect(result.decision.shouldCompact).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("compacts when over budget", async () => {
    const service = new CompactionService();
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "user", content: "x".repeat(200) });
      messages.push({ role: "assistant", content: "y".repeat(200) });
    }
    const result = await service.compact({ messages, contextWindow: 4000 });
    expect(result.decision.shouldCompact).toBe(true);
    expect(result.removedCount).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.summary).toContain("Compacted History");
  });

  it("evaluate() is read-only", () => {
    const service = new CompactionService();
    const decision = service.evaluate({
      messages: [{ role: "user", content: "hi" }],
      contextWindow: 8000,
    });
    expect(decision.shouldCompact).toBe(false);
  });
});
