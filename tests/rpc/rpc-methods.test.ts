/**
 * Tests for the RPC method handlers (jobs, subagents, workflows, webhooks,
 * control plane).
 *
 * The tests use an in-memory RpcServer with mock service instances to
 * verify the JSON-RPC method dispatch + serialization works end-to-end.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import { PassThrough } from "node:stream";
import {
  RpcServer,
  registerJobMethods,
  registerSubagentMethods,
  registerWorkflowMethods,
  registerWebhookMethods,
  registerControlPlaneMethods,
  type JsonRpcResponse,
} from "../../src/rpc/index.js";
import { JobService } from "../../src/jobs/index.js";
import { ControlPlaneService, registerDefaultMetrics } from "../../src/control-plane/index.js";
import { WebhookService } from "../../src/webhooks/index.js";
import { WorkflowService } from "../../src/workflow/index.js";
import { SubagentService } from "../../src/subagents/index.js";

/**
 * Helper: drive an RpcServer by writing JSON-RPC requests to its input
 * stream and reading responses from its output stream.
 */
function makeServer(): { server: RpcServer; input: PassThrough; output: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new RpcServer({ input, output, autostart: false });
  server.start();
  return { server, input, output };
}

async function callMethod(
  server: RpcServer,
  input: PassThrough,
  output: PassThrough,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const lines: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      lines.push(chunk);
      const text = Buffer.concat(lines).toString("utf8");
      const newlineIdx = text.indexOf("\n");
      if (newlineIdx < 0) return;
      output.off("data", onData);
      const line = text.slice(0, newlineIdx);
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      } catch (err) {
        reject(new Error(`failed to parse response: ${String(err)} (line: ${line})`));
      }
    };
    output.on("data", onData);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
  });
}

