/**
 * EscalationLadder: one transition per turn, the first reason wins, and the
 * capability answering each call follows the transition.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { EscalationLadder } from "../../src/cli/escalation-ladder.js";

describe("EscalationLadder", () => {
  it("starts on the quick tier and is not escalated", () => {
    const ladder = new EscalationLadder("reasoning", jest.fn());
    expect(ladder.escalated).toBe(false);
    expect(ladder.reason).toBeNull();
    expect(ladder.capability).toBe("quick");
  });

  it("escalates once, records the reason, and announces the transition", () => {
    const onEscalate = jest.fn();
    const ladder = new EscalationLadder(null, onEscalate);
    expect(ladder.escalate("quick model failed 2 consecutive tool calls")).toBe(true);
    expect(ladder.escalated).toBe(true);
    expect(ladder.reason).toBe("quick model failed 2 consecutive tool calls");
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(onEscalate).toHaveBeenCalledWith("escalating to primary model: quick model failed 2 consecutive tool calls");
  });

  it("ignores a later escalation: no second announcement, and the first reason stays", () => {
    const onEscalate = jest.fn();
    const ladder = new EscalationLadder(null, onEscalate);
    ladder.escalate("first");
    expect(ladder.escalate("second")).toBe(false);
    expect(ladder.reason).toBe("first");
    expect(onEscalate).toHaveBeenCalledTimes(1);
  });

  it("answers with the hint once escalated, and with the default primary when there is none", () => {
    const withHint = new EscalationLadder("vision", jest.fn());
    withHint.escalate("x");
    expect(withHint.capability).toBe("vision");

    const withoutHint = new EscalationLadder(null, jest.fn());
    withoutHint.escalate("x");
    expect(withoutHint.capability).toBeNull();
  });

  it("names the target in the status line when the caller gives one", () => {
    const onEscalate = jest.fn();
    const ladder = new EscalationLadder("reasoning", onEscalate);
    ladder.escalate("local model escaped workspace root", "reasoning");
    expect(onEscalate).toHaveBeenCalledWith("escalating to reasoning: local model escaped workspace root");
  });

  it("a fresh ladder starts on the quick tier again, so nothing carries across turns", () => {
    const first = new EscalationLadder(null, jest.fn());
    first.escalate("x");
    const second = new EscalationLadder(null, jest.fn());
    expect(second.escalated).toBe(false);
    expect(second.capability).toBe("quick");
  });
});
