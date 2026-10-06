import { budgetForProfile, sizeClassFor, CHARS_PER_TOKEN } from "../../src/models/profiles/context-budget.js";
import { defaultConstraints, type ModelProfile } from "../../src/models/profiles/model-profile.js";
import type { Capability } from "../../src/models/catalog.js";

function profile(
  id: string,
  opts: { tier?: "local" | "cloud"; caps?: Capability[]; constraints?: Parameters<typeof defaultConstraints>[0] } = {},
): ModelProfile {
  return {
    id,
    provider: "ollama",
    tier: opts.tier ?? "local",
    capabilities: { reasoning: 0, coding: 0, vision: 0, toolCalling: 1, structuredOutput: 0.5, streaming: true },
    constraints: defaultConstraints(opts.constraints),
    legacyCapabilities: opts.caps ?? [],
  };
}

describe("budgetForProfile", () => {
  it("gives a quick-tier model a small budget despite a 128K window", () => {
    const b = budgetForProfile(profile("minicpm5:2b", { caps: ["quick", "tools"] }));
    expect(b.sizeClass).toBe("small");
    expect(b.contextTokens).toBe(8_000);
    expect(b.contextChars).toBe(8_000 * CHARS_PER_TOKEN);
    expect(b.toolBudget).toBe(6);
    expect(b.reasoning).toBe("low");
  });

  it("classifies local non-quick as standard and cloud as frontier", () => {
    expect(sizeClassFor(profile("qwen2.5-coder:14b", { caps: ["coding"] }))).toBe("standard");
    expect(sizeClassFor(profile("gpt-oss:120b-cloud", { tier: "cloud", caps: ["reasoning"] }))).toBe("frontier");
    expect(budgetForProfile(profile("big", { tier: "cloud" })).toolBudget).toBe(20);
  });

  it("treats a fast latency class as small even without the quick tag", () => {
    expect(sizeClassFor(profile("x", { constraints: { latencyClass: "fast" } }))).toBe("small");
  });

  it("honours profile constraints, then overrides on top", () => {
    const p = profile("m", { constraints: { preferredContextTokens: 12_000, maxToolCount: 4 } });
    expect(budgetForProfile(p)).toMatchObject({ contextTokens: 12_000, toolBudget: 4 });
    expect(budgetForProfile(p, { contextTokens: 3_000, toolBudget: 2, reasoning: "high" })).toMatchObject({
      contextTokens: 3_000,
      toolBudget: 2,
      reasoning: "high",
    });
  });

  it("clamps the budget to the context window minus the output reserve", () => {
    const b = budgetForProfile(profile("tiny-window", { tier: "cloud", constraints: { contextWindow: 16_384 } }));
    expect(b.reserveOutputTokens).toBe(4_096);
    expect(b.contextTokens).toBe(16_384 - 4_096);
  });

  it("caps the output reserve at half the window for very small windows", () => {
    const b = budgetForProfile(profile("w", { constraints: { contextWindow: 4_096, maxOutputTokens: 8_192 } }));
    expect(b.reserveOutputTokens).toBe(2_048);
    expect(b.contextTokens).toBe(2_048);
  });

  it("never drops below the floor", () => {
    const b = budgetForProfile(profile("w", { constraints: { contextWindow: 1_000 } }), { contextTokens: 10 });
    expect(b.contextTokens).toBe(1_024);
  });

  it("rejects non-positive or non-finite inputs", () => {
    expect(() => budgetForProfile(profile("m"), { contextTokens: 0 })).toThrow(RangeError);
    expect(() => budgetForProfile(profile("m"), { toolBudget: -1 })).toThrow(RangeError);
    expect(() => budgetForProfile(profile("m", { constraints: { contextWindow: Number.NaN } }))).toThrow(RangeError);
  });
});
