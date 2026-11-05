import { generatePlan, replanSteps, PlanGenerationError } from "../../src/ui/plan-generator.js";
import { Provider } from "../../src/models/adapters/provider.js";
import { PlanStep, HistoryEntry } from "../../src/orchestration/types.js";

function fakeProvider(content: string) {
  return {
    chat: jest.fn().mockResolvedValue({ message: { role: "assistant", content }, done: true }),
  } as unknown as Provider;
}

describe("generatePlan", () => {
  it("parses a valid JSON step array into PlanStep[] with pending status and zero retries", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        { id: "s1", description: "create types.ts", dependencies: [] },
        { id: "s2", description: "create registry", dependencies: ["s1"] },
      ]),
    );

    const steps = await generatePlan("add a CommandRegistry", provider);

    expect(steps).toEqual([
      { id: "s1", description: "create types.ts", dependencies: [], status: "pending", retryCount: 0 },
      { id: "s2", description: "create registry", dependencies: ["s1"], status: "pending", retryCount: 0 },
    ]);
  });

  it("extracts a JSON array embedded in surrounding prose", async () => {
    const provider = fakeProvider('Here is the plan:\n[{"id":"s1","description":"do it","dependencies":[]}]\nDone.');

    const steps = await generatePlan("do it", provider);

    expect(steps).toEqual([{ id: "s1", description: "do it", dependencies: [], status: "pending", retryCount: 0 }]);
  });

  it("throws PlanGenerationError on malformed JSON, without a silent single-step fallback", async () => {
    const provider = fakeProvider("not json at all");

    await expect(generatePlan("do it", provider)).rejects.toThrow(PlanGenerationError);
  });

  it("throws PlanGenerationError when a step is missing required fields", async () => {
    const provider = fakeProvider(JSON.stringify([{ id: "s1" }]));

    await expect(generatePlan("do it", provider)).rejects.toThrow(PlanGenerationError);
  });

  it("throws PlanGenerationError when a step has non-string elements in dependencies", async () => {
    const provider = fakeProvider(JSON.stringify([{ id: "s1", description: "step one", dependencies: [1, 2, null] }]));

    await expect(generatePlan("do it", provider)).rejects.toThrow(PlanGenerationError);
  });
});

describe("replanSteps", () => {
  it("asks the model to revise the remaining steps and parses its response", async () => {
    const provider = fakeProvider(
      JSON.stringify([{ id: "s2-retry", description: "try a different approach", dependencies: [] }]),
    );
    const remaining: PlanStep[] = [
      { id: "s2", description: "original approach", status: "pending", dependencies: [], retryCount: 1 },
    ];
    const history: HistoryEntry[] = [
      { stepId: "s2", outcome: { kind: "blocking", error: "permission denied" }, at: 1 },
    ];

    const revised = await replanSteps(remaining, history, provider);

    expect(revised).toEqual([
      { id: "s2-retry", description: "try a different approach", dependencies: [], status: "pending", retryCount: 0 },
    ]);
    const [, userMessage] = (provider.chat as jest.Mock).mock.calls[0][0];
    expect(userMessage.content).toContain("permission denied");
    expect(userMessage.content).toContain("original approach");
  });

  it("throws PlanGenerationError on malformed JSON, same as generatePlan", async () => {
    const provider = fakeProvider("not json");
    await expect(replanSteps([], [], provider)).rejects.toThrow(PlanGenerationError);
  });
});

describe("generatePlan verify commands", () => {
  it("keeps a non-empty verify command and drops blank ones", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        { id: "s1", description: "fix", dependencies: [], verify: " npm test -- auth " },
        { id: "s2", description: "docs", dependencies: ["s1"], verify: "  " },
      ]),
    );
    const steps = await generatePlan("fix auth", provider);
    expect(steps[0].verify).toBe("npm test -- auth");
    expect(steps[1]).not.toHaveProperty("verify");
  });
});
