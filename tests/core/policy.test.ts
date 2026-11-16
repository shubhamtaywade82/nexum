import {
  AllowAllPolicyEngine,
  ConfirmationRule,
  DenyRiskAboveRule,
  DenyToolsRule,
  ModeRestrictionRule,
  RulePolicyEngine,
} from "../../src/core/policy/policy-engine.js";
import { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import { classifyApprovalNeeded, ApprovalBroker } from "../../src/core/policy/approval-broker.js";

function def(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "tool",
    description: "test tool",
    inputSchema: {},
    capabilities: [],
    pack: "test",
    tags: [],
    risk: "read",
    sideEffects: { filesystem: false, process: false, network: false, externalMutation: false, financial: false },
    execution: { timeoutMs: 1_000, concurrency: 1, idempotent: true, reversible: true },
    policy: { confirmation: "never" },
    ...overrides,
  };
}

const req = (tool: ToolDefinition, opts: { mode?: string } = {}) => ({
  tool,
  args: {},
  agentId: "devagent",
  runId: "run_1",
  ...opts,
});

describe("RulePolicyEngine", () => {
  it("allows read tools by default", () => {
    const engine = new RulePolicyEngine();
    const decision = engine.check(req(def()));
    expect(decision.allowed).toBe(true);
    expect(decision.requireConfirmation).toBe(false);
  });

  it("denies listed tools", () => {
    const engine = new RulePolicyEngine({ deniedToolIds: ["tool"] });
    const decision = engine.check(req(def()));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("deny-tools");
  });

  it("denies tools at or above the risk ceiling", () => {
    const engine = new RulePolicyEngine({ denyRiskAbove: "medium" });
    expect(engine.check(req(def({ risk: "high" }))).allowed).toBe(false);
    expect(engine.check(req(def({ risk: "low" }))).allowed).toBe(true);
  });

  it("blocks mutating tools in read-only modes", () => {
    const engine = new RulePolicyEngine();
    const mutating = def({
      sideEffects: { filesystem: true, process: false, network: false, externalMutation: false, financial: false },
    });
    expect(engine.check(req(mutating, { mode: "ask" })).allowed).toBe(false);
    expect(engine.check(req(mutating, { mode: "code" })).allowed).toBe(true);
  });

  it("requires confirmation for high-risk tools and financial side effects", () => {
    const engine = new RulePolicyEngine();
    const high = engine.check(req(def({ risk: "high", policy: { confirmation: "optional" } })));
    expect(high.requireConfirmation).toBe(true);

    const financial = engine.check(
      req(
        def({
          risk: "read",
          sideEffects: { filesystem: false, process: false, network: true, externalMutation: false, financial: true },
        }),
      ),
    );
    expect(financial.requireConfirmation).toBe(true);
  });

  it("respects the confirmation floor option", () => {
    const engine = new RulePolicyEngine({ requireConfirmationFor: "critical" });
    expect(engine.check(req(def({ risk: "high", policy: { confirmation: "optional" } }))).requireConfirmation).toBe(
      false,
    );
    expect(engine.check(req(def({ risk: "critical", policy: { confirmation: "optional" } }))).requireConfirmation).toBe(
      true,
    );
  });
});

describe("individual rules", () => {
  it("DenyToolsRule only matches listed ids", () => {
    const rule = new DenyToolsRule(["a", "b"]);
    expect(rule.evaluate(req(def({ id: "a" })))?.rule).toBe("deny-tools");
    expect(rule.evaluate(req(def({ id: "c" })))).toBeNull();
  });

  it("DenyRiskAboveRule compares the ladder positionally", () => {
    const rule = new DenyRiskAboveRule("medium");
    expect(rule.evaluate(req(def({ risk: "medium" })))?.rule).toBe("deny-risk-above");
    expect(rule.evaluate(req(def({ risk: "critical" })))).not.toBeNull();
    expect(rule.evaluate(req(def({ risk: "low" })))).toBeNull();
  });

  it("ModeRestrictionRule ignores read-only tools", () => {
    const rule = new ModeRestrictionRule();
    expect(rule.evaluate(req(def(), { mode: "ask" }))).toBeNull();
  });

  it("ConfirmationRule skips tools marked confirmation: never", () => {
    const rule = new ConfirmationRule("low");
    expect(rule.evaluate(req(def({ risk: "critical", policy: { confirmation: "never" } })))).toBeNull();
  });
  it("AllowAllPolicyEngine always allows", () => {
    expect(
      new AllowAllPolicyEngine({
        acknowledgeNoPolicy: true,
        reason: "policy.test: asserts the allow-all engine itself",
      }).check(req(def({ risk: "critical" }))).allowed,
    ).toBe(true);
  });
});

describe("classifyApprovalNeeded", () => {
  it("classifies delete_file", () => {
    const result = classifyApprovalNeeded("delete_file", { path: "src/a.ts" });
    expect(result?.title).toContain("src/a.ts");
  });

  it("classifies destructive shell commands but not benign ones", () => {
    expect(classifyApprovalNeeded("run_shell", { command: "rm -rf /" })).not.toBeNull();
    expect(classifyApprovalNeeded("run_shell", { command: "ls -la" })).toBeNull();
  });

  it("classifies git push and github pr create", () => {
    expect(classifyApprovalNeeded("git", { args: ["push", "origin", "main"] })).not.toBeNull();
    expect(classifyApprovalNeeded("github", { args: ["pr", "create"] })).not.toBeNull();
    expect(classifyApprovalNeeded("git", { args: ["status"] })).toBeNull();
  });
});

describe("ApprovalBroker", () => {
  it("auto-approves when configured", async () => {
    const broker = new ApprovalBroker(true);
    let asked = false;
    broker.setResponder(async () => {
      asked = true;
      return false;
    });
    await expect(broker.request({ title: "t", summary: "s", tool: "x" })).resolves.toBe(true);
    expect(asked).toBe(false);
  });

  it("returns true with no responder (headless contract)", async () => {
    const broker = new ApprovalBroker(false);
    await expect(broker.request({ title: "t", summary: "s", tool: "x" })).resolves.toBe(true);
  });

  it("resolves through the responder", async () => {
    const broker = new ApprovalBroker(false);
    broker.setResponder(async (request) => request.tool === "allowed");
    await expect(broker.request({ title: "t", summary: "s", tool: "allowed" })).resolves.toBe(true);
    await expect(broker.request({ title: "t", summary: "s", tool: "denied" })).resolves.toBe(false);
  });

  it("resolveAll resolves pending requests with the given verdict", async () => {
    const broker = new ApprovalBroker(false);
    broker.setResponder(() => new Promise<boolean>(() => undefined)); // never resolves
    const pending = broker.request({ title: "t", summary: "s", tool: "x" });
    broker.resolveAll(true);
    await expect(pending).resolves.toBe(true);
    expect(broker.pendingCount()).toBe(0);
  });

  it("treats responder errors as rejection", async () => {
    const broker = new ApprovalBroker(false);
    broker.setResponder(async () => {
      throw new Error("ui exploded");
    });
    await expect(broker.request({ title: "t", summary: "s", tool: "x" })).resolves.toBe(false);
  });
});
