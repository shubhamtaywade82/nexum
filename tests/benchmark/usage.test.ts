import { usageFor } from "../../src/benchmark/runner.js";
import type { ChatResponse } from "../../src/models/adapters/provider.js";

function response(fields: Record<string, unknown>): ChatResponse {
  return { model: "m", done: true, message: { role: "assistant", content: "" }, ...fields } as unknown as ChatResponse;
}

describe("usageFor", () => {
  it("counts prompt and completion tokens the provider reported", () => {
    expect(usageFor(response({ prompt_eval_count: 900, eval_count: 120 }))).toEqual({
      tokens: 1020,
      tokensEstimated: false,
    });
  });

  it("falls back to a labelled estimate only when the provider reports no counts", () => {
    const usage = usageFor(response({ message: { role: "assistant", content: "x".repeat(40) } }));
    expect(usage).toEqual({ tokens: 10, tokensEstimated: true });
  });

  it("never reports a fixed count: different responses get different usage", () => {
    const small = usageFor(response({ prompt_eval_count: 10, eval_count: 2 }));
    const large = usageFor(response({ prompt_eval_count: 4000, eval_count: 300 }));
    expect(small.tokens).not.toBe(large.tokens);
  });
});
