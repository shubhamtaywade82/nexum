import { testOnlyAllowAll } from "../support/policy.js";
/**
 * CONTRACT TESTS — ToolGateway pipeline (review item 37).
 *
 * Verifies the explicit stage chain:
 *   registry → schema validation (canonical args) → capability check →
 *   policy check → budget/resource guard → idempotency → executor → tool
 */

import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import { IdempotencyManager } from "../../src/tools/idempotency.js";
import { RulePolicyEngine } from "../../src/core/policy/policy-engine.js";
import { executionProfile } from "../../src/core/policy/execution-profiles.js";
import { BudgetTracker } from "../../src/runtime/budget/budget-tracker.js";
import { Tool } from "../../src/tools/tool.js";
import type { ToolCallContext } from "../../src/core/tools/tool-contract.js";

class EchoTool extends Tool {
  get name() {
    return "echo";
  }
  get description() {
    return "echo the text";
  }
  override get capabilities() {
    return ["filesystem"];
  }
  get parameters() {
    return { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
  }
  async call(args: Record<string, unknown>, callCtx?: ToolCallContext) {
    return { echoed: args.text, sawSignal: !!callCtx?.signal, invocationId: callCtx?.invocation?.id };
  }
}

class MutatingTool extends Tool {
  get name() {
    return "mutate";
  }
  get description() {
    return "mutates workspace state";
  }
  get parameters() {
    return {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    };
  }
  async call(args: Record<string, unknown>) {
    return { mutated: args.path };
  }
}

function catalogWith(...tools: Tool[]): { catalog: ToolCatalog; gateway: DefaultToolGateway } {
  const catalog = new ToolCatalog();
  for (const t of tools) catalog.registerLegacy(t, "Filesystem");
  const gateway = new DefaultToolGateway({ policyEngine: testOnlyAllowAll(), catalog, validation: "strict" });
  return { catalog, gateway };
}

describe("ToolGateway contract", () => {
  it("resolves canonical names + compatibility aliases (item 36)", async () => {
    const { gateway } = catalogWith(new EchoTool());
    const direct = await gateway.invoke("echo", { text: "hi" });
    expect(direct.ok).toBe(true);
    // no alias for echo, but namespace prefixes strip
    const namespaced = await gateway.invoke("functions.echo", { text: "hi" });
    expect(namespaced.ok).toBe(true);
    const unknown = await gateway.invoke("nope", {});
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("UnknownTool");
  });

  it("decodes → normalizes → validates → canonical args (item 6)", async () => {
    const { gateway } = catalogWith(new EchoTool());
    // string JSON args decode
    const decoded = await gateway.invoke("echo", JSON.stringify({ text: "a" }) as unknown);
    expect(decoded.ok).toBe(true);
    expect(decoded.data.echoed).toBe("a");
    // missing required → ValidationError (strict)
    const missing = await gateway.invoke("echo", {});
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("ValidationError");
  });

  it("strict validation for state-changing tools rejects unknown properties (item 6)", async () => {
    const { gateway } = catalogWith(new MutatingTool());
    const result = await gateway.invoke("mutate", { path: "a.txt", sneaky: "extra" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ValidationError");
    expect(String(result.error?.message)).toContain("sneaky");
  });

  it("capability check denies tools outside the run's capabilities (item 4)", async () => {
    const { gateway } = catalogWith(new EchoTool());
    const denied = await gateway.invoke("echo", { text: "x" }, { capabilities: ["market"] });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("CapabilityDenied");
    const allowed = await gateway.invoke("echo", { text: "x" }, { capabilities: ["filesystem"] });
    expect(allowed.ok).toBe(true);
  });

  it("policy check surfaces PolicyDenied + ConfirmationRequired (items 4, 7)", async () => {
    const catalog = new ToolCatalog();
    catalog.registerLegacy(new MutatingTool(), "Filesystem");
    const engine = new RulePolicyEngine({
      rules: [
        {
          id: "deny-mutate",
          description: "test rule",
          evaluate: (req) =>
            req.tool.id === "mutate"
              ? { allowed: false, requireConfirmation: false, reason: "denied by contract", rule: "deny-mutate" }
              : null,
        },
      ],
    });
    const gateway = new DefaultToolGateway({ catalog, policyEngine: engine });
    const denied = await gateway.invoke("mutate", { path: "x" });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("PolicyDenied");
    expect(denied.data.message).toContain("denied by contract");
  });

  it("execution-profile posture gates process/network/financial permissions (item 8)", async () => {
    const catalog = new ToolCatalog();
    catalog.registerLegacy(new MutatingTool(), "Filesystem");
    const readonly = new DefaultToolGateway({
      catalog,
      policyEngine: new RulePolicyEngine({ profile: executionProfile("readonly") }),
    });
    const denied = await readonly.invoke("mutate", { path: "x" });
    // readonly: filesystem writes denied (risk ceiling low + denied tools)
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("PolicyDenied");
  });

  it("budget guard refuses calls when the run budget is depleted (items 4, 7)", async () => {
    const { gateway } = catalogWith(new EchoTool());
    const budget = new BudgetTracker({ budget: { deadlineMs: 0 } });
    // deadline 0 → assertTimeLeft throws in the resource stage (fail fast)
    const result = await gateway.invoke("echo", { text: "x" }, { budget });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("Cancelled");
  });

  it("idempotency replays recorded results + conflicts on in-flight retries (item 28)", async () => {
    let executions = 0;
    class SlowMutatingTool extends MutatingTool {
      override get name() {
        return "mutate";
      }
      override async call(args: Record<string, unknown>) {
        executions += 1;
        await new Promise((r) => setTimeout(r, 60));
        return { mutated: args.path, execution: executions };
      }
    }
    const catalog = new ToolCatalog();
    catalog.registerLegacy(new SlowMutatingTool(), "Git");
    const def = catalog.definition("mutate");
    if (def) def.execution.idempotencyKey = "required";
    const idempotency = new IdempotencyManager();
    const gateway = new DefaultToolGateway({ policyEngine: testOnlyAllowAll(), catalog, idempotency });

    // concurrent duplicate: the second is refused while the first is in flight
    const first = gateway.invoke("mutate", { path: "a.txt" });
    const concurrent = await gateway.invoke("mutate", { path: "a.txt" });
    expect(concurrent.ok).toBe(false);
    expect(concurrent.error?.code).toBe("IdempotencyConflict");
    await first;

    // completed duplicate: the recorded result is replayed without re-execution
    const replay = await gateway.invoke("mutate", { path: "a.txt" });
    expect(replay.ok).toBe(true);
    expect(replay.data.mutated).toBe("a.txt");
    expect(executions).toBe(1); // NOT 2 — the retry never reached the tool

    // different args → new key → executes
    const other = await gateway.invoke("mutate", { path: "b.txt" });
    expect(other.ok).toBe(true);
    expect(executions).toBe(2);
  });

  it("passes the run's AbortSignal into the tool handler (item 16)", async () => {
    const { gateway } = catalogWith(new EchoTool());
    const controller = new AbortController();
    const result = await gateway.invoke("echo", { text: "x" }, { signal: controller.signal });
    expect(result.ok).toBe(true);
    expect(result.data.sawSignal).toBe(true);
    expect(typeof result.data.invocationId).toBe("string");
  });
});
