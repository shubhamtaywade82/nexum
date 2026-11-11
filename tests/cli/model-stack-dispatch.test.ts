import { ModelStack } from "../../src/cli/services/model-stack.js";
import { OutcomeUnknownError, RateLimitError, type ChatResponse } from "../../src/models/adapters/provider.js";
import type { CliConfig } from "../../src/cli/config.js";

// The CLI's routing fallback, end to end on a real ModelStack: the router's failure is injected, the primary's chat
// is observed. The rule under test: a paid request that may have run is never sent a second time.

function cloudCfg(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    model: "gpt-oss:120b-cloud",
    workspaceRoot: "/tmp/nexum-model-stack-dispatch-test",
    tier: "cloud",
    apiKey: "test-key",
    host: "https://ollama.com",
    enableAvailabilityCheck: false,
    enableDecision: false,
    enableLocalWorker: false,
    enableVerifier: false,
    enableSelfConsistency: false,
    workspaceTrust: { status: "trusted", trusted: true, withheldKeys: [], skippedEnvFiles: [] },
    ...overrides,
  } as CliConfig;
}

const reply: ChatResponse = { message: { role: "assistant", content: "from primary" }, done: true };
const CHAT = [{ role: "user" as const, content: "hi" }];

describe("ModelStack.routeWithFallback", () => {
  it("does not send a cloud request again when its first attempt may have run", async () => {
    const stack = new ModelStack(cloudCfg(), () => {});
    jest.spyOn(stack, "ensureCatalog").mockResolvedValue(undefined);
    jest.spyOn(stack.router, "route").mockRejectedValue(new OutcomeUnknownError("cloud timed out"));
    const primary = jest.spyOn(stack.provider, "chat").mockResolvedValue(reply);

    await expect(stack.routeWithFallback("coding", CHAT)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(primary).not.toHaveBeenCalled();
  });

  it("falls back to the primary when the router failed before anything was sent", async () => {
    const stack = new ModelStack(cloudCfg(), () => {});
    jest.spyOn(stack, "ensureCatalog").mockResolvedValue(undefined);
    jest.spyOn(stack.router, "route").mockRejectedValue(new RateLimitError("busy"));
    const primary = jest.spyOn(stack.provider, "chat").mockResolvedValue(reply);

    const result = await stack.routeWithFallback("coding", CHAT);

    expect(result.message.content).toBe("from primary");
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it("sends the primary's chat through its dispatcher lane without pinning a model of its own", async () => {
    const stack = new ModelStack(cloudCfg(), () => {});
    const primary = jest.spyOn(stack.provider, "chat").mockResolvedValue(reply);

    const result = await stack.primaryChat(CHAT);

    expect(result.message.content).toBe("from primary");
    expect(primary).toHaveBeenCalledWith(CHAT, {});
    expect(result.routedTier).toBe("cloud");
    expect(result.routedModel).toBe("gpt-oss:120b-cloud");
  });
});
