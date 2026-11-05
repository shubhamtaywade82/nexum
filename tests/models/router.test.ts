import {
  Provider,
  RateLimitError,
  ProviderError,
  ChatResponse,
  PaymentRequiredError,
  TransportFailure,
} from "../../src/models/adapters/provider.js";
import { ModelCatalog } from "../../src/models/catalog.js";
import { Router } from "../../src/models/router/router.js";

const okResponse = (content: string): ChatResponse => ({
  message: { role: "assistant", content },
  done: true,
});

describe("Router.route", () => {
  it("picks a local candidate for the requested capability", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    const catalog = new ModelCatalog(local, cloud);

    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }] });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:8b" }] });
    await catalog.refresh();

    const localChat = jest.spyOn(local, "chat").mockResolvedValue(okResponse("hi"));
    const cloudChat = jest.spyOn(cloud, "chat");

    const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });
    const result = await router.route("coding", [{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("hi");
    expect(localChat).toHaveBeenCalled();
    expect(cloudChat).not.toHaveBeenCalled();
    // The candidate is passed per-request; the Provider's own configured model
    // is deliberately left alone, so concurrent routes through the same
    // instance can't clobber each other (see the concurrency test below).
    expect(localChat).toHaveBeenCalledWith(
      [{ role: "user", content: "hi" }],
      expect.objectContaining({ model: "qwen3:8b" }),
    );
    expect(local.currentModel).toBe("x");
    // Stamped so callers can know which candidate actually served the
    // request, since the candidate pool can silently widen past whatever
    // capability was originally requested (see the tool-capability-widening
    // tests below) — this locks in that contract for the simple case too.
    expect(result.routedTier).toBe("local");
    expect(result.routedModel).toBe("qwen3:8b");
  });

  it("falls back to the next candidate on a recoverable error", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    const catalog = new ModelCatalog(local, cloud);

    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }] });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:8b" }] });
    await catalog.refresh();

    jest.spyOn(local, "chat").mockRejectedValue(new RateLimitError("busy"));
    jest.spyOn(cloud, "chat").mockResolvedValue(okResponse("from cloud"));

    const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });
    const result = await router.route("coding", [{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("from cloud");
  });

  it("rethrows non-recoverable errors without trying other candidates", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    const catalog = new ModelCatalog(local, cloud);

    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }] });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:8b" }] });
    await catalog.refresh();

    jest.spyOn(local, "chat").mockRejectedValue(new ProviderError("bad request"));
    const cloudChat = jest.spyOn(cloud, "chat");

    const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });

    await expect(router.route("coding", [{ role: "user", content: "hi" }])).rejects.toThrow(ProviderError);
    expect(cloudChat).not.toHaveBeenCalled();
  });

  it("excludes a tool-incapable local candidate when this turn sends tool schemas, using cloud instead (regression: gemma3-4b-gab picked for a tool-calling turn and rejected with a 400)", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    const catalog = new ModelCatalog(local, cloud);

    // Local model reports real capabilities via /api/tags — no "tools" here.
    jest.spyOn(local, "availableModels").mockResolvedValue({
      models: [{ name: "gemma3-4b-gab", capabilities: ["completion"], details: { parameter_size: "4B" } }],
    });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:8b" }] });
    await catalog.refresh();

    const localChat = jest.spyOn(local, "chat");
    jest.spyOn(cloud, "chat").mockResolvedValue(okResponse("from cloud"));

    const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });
    const result = await router.route("quick", [{ role: "user", content: "hi" }], {
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: {} } }],
    });

    expect(result.message.content).toBe("from cloud");
    expect(localChat).not.toHaveBeenCalled();
    // The whole point: capability "quick" was requested, but tool-capability
    // widening silently resolved to cloud — routedTier/routedModel must
    // reflect that real outcome, not the originally-requested capability.
    expect(result.routedTier).toBe("cloud");
    expect(result.routedModel).toBe("qwen3.5:8b");
  });

  it("does not filter by tools capability when this turn sends no tool schemas", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const catalog = new ModelCatalog(local);
    jest.spyOn(local, "availableModels").mockResolvedValue({
      models: [{ name: "gemma3-4b-gab", capabilities: ["completion"], details: { parameter_size: "4B" } }],
    });
    await catalog.refresh();

    const localChat = jest.spyOn(local, "chat").mockResolvedValue(okResponse("hi"));
    const router = new Router({ local, catalog, logger: { warn: jest.fn() } });
    const result = await router.route("quick", [{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("hi");
    expect(localChat).toHaveBeenCalled();
  });

  it("treats a 'does not support tools' ProviderError as recoverable and falls through", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    const catalog = new ModelCatalog(local, cloud);

    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }] });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:8b" }] });
    await catalog.refresh();

    jest
      .spyOn(local, "chat")
      .mockRejectedValue(new ProviderError('Ollama local 400: {"error":"model does not support tools"}'));
    jest.spyOn(cloud, "chat").mockResolvedValue(okResponse("from cloud"));

    const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });
    const result = await router.route("coding", [{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("from cloud");
  });

  it("treats a subscription-required ProviderError as recoverable and falls through to the next cloud candidate", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    const catalog = new ModelCatalog(local, cloud);

    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [] });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({
      data: [{ id: "llama3.3:70b" }, { id: "qwen3.5:8b" }],
    });
    await catalog.refresh();

    const cloudChat = jest
      .spyOn(cloud, "chat")
      .mockRejectedValueOnce(new ProviderError("Ollama cloud 403: subscription required for llama3.3:70b"))
      .mockResolvedValueOnce(okResponse("from second cloud model"));

    const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });
    const result = await router.route("coding", [{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("from second cloud model");
    expect(cloudChat).toHaveBeenCalledTimes(2);
  });

  it("throws when no model in the catalog has the requested capability", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const catalog = new ModelCatalog(local);
    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [] });
    await catalog.refresh();

    const router = new Router({ local, catalog, logger: { warn: jest.fn() } });

    await expect(router.route("vision", [{ role: "user", content: "hi" }])).rejects.toThrow(/no model available/);
  });

  it("falls back to any cloud model for 'quick' when no local model is available at all (e.g. a local finetune not pulled/unreachable)", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    const catalog = new ModelCatalog(local, cloud);

    // Local Ollama unreachable/empty — no "quick"-tagged (or any) local candidate.
    jest.spyOn(local, "availableModels").mockRejectedValue(new Error("ECONNREFUSED"));
    // Cloud has only a large model, not name-matched as "quick" by inferCapabilities.
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:32b" }] });
    await catalog.refresh();

    const localChat = jest.spyOn(local, "chat");
    const cloudChat = jest.spyOn(cloud, "chat").mockResolvedValue(okResponse("from cloud"));

    const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });
    const result = await router.route("quick", [{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("from cloud");
    expect(localChat).not.toHaveBeenCalled();
    expect(cloudChat).toHaveBeenCalled();
  });

  it("still throws for 'quick' when neither local nor cloud has any candidate", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const catalog = new ModelCatalog(local);
    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [] });
    await catalog.refresh();

    const router = new Router({ local, catalog, logger: { warn: jest.fn() } });

    await expect(router.route("quick", [{ role: "user", content: "hi" }])).rejects.toThrow(/no model available/);
  });

  it("prefers a local 'quick' candidate over cloud when one is actually available", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    const catalog = new ModelCatalog(local, cloud);

    jest.spyOn(local, "availableModels").mockResolvedValue({
      models: [{ name: "minicpm5-1b", capabilities: ["completion", "tools"], details: { parameter_size: "1B" } }],
    });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:32b" }] });
    await catalog.refresh();

    const localChat = jest.spyOn(local, "chat").mockResolvedValue(okResponse("from local"));
    const cloudChat = jest.spyOn(cloud, "chat");

    const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });
    const result = await router.route("quick", [{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("from local");
    expect(cloudChat).not.toHaveBeenCalled();
    expect(localChat).toHaveBeenCalled();
  });
});

