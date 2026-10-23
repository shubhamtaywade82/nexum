import { Provider } from "../../src/models/adapters/provider.js";
import { ModelCatalog } from "../../src/models/catalog.js";
import { budgetForProfile } from "../../src/models/profiles/context-budget.js";
import { profileFromLegacy } from "../../src/models/profiles/model-profile.js";

describe("native context window discovery", () => {
  it("records the local server's native window on the catalog entry, from the same /api/show call", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const catalog = new ModelCatalog(local);
    jest
      .spyOn(local, "availableModels")
      .mockResolvedValue({ models: [{ name: "qwen3:8b", capabilities: ["completion", "tools"] }] });
    const show = jest.spyOn(local, "showModel").mockResolvedValue({ contextLength: 8_192 });

    const infos = await catalog.refresh();

    expect(show).toHaveBeenCalledWith("qwen3:8b");
    expect(infos.find((i) => i.name === "qwen3:8b")?.contextLength).toBe(8_192);
  });

  it("leaves contextLength unset when the server reports no window", async () => {
    const local = new Provider({ tier: "local", model: "x" });
    const catalog = new ModelCatalog(local);
    jest
      .spyOn(local, "availableModels")
      .mockResolvedValue({ models: [{ name: "tiny:1b", capabilities: ["completion", "tools"] }] });
    jest.spyOn(local, "showModel").mockResolvedValue({ capabilities: ["completion", "tools"] });

    const infos = await catalog.refresh();

    expect(infos.find((i) => i.name === "tiny:1b")).not.toHaveProperty("contextLength");
  });

  it("bounds the turn budget by the discovered window instead of the 128k default", () => {
    const sized = profileFromLegacy({ name: "small", tier: "local", capabilities: ["quick"], contextLength: 8_192 });
    const unsized = profileFromLegacy({ name: "unknown", tier: "local", capabilities: ["quick"] });

    expect(sized.constraints.contextWindow).toBe(8_192);
    expect(unsized.constraints.contextWindow).toBe(128_000);
    expect(budgetForProfile(sized).contextTokens).toBeLessThanOrEqual(8_192);
  });
});
