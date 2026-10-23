import { builtinCommands } from "../../src/interaction/slash-commands.js";

describe("/usage", () => {
  const usage = builtinCommands().find("usage");

  it("accepts a window and the per-model flag in either order", () => {
    expect(usage?.execute("")).toEqual({ kind: "usage" });
    expect(usage?.execute("7d")).toEqual({ kind: "usage", range: "7d" });
    expect(usage?.execute("model")).toEqual({ kind: "usage", groupBy: "model" });
    expect(usage?.execute("30d model")).toEqual({ kind: "usage", range: "30d", groupBy: "model" });
    expect(usage?.execute("model 24h")).toEqual({ kind: "usage", range: "24h", groupBy: "model" });
  });

  it("rejects unknown tokens with the usage line", () => {
    const error = { kind: "error", text: "Usage: /usage [24h|7d|30d] [model]" };
    expect(usage?.execute("1y")).toEqual(error);
    expect(usage?.execute("model bogus")).toEqual(error);
  });
});

describe("/pull", () => {
  const pull = builtinCommands().find("pull");

  it("takes one model reference", () => {
    expect(pull?.execute("qwen3:8b")).toEqual({ kind: "pull", model: "qwen3:8b" });
    expect(pull?.execute("  llama3.2:3b  ")).toEqual({ kind: "pull", model: "llama3.2:3b" });
  });

  it("rejects a missing or multi-word reference", () => {
    const error = { kind: "error", text: "Usage: /pull <model>" };
    expect(pull?.execute("")).toEqual(error);
    expect(pull?.execute("qwen3 8b")).toEqual(error);
  });
});