// Router used to call provider.setModel(candidate) and then await chat(), so
// model selection lived in shared instance state across an await point. Two
// concurrent routes through the same Provider (the fire-and-forget
// summarization racing the next turn, or parallel plan steps) overwrote each
// other: both requests went to whichever model was set last, while routedModel
// reported the candidate each call had picked.
describe("Router — SDK transport and billing failures", () => {
  async function routerWithLocalAndCloud() {
    const local = new Provider({ tier: "local", model: "x" });
    const cloud = new Provider({ tier: "cloud", model: "x", apiKey: "k" });
    const catalog = new ModelCatalog(local, cloud);
    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }] });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3.5:8b" }] });
    await catalog.refresh();
    return { local, cloud, router: new Router({ local, cloud, catalog, logger: { warn: jest.fn() } }) };
  }

  it("fails over when the local candidate is unreachable (TransportFailure from OllamaNetworkError)", async () => {
    const { local, cloud, router } = await routerWithLocalAndCloud();
    jest.spyOn(local, "chat").mockRejectedValue(new TransportFailure("Ollama local unreachable"));
    jest.spyOn(cloud, "chat").mockResolvedValue(okResponse("from cloud"));

    const result = await router.route("coding", [{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("from cloud");
  });

  it("fails over when a candidate is billing-gated (PaymentRequiredError, HTTP 402)", async () => {
    const { local, cloud, router } = await routerWithLocalAndCloud();
    jest.spyOn(local, "chat").mockRejectedValue(new PaymentRequiredError("Ollama local 402: upgrade"));
    jest.spyOn(cloud, "chat").mockResolvedValue(okResponse("from cloud"));

    const result = await router.route("coding", [{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("from cloud");
  });
});

describe("Router concurrency", () => {
  it("does not let concurrent routes clobber each other's model", async () => {
    const local = new Provider({ tier: "local", model: "base" });
    const catalog = new ModelCatalog(local);
    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }, { name: "minicpm5:1b" }] });
    await catalog.refresh();

    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jest.spyOn(local, "chat").mockImplementation(async (_messages, opts) => {
      // Hold both requests open simultaneously, so a mutation-based
      // implementation is guaranteed to have overwritten the first.
      seen.push(opts?.model ?? local.currentModel);
      await gate;
      return okResponse(opts?.model ?? "");
    });

    const router = new Router({ local, catalog, logger: { warn: jest.fn() } });
    const both = Promise.all([
      router.route("quick", [{ role: "user", content: "a" }]),
      router.route("coding", [{ role: "user", content: "b" }]),
    ]);
    release();
    const [quick, coding] = await both;

    // Each request carried its own candidate...
    expect(new Set(seen).size).toBe(2);
    // ...the response content (echoing the model the request actually used)
    // matches what routedModel claims...
    expect(quick.message.content).toBe(quick.routedModel);
    expect(coding.message.content).toBe(coding.routedModel);
    // ...and the shared Provider is untouched.
    expect(local.currentModel).toBe("base");
  });
});
