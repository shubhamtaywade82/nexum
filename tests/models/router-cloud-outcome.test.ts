import {
  Provider,
  ChatResponse,
  RateLimitError,
  OutcomeUnknownError,
  TransportFailure,
} from "../../src/models/adapters/provider.js";
import { ModelCatalog } from "../../src/models/catalog.js";
import { Router } from "../../src/models/router/router.js";

const okResponse = (content: string): ChatResponse => ({
  message: { role: "assistant", content },
  done: true,
});

/** A local provider and a cloud provider with two cloud models, so the cloud fallback has a second candidate. */
async function setup(preferredTier: "local" | "cloud" = "local") {
  const local = new Provider({ tier: "local", model: "x" });
  const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
  const catalog = new ModelCatalog(local, cloud, undefined, preferredTier);
  jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }] });
  jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:8b" }, { id: "qwen3.5:14b" }] });
  await catalog.refresh();
  const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });
  return { local, cloud, router };
}

const CHAT = [{ role: "user" as const, content: "hi" }];

describe("Router: a cloud request that may have run is never retried on another paid candidate", () => {
  it("after a cloud outcome is unknown, no second cloud candidate is called and the unknown error surfaces", async () => {
    const { local, cloud, router } = await setup("local");
    jest.spyOn(local, "chat").mockRejectedValue(new TransportFailure("Ollama local unreachable"));
    const cloudChat = jest.spyOn(cloud, "chat").mockRejectedValue(new OutcomeUnknownError("cloud timed out"));

    await expect(router.route("coding", CHAT)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(cloudChat).toHaveBeenCalledTimes(1);
  });

  it("a local candidate that runs after a cloud outcome is unknown still answers the request", async () => {
    const { local, cloud, router } = await setup("cloud");
    const cloudChat = jest.spyOn(cloud, "chat").mockRejectedValue(new OutcomeUnknownError("cloud timed out"));
    const localChat = jest.spyOn(local, "chat").mockResolvedValue(okResponse("from local"));

    const result = await router.route("coding", CHAT);

    expect(result.message.content).toBe("from local");
    expect(result.routedTier).toBe("local");
    expect(cloudChat).toHaveBeenCalledTimes(1);
    expect(localChat).toHaveBeenCalledTimes(1);
  });

  it("a cloud TypeError counts as unknown too: it can only surface after the request left", async () => {
    const { cloud, router, local } = await setup("local");
    jest.spyOn(local, "chat").mockRejectedValue(new TransportFailure("Ollama local unreachable"));
    const cloudChat = jest
      .spyOn(cloud, "chat")
      .mockRejectedValueOnce(new TypeError("cannot read properties of undefined"))
      .mockResolvedValueOnce(okResponse("from second cloud"));

    await expect(router.route("coding", CHAT)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(cloudChat).toHaveBeenCalledTimes(1);
  });

  it("a pre-execution cloud failure (rate limited) still fails over to the next cloud candidate", async () => {
    const { local, cloud, router } = await setup("local");
    jest.spyOn(local, "chat").mockRejectedValue(new TransportFailure("Ollama local unreachable"));
    const cloudChat = jest
      .spyOn(cloud, "chat")
      .mockRejectedValueOnce(new RateLimitError("busy"))
      .mockResolvedValueOnce(okResponse("from second cloud"));

    const result = await router.route("coding", CHAT);

    expect(result.message.content).toBe("from second cloud");
    expect(cloudChat).toHaveBeenCalledTimes(2);
  });
});
