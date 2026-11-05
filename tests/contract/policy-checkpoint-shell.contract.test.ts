/**
 * CONTRACT TESTS — PolicyEngine + Checkpoint/Recovery + Shell sandbox
 * accounting (review item 37's remaining boundaries: items 7, 8, 13, 27).
 *
 *   PolicyEngine  : rule chain, rule attribution, execution-profile
 *                   postures, financial-confirmation invariant, budget
 *                   guard, mode restriction, bound-profile stamping.
 *   Checkpoint    : atomic save, crash-tolerant load, resume sanitization.
 *   Shell sandbox : full lifecycle accounting with durable JSONL records.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RulePolicyEngine, AllowAllPolicyEngine } from "../../src/core/policy/policy-engine.js";
import { executionProfile } from "../../src/core/policy/execution-profiles.js";
import { defineToolMetadata } from "../../src/core/tools/tool-contract.js";
import type { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import { CheckpointStore, sanitizeResumedSteps } from "../../src/runtime/checkpoint.js";
import { ShellExecutionAccountant } from "../../src/tools/shell-accounting.js";
import type { PlanStep } from "../../src/orchestration/types.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function toolDef(overrides: Partial<ToolDefinition> & { id: string }): ToolDefinition {
  return {
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
    capabilities: [],
    pack: "Test",
    tags: [],
    ...defineToolMetadata({}),
    ...overrides,
  };
}

function policyRequest(tool: ToolDefinition, extra: Record<string, unknown> = {}) {
  return {
    tool,
    args: {},
    agentId: "devagent",
    runId: "run_1",
    ...extra,
  };
}

// ── PolicyEngine contract (items 7, 8) ──────────────────────────────────────

describe("PolicyEngine contract (items 7, 8)", () => {
  const readTool = toolDef({ id: "read_file", ...defineToolMetadata({ risk: "read" }) });
  const writeTool = toolDef({
    id: "write_file",
    risk: "medium",
    ...defineToolMetadata({ sideEffects: { filesystem: true } }),
  });
  const shellTool = toolDef({
    id: "spawn_proc", // NOT "run_shell": that id sits on readonly's deny list
    ...defineToolMetadata({
      risk: "critical",
      sideEffects: { process: true, filesystem: true },
      network: { required: false, proxyable: true },
    }),
  });

  it("default-allow decision carries rule attribution for the audit trail (item 7)", () => {
    const engine = new RulePolicyEngine();
    const decision = engine.check(policyRequest(readTool));
    expect(decision.allowed).toBe(true);
    expect(decision.requireConfirmation).toBe(false);
    expect(decision.rule).toBe("default-allow");
  });

  it("denied tool ids and risk ceilings produce denied decisions naming the rule (item 7)", () => {
    const engine = new RulePolicyEngine({ deniedToolIds: ["write_file"], denyRiskAbove: "high" });
    const denied = engine.check(policyRequest(writeTool));
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("deny-tools");
    expect(denied.reason).toContain("write_file");

    const tooRisky = engine.check(policyRequest(shellTool));
    expect(tooRisky.allowed).toBe(false);
    expect(tooRisky.rule).toBe("deny-risk-above");
    expect(tooRisky.reason).toContain("exceeds ceiling");
  });

  it("readonly profile denies process, network and filesystem mutation (item 8)", () => {
    const engine = new RulePolicyEngine({ profile: executionProfile("readonly") });
    const proc = engine.check(policyRequest(shellTool));
    expect(proc.allowed).toBe(false);
    expect(proc.reason).toContain('profile "readonly"');
    expect(proc.reason).toContain("process spawning is disabled");

    const fsWrite = engine.check(policyRequest(writeTool));
    expect(fsWrite.allowed).toBe(false);
    expect(fsWrite.reason).toContain("filesystem writes are disabled");

    // reads still pass — profiles gate posture, not existence
    const read = engine.check(policyRequest(readTool));
    expect(read.allowed).toBe(true);
  });

  it("the profile bound at construction stamps requests lacking environment context (item 8)", () => {
    const engine = new RulePolicyEngine({ profile: executionProfile("readonly") });
    // no environment in the request — the bound profile must still apply
    const decision = engine.check(policyRequest(writeTool));
    expect(decision.allowed).toBe(false);
  });

  it("financial side effects ALWAYS require confirmation — the tool cannot opt out (item 7)", () => {
    const tradeTool = toolDef({
      id: "live_trade",
      risk: "medium",
      ...defineToolMetadata({
        sideEffects: { financial: true, externalMutation: true },
        policy: { confirmation: "never" }, // the tool LIES; policy must win
      }),
    });
    const engine = new RulePolicyEngine({ requireConfirmationFor: "critical" });
    const decision = engine.check(policyRequest(tradeTool));
    expect(decision.allowed).toBe(true);
    expect(decision.requireConfirmation).toBe(true);
    expect(decision.reason).toContain("financial side effects");
  });

  it("profile confirmation floor tightens beyond the engine's floor (item 7/8)", () => {
    const midRisk = toolDef({
      id: "mid_risk",
      ...defineToolMetadata({ risk: "medium" }),
    });
    const highRisk = toolDef({
      id: "high_risk",
      ...defineToolMetadata({ risk: "high" }),
    });

    // engine floor "low" alone: a medium-risk tool needs confirmation
    const permissive = new RulePolicyEngine({ requireConfirmationFor: "low" });
    const bareDecision = permissive.check(policyRequest(midRisk));
    expect(bareDecision.requireConfirmation).toBe(true);

    // the networked profile's floor ("high") tightens that to high+ only:
    // medium now passes silently, high still requires confirmation
    const engine = new RulePolicyEngine({
      requireConfirmationFor: "low",
      profile: executionProfile("networked"),
    });
    const midDecision = engine.check(policyRequest(midRisk));
    expect(midDecision.allowed).toBe(true);
    expect(midDecision.requireConfirmation).toBe(false);

    const highDecision = engine.check(policyRequest(highRisk));
    expect(highDecision.requireConfirmation).toBe(true);
    expect(highDecision.reason).toContain("high");
  });

  it("depleted budgets deny NEW mutations but reads still pass (item 7)", () => {
    const engine = new RulePolicyEngine();
    const depleted = { toolCalls: 3, modelCalls: 5, totalTokens: 100, costUsd: 0, elapsedMs: -1 };
    const denied = engine.check(policyRequest(writeTool, { budget: depleted }));
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("budget-guard");
    expect(denied.reason).toContain("depleted");

    const read = engine.check(policyRequest(readTool, { budget: depleted }));
    expect(read.allowed).toBe(true);
  });

  it("read-only agent modes (ask/review) deny mutating tools (item 7)", () => {
    const engine = new RulePolicyEngine();
    const denied = engine.check(policyRequest(writeTool, { mode: "review" }));
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("mode-restriction");
    const allowed = engine.check(policyRequest(readTool, { mode: "review" }));
    expect(allowed.allowed).toBe(true);
  });

  it("AllowAllPolicyEngine permits everything for headless/embedded use", () => {
    const decision = new AllowAllPolicyEngine().check(policyRequest(shellTool));
    expect(decision.allowed).toBe(true);
  });
});

// ── Checkpoint / Recovery contract (item 13 + 37) ───────────────────────────

describe("Checkpoint / Recovery contract (items 13, 37)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-ckpt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const steps: PlanStep[] = [
    { id: "s1", description: "first", status: "completed", dependencies: [], retryCount: 0 },
    { id: "s2", description: "second", status: "implementing", dependencies: ["s1"], retryCount: 1 },
    { id: "s3", description: "third", status: "pending", dependencies: ["s2"], retryCount: 0 },
  ];

  it("save → load roundtrips steps, history and replan count", () => {
    const store = new CheckpointStore(join(dir, "run.json"));
    store.save({
      steps,
      history: [{ stepId: "s1", outcome: { kind: "success", output: {} }, at: 123 }],
      replanCount: 2,
    });
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(loaded!.history).toHaveLength(1);
    expect(loaded!.replanCount).toBe(2);
    expect(loaded!.updatedAt).toBeGreaterThan(0);
  });

  it("a crash mid-write leaves the previous checkpoint intact (atomic rename)", () => {
    const path = join(dir, "run.json");
    const store = new CheckpointStore(path);
    store.save({ steps, history: [], replanCount: 0 });

    // simulate a torn write: a half-written tmp file sitting next to the store
    writeFileSync(`${path}.tmp`, '{"steps": [ {"id": "s1", "des');
    // the committed checkpoint is unaffected
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.steps).toHaveLength(3);

    // a corrupted committed file is reported as absent, never misparsed
    writeFileSync(path, "{ not json");
    expect(store.load()).toBeNull();
  });

  it("resume sanitization resets non-terminal steps to pending; trusted states survive (recovery)", () => {
    const resumed = sanitizeResumedSteps([
      ...steps,
      { id: "s4", description: "cancelled", status: "cancelled", dependencies: [], retryCount: 0 },
      { id: "s5", description: "rolled back", status: "rolledback", dependencies: [], retryCount: 0 },
      { id: "s6", description: "failed mid-flight", status: "failed", dependencies: [], retryCount: 0 },
    ]);
    const byId = new Map(resumed.map((s) => [s.id, s.status]));
    // completed / cancelled / rolledback are trusted
    expect(byId.get("s1")).toBe("completed");
    expect(byId.get("s4")).toBe("cancelled");
    expect(byId.get("s5")).toBe("rolledback");
    // in-flight (implementing) and failed are retried as pending
    expect(byId.get("s2")).toBe("pending");
    expect(byId.get("s6")).toBe("pending");
    expect(byId.get("s3")).toBe("pending");
  });

  it("clear removes the checkpoint so the next run starts fresh", () => {
    const store = new CheckpointStore(join(dir, "run.json"));
    store.save({ steps, history: [], replanCount: 0 });
    store.clear();
    expect(store.load()).toBeNull();
  });
});

// ── Shell sandbox lifecycle accounting (item 27) ────────────────────────────

describe("Shell sandbox accounting contract (item 27)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-shell-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function beginRecord(acct: ShellExecutionAccountant, containerId = "container_1") {
    return acct.begin({
      containerId,
      runId: "run_1",
      agentId: "devagent",
      toolCallId: "tc_1",
      command: "npm test",
      cpuLimit: "1.0",
      memoryLimitMb: "512",
      pidsLimit: 128,
      networkMode: "none",
      image: "nexum-sandbox:latest",
      timeoutSec: 30,
    });
  }

  it("begin() zeroes the accounting fields and keeps declared limits", () => {
    const acct = new ShellExecutionAccountant({ sampleIntervalMs: 0 });
    const record = beginRecord(acct);
    expect(record.stdoutBytes).toBe(0);
    expect(record.stderrBytes).toBe(0);
    expect(record.samples).toEqual([]);
    expect(record.exitStatus).toBeUndefined();
    expect(record.startedAt).toBeGreaterThan(0);
    expect(record.networkMode).toBe("none");
    expect(record.pidsLimit).toBe(128);
  });

  it("complete() records duration, exit status, output bytes — and persists (item 27)", async () => {
    const file = join(dir, "shell-executions.jsonl");
    const acct = new ShellExecutionAccountant({ file, sampleIntervalMs: 0 });
    const record = beginRecord(acct);
    record.stdoutBytes = 1024;
    record.stderrBytes = 256;
    // Sleep well above the 5ms assertion: Node timers may fire a touch early
    // and Date.now() rounds, so a 5ms sleep can measure as 4ms on fast
    // runners (observed flake on CI).
    await new Promise((r) => setTimeout(r, 25));
    const done = acct.complete(record, 0);

    expect(done.exitStatus).toBe(0);
    expect(done.durationMs).toBeGreaterThanOrEqual(5);
    expect(done.endedAt).toBeGreaterThanOrEqual(done.startedAt);

    // durable execution metadata: one parseable JSONL line with correlation
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const persisted = JSON.parse(lines[0]);
    expect(persisted.containerId).toBe("container_1");
    expect(persisted.runId).toBe("run_1");
    expect(persisted.agentId).toBe("devagent");
    expect(persisted.toolCallId).toBe("tc_1");
    expect(persisted.stdoutBytes).toBe(1024);
    expect(persisted.stderrBytes).toBe(256);
    expect(persisted.exitStatus).toBe(0);
  });

  it("totals() aggregates executions, failures, timeouts and output bytes (item 27)", () => {
    const acct = new ShellExecutionAccountant({ sampleIntervalMs: 0 });
    const ok = beginRecord(acct, "c_ok");
    ok.stdoutBytes = 100;
    acct.complete(ok, 0);

    const fail = beginRecord(acct, "c_fail");
    fail.stderrBytes = 50;
    acct.complete(fail, 2, "TimeoutError");

    const totals = acct.totals();
    expect(totals.executions).toBe(2);
    expect(totals.failures).toBe(1);
    expect(totals.timeouts).toBe(1);
    expect(totals.totalOutputBytes).toBe(150);
    expect(totals.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(acct.history()).toHaveLength(2);
  });

  it("summarize() is a compact result payload for the tool call (item 27)", () => {
    const acct = new ShellExecutionAccountant({ sampleIntervalMs: 0 });
    const record = beginRecord(acct, "c_sum");
    record.stdoutBytes = 10;
    record.stderrBytes = 5;
    record.samples.push({ ts: Date.now(), cpuPercent: "12.34%", memUsage: "128MiB", memBytes: 134217728, pids: 7 });
    acct.complete(record, 0);

    const summary = acct.summarize(record);
    expect(summary).toMatchObject({
      containerId: "c_sum",
      cpuLimit: "1.0",
      memoryLimit: "512",
      pidsLimit: 128,
      networkMode: "none",
      outputBytes: 15,
      exitStatus: 0,
      cpuPercent: "12.34%",
      memUsage: "128MiB",
      pids: 7,
    });
    // duration is present once the record completed
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("memory history is bounded (maxMemoryRecords)", () => {
    const acct = new ShellExecutionAccountant({ sampleIntervalMs: 0, maxMemoryRecords: 2 });
    for (let i = 0; i < 5; i++) {
      acct.complete(beginRecord(acct, `c_${i}`), 0);
    }
    expect(acct.history()).toHaveLength(2);
    expect(acct.history()[0].containerId).toBe("c_3"); // oldest evicted
  });
});
