import { describe, it, expect } from "@jest/globals";
import { OutcomeUnknownError, RateLimitError, type ChatResponse } from "../../src/models/adapters/provider.js";
import { routeWithFallbackOn } from "../../src/models/gateway/route-fallback.js";

const CHAT = [{ role: "user" as const, content: "hi" }];
const reply = (content: string): ChatResponse => ({ message: { role: "assistant", content }, done: true });

describe("routeWithFallbackOn", () => {
  it("returns the routed answer without touching the fallback", async () => {
    const fallback = { chat: jest.fn(async () => reply("fallback")) };
    const route = jest.fn(async () => reply("routed"));

    const result = await routeWithFallbackOn(route, fallback, "quick", CHAT);

    expect(result.message.content).toBe("routed");
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it("falls back when the failure came before the request could run (rate limited)", async () => {
    const fallback = { chat: jest.fn(async () => reply("fallback")) };
    const route = async () => {
      throw new RateLimitError("busy");
    };

    const result = await routeWithFallbackOn(route, fallback, "quick", CHAT);

    expect(result.message.content).toBe("fallback");
    expect(fallback.chat).toHaveBeenCalledTimes(1);
  });

  it("never re-sends a paid request that may have run: an unknown outcome is rethrown, not retried", async () => {
    const fallback = { chat: jest.fn(async () => reply("fallback")) };
    const route = async () => {
      throw new OutcomeUnknownError("cloud timed out");
    };

    await expect(routeWithFallbackOn(route, fallback, "quick", CHAT)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fallback.chat).not.toHaveBeenCalled();
  });
});
