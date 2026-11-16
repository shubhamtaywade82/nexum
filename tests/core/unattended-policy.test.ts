import { describe, it, expect } from "@jest/globals";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";
import { RulePolicyEngine } from "../../src/core/policy/policy-engine.js";
import {
  withUnattendedPolicy,
  DENY_ALL_UNATTENDED,
  applyUnattendedCeilings,
  UNATTENDED_CEILINGS,
} from "../../src/core/policy/unattended-policy.js";
import { createExecutionContext } from "../../src/runtime/context/execution-context.js";
import { CLI_UNATTENDED_POLICY } from "../../src/cli/agent-tools.js";
import { parityPosture } from "../../src/core/policy/postures.js";
import type { PolicyEngine } from "../../src/core/policy/policy-engine.js";
import type { UnattendedPolicy } from "../../src/core/policy/unattended-policy.js";
import type { ToolDefinition, ToolRisk } from "../../src/core/tools/tool-contract.js";
import { budgetContextOf } from "../../src/core/tools/invocation-context.js";
import { BudgetTracker } from "../../src/runtime/budget/budget-tracker.js";

interface Spec {
  risk?: ToolRisk;
  mutating?: boolean;
  process?: boolean;
  isolation?: "sandbox" | "host";
  network?: boolean;
  externalMutation?: boolean;
}

function def(id: string, s: Spec = {}): ToolDefinition {
  return {
    id,
    description: id,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, command: { type: "string" }, args: { type: "array" } },
    },
    capabilities: ["testing"],
    pack: "test",
    tags: [],
    risk: s.risk ?? "read",
    sideEffects: {
      filesystem: s.mutating === true,
      process: s.process === true,
      network: s.network === true,
      externalMutation: s.externalMutation === true,
      financial: false,
    },
    execution: {
      timeoutMs: 5_000,
      concurrency: 1,
      idempotent: true,
      reversible: true,
      ...(s.process ? { isolation: s.isolation ?? "host" } : {}),
    },
    policy: { confirmation: "optional" },
  };
}

const CEILINGS = { maxToolCalls: 10, maxModelCalls: 10, deadlineMs: 60_000 };

/** Runs one call through a gateway whose engine applies the unattended policy. */
async function callUnattended(
  policy: UnattendedPolicy,
  tool: { definition: ToolDefinition; handler?: () => Promise<Record<string, unknown>> },
  opts: {
    unattended: boolean;
    budget?: Record<string, number>;
    confirmed?: boolean;
    path?: string;
    args?: Record<string, unknown>;
    base?: PolicyEngine;
  } = {
    unattended: true,
  },
) {
  const executed: string[] = [];
  const catalog = new ToolCatalog();
  catalog.register(tool.definition, async () => {
    executed.push(tool.definition.id);
    return { ok: true };
  });
  const gateway = new DefaultToolGateway({
    catalog,
    policyEngine: withUnattendedPolicy(opts.base ?? new RulePolicyEngine(), policy),
  });
  const budget = new BudgetTracker({ runId: "r", sessionId: "s", budget: opts.budget ?? CEILINGS });
  const result = await gateway.invoke(
    tool.definition.id,
    { ...(opts.path !== undefined ? { path: opts.path } : {}), ...(opts.args ?? {}) },
    {
      runId: "r",
      agentId: "a",
      unattended: opts.unattended,
      budget: budgetContextOf(budget),
      ...(opts.confirmed ? { confirmed: true } : {}),
    },
  );
  return { result, executed };
}

