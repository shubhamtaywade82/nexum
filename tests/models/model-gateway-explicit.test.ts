import { describe, it, expect } from "@jest/globals";
import { Provider, ProviderError, type ChatResponse } from "../../src/models/adapters/provider.js";
import { ModelCatalog } from "../../src/models/catalog.js";
import { DefaultModelGateway } from "../../src/models/gateway/model-gateway.js";
import { InferenceDispatcher } from "../../src/models/gateway/inference-dispatcher.js";
import { Router } from "../../src/models/router/router.js";

const CHAT = [{ role: "user" as const, content: "hi" }];
const reply: ChatResponse = { message: { role: "assistant", content: "ok" }, done: true };

async function localCatalogWith(model: string, provider: Provider): Promise<ModelCatalog> {
  jest.spyOn(provider, "availableModels").mockResolvedValue({ models: [{ name: model }] });
  const catalog = new ModelCatalog(provider);
  await catalog.refresh();
  return catalog;
}

describe("DefaultModelGateway.routeToModel", () => {
  it("pins the requested model instead of the router's own candidate", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const catalog = await localCatalogWith("qwen3:8b", local);
    const chat = jest.spyOn(local, "chat").mockResolvedValue(reply);
    const router = new Router({ local, catalog, logger: { warn: jest.fn() } });
    const dispatcher = new InferenceDispatcher({ lanes: { "catalog.local": local } });
    const gateway = new DefaultModelGateway({ router, catalog, dispatcher });

    await gateway.routeToModel("qwen3:14b", "local", CHAT);

    expect(chat).toHaveBeenCalledWith(CHAT, expect.objectContaining({ model: "qwen3:14b" }));
  });

  it("refuses an explicit model when the gateway has no dispatcher", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const catalog = await localCatalogWith("qwen3:8b", local);
    const gateway = new DefaultModelGateway({ router: new Router({ local, catalog }), catalog });

    await expect(gateway.routeToModel("qwen3:14b", "local", CHAT)).rejects.toThrow(/no dispatcher/);
  });

  it("refuses a tier that has no catalog lane instead of sending the call elsewhere", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const catalog = await localCatalogWith("qwen3:8b", local);
    const gateway = new DefaultModelGateway({
      router: new Router({ local, catalog }),
      catalog,
      dispatcher: new InferenceDispatcher({ lanes: { "catalog.local": local } }),
    });

    await expect(gateway.routeToModel("big:cloud", "cloud", CHAT)).rejects.toBeInstanceOf(ProviderError);
  });
});
