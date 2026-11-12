import { describe, it, expect } from "@jest/globals";
import {
  ESCALATION_SUMMARY_LIMITS,
  buildEscalationSummary,
  compactTranscriptForEscalation,
} from "../../src/cli/escalation-summary.js";
import { LOCAL_DELEGATION_SYSTEM_ADDENDUM } from "../../src/tools/delegate-tool.js";

describe("escalation summary (N-12)", () => {
  it("states the request, the reason and the latest tool results, and nothing older", () => {
    const toolResults = Array.from({ length: 10 }, (_, i) => `result-${i}`);
    const summary = buildEscalationSummary({
      goal: "fix the parser",
      reason: "quick model failed 2 tool calls",
      toolResults,
    });

    expect(summary).toContain("Reason: quick model failed 2 tool calls.");
    expect(summary).toContain("Request: fix the parser");
    expect(summary).toContain("- result-9");
    expect(summary).toContain("- result-4");
    expect(summary).not.toContain("result-3");
    expect(summary.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(ESCALATION_SUMMARY_LIMITS.maxResults);
  });

  it("bounds each part, so a huge tool output cannot make the escalation large", () => {
    const summary = buildEscalationSummary({
      goal: "g".repeat(10_000),
      reason: "r",
      toolResults: ["t".repeat(50_000)],
      lastAssistantText: "a".repeat(50_000),
    });
    expect(summary.length).toBeLessThan(
      ESCALATION_SUMMARY_LIMITS.goalChars +
        ESCALATION_SUMMARY_LIMITS.resultChars +
        ESCALATION_SUMMARY_LIMITS.assistantChars +
        500,
    );
    expect(summary).toContain("more characters]");
  });

  it("is deterministic: the same transcript and reason always give the same summary", () => {
    const input = { goal: "g", reason: "r", toolResults: ["a", "b"], lastAssistantText: "x" };
    expect(buildEscalationSummary(input)).toBe(buildEscalationSummary(input));
  });

  it("sends the system messages and one summary message, not the transcript", () => {
    const transcript = [
      { role: "system" as const, content: "You are Nexum." },
      { role: "user" as const, content: "earlier question" },
      {
        role: "assistant" as const,
        content: "earlier answer",
        tool_calls: [{ function: { name: "read", arguments: {} } }],
      },
      { role: "tool" as const, content: "file contents" },
      { role: "user" as const, content: "fix the parser" },
    ];
    const compact = compactTranscriptForEscalation(transcript, { goal: "fix the parser", reason: "escalated" });

    expect(compact.map((m) => m.role)).toEqual(["system", "user"]);
    expect(compact[0]?.content).toBe("You are Nexum.");
    expect(compact[1]?.content).toContain("file contents");
    expect(compact.some((m) => m.content === "earlier question")).toBe(false);
    expect(compact.some((m) => m.tool_calls !== undefined)).toBe(false);
  });
});

describe("control notes survive compaction", () => {
  it("keeps the reviewer's issues and the delegation addendum, the instructions the primary must follow", () => {
    const transcript = [
      { role: "system" as const, content: "system prompt" },
      { role: "user" as const, content: "[system] A reviewer rejected the previous draft answer:\n- wrong file" },
      { role: "assistant" as const, content: "old draft" },
      { role: "user" as const, content: LOCAL_DELEGATION_SYSTEM_ADDENDUM },
      { role: "user" as const, content: "the actual request" },
    ];
    const compact = compactTranscriptForEscalation(transcript, {
      goal: "the actual request",
      reason: "critic rejected",
    });
    const texts = compact.map((m) => m.content);

    expect(texts.some((t) => t.includes("A reviewer rejected the previous draft answer"))).toBe(true);
    expect(texts).toContain(LOCAL_DELEGATION_SYSTEM_ADDENDUM);
    expect(texts).not.toContain("old draft");
  });
});