describe("unattended runs are governed by an explicit policy, not by the unattended flag", () => {
  it("refuses a tool the unattended policy does not permit, even when the base engine would allow it", async () => {
    const { result, executed } = await callUnattended(
      { permittedTools: ["read_file"] },
      { definition: def("write_file", { risk: "low", mutating: true }) },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PolicyDenied");
    expect(result.error?.message).toContain("not permitted");
    expect(executed).toEqual([]);
  });

  it("escalates instead of asking: a permitted tool that needs human approval is refused", async () => {
    const { result, executed } = await callUnattended(
      { permittedTools: ["drop_table"] },
      { definition: def("drop_table", { risk: "high", mutating: true }) },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).not.toBe("ConfirmationRequired");
    expect(result.error?.message).toContain("escalation required");
    expect(executed).toEqual([]);
  });

  it("runs a permitted low-risk tool within its ceilings", async () => {
    const { result, executed } = await callUnattended(
      { permittedTools: ["read_file"] },
      { definition: def("read_file", { risk: "read" }) },
    );
    expect(result.ok).toBe(true);
    expect(executed).toEqual(["read_file"]);
  });

  it("refuses an unattended run whose budget has no ceilings", async () => {
    const { result, executed } = await callUnattended(
      { permittedTools: ["read_file"] },
      { definition: def("read_file", { risk: "read" }) },
      { unattended: true, budget: {} },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("ceilings");
    expect(executed).toEqual([]);
  });

  it("refuses host process execution unless the policy explicitly allows it", async () => {
    const { result, executed } = await callUnattended(
      { permittedTools: ["run_shell"] },
      { definition: def("run_shell", { risk: "high", process: true, isolation: "host" }) },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("host");
    expect(executed).toEqual([]);
  });

  it("allows sandboxed process execution when the tool is permitted", async () => {
    const { result, executed } = await callUnattended(
      { permittedTools: ["run_shell"] },
      { definition: def("run_shell", { risk: "medium", process: true, isolation: "sandbox" }) },
    );
    expect(result.ok).toBe(true);
    expect(executed).toEqual(["run_shell"]);
  });

  it("refuses filesystem writes outside the policy's write paths", async () => {
    const policy: UnattendedPolicy = { permittedTools: ["write_file"], writePaths: ["src/generated"] };
    const outside = await callUnattended(
      policy,
      { definition: def("write_file", { risk: "low", mutating: true }) },
      {
        unattended: true,
        path: "config/secrets.yml",
      },
    );
    expect(outside.result.ok).toBe(false);
    expect(outside.executed).toEqual([]);

    const inside = await callUnattended(
      policy,
      { definition: def("write_file", { risk: "low", mutating: true }) },
      {
        unattended: true,
        path: "src/generated/types.ts",
      },
    );
    expect(inside.result.ok).toBe(true);
  });

  it("never permits external mutation unattended, even when named", async () => {
    const { result, executed } = await callUnattended(
      { permittedTools: ["git"] },
      { definition: def("git", { risk: "low", externalMutation: true }) },
    );
    expect(result.ok).toBe(false);
    expect(executed).toEqual([]);
  });

  it("the default policy permits nothing unattended", async () => {
    const { result, executed } = await callUnattended(DENY_ALL_UNATTENDED, {
      definition: def("read_file", { risk: "read" }),
    });
    expect(result.ok).toBe(false);
    expect(executed).toEqual([]);
  });

  it("interactive runs are unchanged: a confirmation-requiring call still asks the human", async () => {
    const { result, executed } = await callUnattended(
      { permittedTools: [] },
      { definition: def("drop_table", { risk: "high", mutating: true }) },
      { unattended: false },
    );
    expect(result.error?.code).toBe("ConfirmationRequired");
    expect(executed).toEqual([]);
  });

  it("an approval never unlocks what the unattended policy forbids", async () => {
    const { result, executed } = await callUnattended(
      { permittedTools: [] },
      { definition: def("drop_table", { risk: "high", mutating: true }) },
      { unattended: true, confirmed: true },
    );
    expect(result.ok).toBe(false);
    expect(executed).toEqual([]);
  });
});

describe("the gateway no longer treats the unattended flag as approval", () => {
  it("a bare gateway returns ConfirmationRequired for a high-risk tool in an unattended run", async () => {
    const executed: string[] = [];
    const catalog = new ToolCatalog();
    catalog.register(def("drop_table", { risk: "high", mutating: true }), async () => {
      executed.push("drop_table");
      return { ok: true };
    });
    const gateway = new DefaultToolGateway({ catalog, policyEngine: new RulePolicyEngine() });
    const result = await gateway.invoke("drop_table", { path: "t" }, { runId: "r", agentId: "a", unattended: true });
    expect(result.error?.code).toBe("ConfirmationRequired");
    expect(executed).toEqual([]);
  });
});

describe("unattended ceilings and the CLI's own policy", () => {
  it("applies the stricter of the caller's limit and the unattended ceiling", () => {
    expect(applyUnattendedCeilings(undefined)).toMatchObject({
      maxToolCalls: UNATTENDED_CEILINGS.maxToolCalls,
      maxModelCalls: UNATTENDED_CEILINGS.maxModelCalls,
      deadlineMs: UNATTENDED_CEILINGS.deadlineMs,
    });
    expect(applyUnattendedCeilings({ maxToolCalls: 5 })).toMatchObject({ maxToolCalls: 5 });
    expect(applyUnattendedCeilings({ maxToolCalls: 1_000_000 })).toMatchObject({
      maxToolCalls: UNATTENDED_CEILINGS.maxToolCalls,
    });
  });

  it("bounds every unattended run at creation, and leaves interactive runs as the caller set them", () => {
    const request = { agentId: "a", task: { goal: "g" } };
    const common = {
      modelGateway: {} as never,
      toolGateway: new DefaultToolGateway({ catalog: new ToolCatalog(), policyEngine: new RulePolicyEngine() }),
    };
    const unattended = createExecutionContext({ ...request, unattended: true }, common);
    expect(unattended.budget.limits?.()).toMatchObject({
      maxToolCalls: UNATTENDED_CEILINGS.maxToolCalls,
      deadlineMs: UNATTENDED_CEILINGS.deadlineMs,
    });
    const interactive = createExecutionContext(request, common);
    expect(interactive.budget.limits?.()).toEqual({});
  });

  it("the CLI's unattended policy permits edits and sandboxed shell, and refuses delete and publish", async () => {
    const base = parityPosture();
    const edit = await callUnattended(
      CLI_UNATTENDED_POLICY,
      { definition: def("write_file", { risk: "low", mutating: true }) },
      { unattended: true, path: "src/index.ts", base },
    );
    expect(edit.result.ok).toBe(true);
    expect(edit.executed).toEqual(["write_file"]);

    const shell = await callUnattended(
      CLI_UNATTENDED_POLICY,
      { definition: def("run_shell", { risk: "high", process: true, isolation: "sandbox", network: true }) },
      { unattended: true, args: { command: "npm test" }, base },
    );
    expect(shell.result.ok).toBe(true);

    // A destructive command is an argument-level danger: a permission for run_shell does not cover it.
    const destructive = await callUnattended(
      CLI_UNATTENDED_POLICY,
      { definition: def("run_shell", { risk: "high", process: true, isolation: "sandbox", network: true }) },
      { unattended: true, args: { command: "rm -rf dist" }, base },
    );
    expect(destructive.result.ok).toBe(false);
    expect(destructive.result.error?.message).toContain("escalation required");
    expect(destructive.executed).toEqual([]);

    const remove = await callUnattended(
      CLI_UNATTENDED_POLICY,
      { definition: def("delete_file", { risk: "medium", mutating: true }) },
      { unattended: true, path: "src/index.ts", base },
    );
    expect(remove.result.ok).toBe(false);
    expect(remove.executed).toEqual([]);

    const publish = await callUnattended(
      CLI_UNATTENDED_POLICY,
      { definition: def("git", { risk: "high", externalMutation: true, process: true, isolation: "host" }) },
      { unattended: true, base },
    );
    expect(publish.result.ok).toBe(false);
    expect(publish.executed).toEqual([]);
  });
});
