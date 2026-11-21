/**
 * Package-surface smoke test — Phase 4 (RC) API-freeze prerequisite.
 *
 * Every other test in this suite imports from a deep `../../src/...` path,
 * which means removing a symbol from `src/index.ts` would not fail any test
 * (the B6 tarball audit caught exactly this with `WorkspaceManager` and 7
 * more Tier-1 symbols: defined and used internally but never re-exported
 * from the package entry, so `import { X } from "@nemesis-oss/nexum"`
 * returned undefined for consumers — yet every internal test passed).
 *
 * This suite imports from the *built* package surface. It does not assert
 * behavior (the per-symbol tests do that); it asserts PRESENCE. If a Tier-1
 * symbol named in STABILITY.md is removed or renamed at the package entry,
 * this test fails. CI runs it after `tsc` in `release:check`.
 *
 * The import path is the resolved `dist/index.js`, not the source `src/`,
 * so this test exercises exactly what an npm consumer would import.
 */
import { describe, it, expect } from "@jest/globals";
import * as nexum from "../dist/index.js";

// Tier-1 Stable symbols with runtime values (type-only exports are erased
// by tsc and correctly do not appear at runtime — those are verified by
// the .d.ts in the tarball, not here). Source: STABILITY.md §"Tier 1: Stable"
// + docs/API-FREEZE-AUDIT.md.
const TIER_1_RUNTIME_EXPORTS = [
  // Agent / runtime
  "Agent",
  "DefaultAgentRuntime",
  // Execution strategies (concrete classes; the ExecutionStrategy type is
  // type-only)
  "ReActStrategy",
  "PlanExecuteStrategy",
  "GraphStrategy",
  // Tool gateway
  "DefaultToolGateway",
  "ToolCatalog",
  // Model gateway
  "DefaultModelGateway",
  // Policy engines
  "RulePolicyEngine",
  "AllowAllPolicyEngine",
  // Execution context
  "createExecutionContext",
  // Budget
  "BudgetManager",
  "BudgetTracker",
  // Tool packs
  "defineToolPack",
  "mountToolPack",
  // Agent descriptors
  "devAgentDescriptor",
  // Cancellation
  "CancellationScope",
  "CancellationRegistry",
  // Gates
  "GateRegistry",
  "ConcurrencyGate",
  // Identity primitives
  "newRunId",
  "newTaskId",
  // Workspace
  "WorkspaceManager",
  // CLI config
  "loadConfig",
  // RPC entry
  "startRpcServer",
] as const;

describe("package surface — Tier 1 Stable exports are importable", () => {
  it("every documented Tier-1 runtime export is present on the package", () => {
    const missing: string[] = [];
    for (const symbol of TIER_1_RUNTIME_EXPORTS) {
      if (!(symbol in nexum)) missing.push(symbol);
    }
    expect(missing).toEqual([]);
  });

  it("each Tier-1 export is a non-undefined value of the expected kind", () => {
    // Class constructors must be functions; factories must be functions;
    // descriptors must be objects. This catches the case where a symbol
    // is present but accidentally exported as `undefined` or `null`.
    const expectedKinds: Record<string, "function" | "object"> = {
      Agent: "function",
      DefaultAgentRuntime: "function",
      ReActStrategy: "function",
      PlanExecuteStrategy: "function",
      GraphStrategy: "function",
      DefaultToolGateway: "function",
      ToolCatalog: "function",
      DefaultModelGateway: "function",
      RulePolicyEngine: "function",
      AllowAllPolicyEngine: "function",
      createExecutionContext: "function",
      BudgetManager: "function",
      BudgetTracker: "function",
      defineToolPack: "function",
      mountToolPack: "function",
      devAgentDescriptor: "function",
      CancellationScope: "function",
      CancellationRegistry: "function",
      GateRegistry: "function",
      ConcurrencyGate: "function",
      newRunId: "function",
      newTaskId: "function",
      WorkspaceManager: "function",
      loadConfig: "function",
      startRpcServer: "function",
    };
    const wrong: string[] = [];
    for (const [symbol, expectedKind] of Object.entries(expectedKinds)) {
      const v = (nexum as Record<string, unknown>)[symbol];
      if (typeof v !== expectedKind) {
        wrong.push(`${symbol}: expected ${expectedKind}, got ${typeof v}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the package has at least 290 named runtime exports (regression floor)", () => {
    // A floor, not a ceiling — we want to catch a wholesale export
    // collapse (e.g. a broken barrel file) without failing on every new
    // export added. Bump this number when promoting exports to Tier 1.
    expect(Object.keys(nexum).length).toBeGreaterThanOrEqual(290);
  });
});

describe("package surface — Tier 1 contract behavior and type assertions", () => {
  it("newTaskId produces unique task-prefixed identifiers", () => {
    const id1 = nexum.newTaskId();
    const id2 = nexum.newTaskId();
    expect(id1).toMatch(/^task_[0-9a-f-]+$/);
    expect(id2).toMatch(/^task_[0-9a-f-]+$/);
    expect(id1).not.toBe(id2);
  });

  it("defineToolPack constructs a valid ToolPack and mountToolPack accepts it", () => {
    const pack = nexum.defineToolPack("surface-test-pack", "Test Pack", "testing", []);
    expect(pack.id).toBe("surface-test-pack");
    expect(pack.description).toBe("Test Pack");
    expect(pack.capability).toBe("testing");
    expect(pack.entries).toEqual([]);

    const catalog = new nexum.ToolCatalog();
    const registered = nexum.mountToolPack(pack, catalog);
    expect(registered).toEqual([]);
  });

  it("PlanExecuteStrategy and GraphStrategy instantiate with defaults", () => {
    const planExec = new nexum.PlanExecuteStrategy();
    expect(planExec.name).toBe("plan_execute");

    const graph = new nexum.GraphStrategy();
    expect(graph.name).toBe("graph");
  });

  it("satisfies Tier-1 structural type contracts", () => {
    const result: nexum.ToolResult = {
      callId: "tc_1",
      data: { success: true },
    };
    expect(result.callId).toBe("tc_1");

    const invocation: nexum.ToolInvocation = {
      callId: "tc_1",
      toolName: "test_tool",
      arguments: { foo: "bar" },
    };
    expect(invocation.toolName).toBe("test_tool");

    const correlation: nexum.CorrelationIds = {
      traceId: "trace_1",
      runId: "run_1",
    };
    expect(correlation.traceId).toBe("trace_1");

    const pack: nexum.ToolPack = {
      id: "p1",
      description: "pack 1",
      capability: "test",
      entries: [],
    };
    expect(pack.id).toBe("p1");

    const envelope: nexum.EventEnvelope = {
      id: "evt_1",
      type: "test_event",
      timestamp: Date.now(),
      payload: { ok: true },
    };
    expect(envelope.id).toBe("evt_1");

    const descriptor: nexum.AgentDescriptor = nexum.devAgentDescriptor();
    expect(descriptor.id).toBe("devagent");
  });
});