describe("registerJobMethods", () => {
  let server: RpcServer;
  let input: PassThrough;
  let output: PassThrough;
  let jobs: JobService;

  beforeEach(() => {
    ({ server, input, output } = makeServer());
    jobs = new JobService({ maxConcurrent: 4 });
    registerJobMethods(server, jobs);
  });

  it("jobs.submit returns a job id", async () => {
    const result = await callMethod(server, input, output, "jobs.submit", { description: "test job" });
    expect(result).toEqual({ id: expect.any(String) });
  });

  it("jobs.status returns the job record", async () => {
    const submitResult = await callMethod(server, input, output, "jobs.submit", { description: "status test" });
    const { id } = submitResult as { id: string };
    // Wait for the job to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await callMethod(server, input, output, "jobs.status", { id });
    expect((status as { description: string }).description).toBe("status test");
  });

  it("jobs.list returns all jobs", async () => {
    await callMethod(server, input, output, "jobs.submit", { description: "a" });
    await callMethod(server, input, output, "jobs.submit", { description: "b" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const list = await callMethod(server, input, output, "jobs.list", {});
    expect((list as unknown[]).length).toBe(2);
  });

  it("jobs.counts returns state counts", async () => {
    await callMethod(server, input, output, "jobs.submit", { description: "a" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const counts = await callMethod(server, input, output, "jobs.counts");
    expect((counts as Record<string, number>).completed).toBe(1);
  });

  it("jobs.status requires id", async () => {
    await expect(callMethod(server, input, output, "jobs.status", {})).rejects.toThrow(/requires/);
  });
});

describe("registerSubagentMethods", () => {
  let server: RpcServer;
  let input: PassThrough;
  let output: PassThrough;
  let subs: SubagentService;

  beforeEach(() => {
    ({ server, input, output } = makeServer());
    subs = new SubagentService({ maxConcurrent: 4, maxTotalPerSession: 32 });
    registerSubagentMethods(server, subs);
  });

  it("subagents.spawn throws on missing provider", async () => {
    await expect(callMethod(server, input, output, "subagents.spawn", { goal: "x" })).rejects.toThrow(/requires/);
  });

  it("subagents.spawn throws when provider not registered", async () => {
    await expect(
      callMethod(server, input, output, "subagents.spawn", { provider: "nonexistent", goal: "x" }),
    ).rejects.toThrow(/no subagent provider registered/);
  });

  it("subagents.list returns empty array when no subagents", async () => {
    const list = await callMethod(server, input, output, "subagents.list", {});
    expect(list).toEqual([]);
  });
});

describe("registerWorkflowMethods", () => {
  let server: RpcServer;
  let input: PassThrough;
  let output: PassThrough;
  let wfs: WorkflowService;

  beforeEach(() => {
    ({ server, input, output } = makeServer());
    wfs = new WorkflowService({ inMemory: true });
    registerWorkflowMethods(server, wfs);
  });

  it("workflows.register requires definition", async () => {
    await expect(callMethod(server, input, output, "workflows.register", {})).rejects.toThrow(/requires/);
  });

  it("workflows.createInstance requires workflowId", async () => {
    await expect(callMethod(server, input, output, "workflows.createInstance", {})).rejects.toThrow(/requires/);
  });

  it("workflows.createInstance throws for unknown workflow", async () => {
    await expect(
      callMethod(server, input, output, "workflows.createInstance", { workflowId: "nonexistent" }),
    ).rejects.toThrow(/unknown workflow/);
  });

  it("workflows.list returns empty array", async () => {
    const list = await callMethod(server, input, output, "workflows.list", {});
    expect(list).toEqual([]);
  });
});

describe("registerWebhookMethods", () => {
  let server: RpcServer;
  let input: PassThrough;
  let output: PassThrough;
  let whs: WebhookService;

  beforeEach(() => {
    ({ server, input, output } = makeServer());
    whs = new WebhookService({ inMemory: true });
    registerWebhookMethods(server, whs);
  });

  it("webhooks.registerEndpoint requires endpoint", async () => {
    await expect(callMethod(server, input, output, "webhooks.registerEndpoint", {})).rejects.toThrow(/requires/);
  });

  it("webhooks.listEndpoints returns empty array", async () => {
    const list = await callMethod(server, input, output, "webhooks.listEndpoints");
    expect(list).toEqual([]);
  });

  it("webhooks.counts returns zero counts", async () => {
    const counts = await callMethod(server, input, output, "webhooks.counts");
    expect(counts).toEqual({ verified: 0, unverified: 0, delivered: 0, total: 0 });
  });
});

describe("registerControlPlaneMethods", () => {
  let server: RpcServer;
  let input: PassThrough;
  let output: PassThrough;
  let cp: ControlPlaneService;

  beforeEach(() => {
    ({ server, input, output } = makeServer());
    cp = new ControlPlaneService();
    registerDefaultMetrics(cp);
    registerControlPlaneMethods(server, cp);
  });

  it("control.phase returns current phase", async () => {
    const result = await callMethod(server, input, output, "control.phase");
    expect(result).toEqual({ phase: "stopped" });
  });

  it("control.metrics returns snapshot", async () => {
    const result = await callMethod(server, input, output, "control.metrics");
    expect(Array.isArray(result)).toBe(true);
  });

  it("control.status returns runtime status", async () => {
    const result = await callMethod(server, input, output, "control.status", { activeRuns: 3 });
    expect((result as { activeRuns: number }).activeRuns).toBe(3);
  });

  it("control.health returns overall status", async () => {
    const result = await callMethod(server, input, output, "control.health");
    expect((result as { overall: string }).overall).toBe("healthy");
  });

  it("control.control pauses the runtime", async () => {
    cp.start();
    const result = await callMethod(server, input, output, "control.control", { action: "pause" });
    expect((result as { accepted: boolean }).accepted).toBe(true);
    expect(cp.getPhase()).toBe("draining");
  });

  it("control.control requires action", async () => {
    await expect(callMethod(server, input, output, "control.control", {})).rejects.toThrow(/requires/);
  });
});
