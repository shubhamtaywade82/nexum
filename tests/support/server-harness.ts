import { PostgresHarness } from "./postgres-harness.js";
import { RedisHarness } from "./redis-harness.js";
import { FakeAgent } from "./fake-agent.js";
import { createNexumHost, type NexumHost } from "../../src/host/server.js";
import type { Database } from "../../src/persistence/database.js";
import type { RedisEventBus } from "../../src/infrastructure/redis/pubsub.js";

export interface ServerHarnessOptions {
  workspaceRoot?: string;
  createAgent?: () => FakeAgent;
  host?: string;
  token?: string;
}

export class ServerHarness {
  readonly pg = new PostgresHarness();
  readonly redis = new RedisHarness();
  private hostInstance: NexumHost | null = null;
  private currentAgent: FakeAgent | null = null;
  private lastOpts: ServerHarnessOptions = {};
  baseUrl = "";
  private agentRunHandler?: (goal: string, agent: FakeAgent) => Promise<string>;

  setRunHandler(handler: (goal: string, agent: FakeAgent) => Promise<string>): void {
    this.agentRunHandler = handler;
    if (this.currentAgent) {
      const agent = this.currentAgent;
      agent.setRunHandler((goal) => handler(goal, agent));
    }
  }

  resetRunHandler(): void {
    this.agentRunHandler = undefined;
  }

  async start(opts: ServerHarnessOptions = {}): Promise<void> {
    this.lastOpts = opts;
    const db = await this.pg.start();
    const eventBus = await this.redis.start();

    const createAgent = (): FakeAgent => {
      this.currentAgent = opts.createAgent ? opts.createAgent() : new FakeAgent();
      if (this.agentRunHandler) {
        const agent = this.currentAgent;
        agent.setRunHandler((goal) => this.agentRunHandler!(goal, agent));
      }
      return this.currentAgent;
    };

    this.hostInstance = createNexumHost({
      createAgent: () => createAgent().asAgent(),
      workspaceRoot: opts.workspaceRoot ?? process.cwd(),
      db,
      eventBus,
      host: opts.host ?? "127.0.0.1",
      port: 0,
      token: opts.token,
    });

    const bound = await this.hostInstance.start();
    this.baseUrl = `http://${bound.host}:${bound.port}`;
  }

  async stopServer(graceMs?: number): Promise<void> {
    if (this.hostInstance) {
      await this.hostInstance.stop(graceMs);
      this.hostInstance = null;
    }
  }

  async startServer(opts: Partial<ServerHarnessOptions> = {}): Promise<void> {
    const mergedOpts = { ...this.lastOpts, ...opts };
    this.lastOpts = mergedOpts;

    const createAgent = (): FakeAgent => {
      this.currentAgent = mergedOpts.createAgent ? mergedOpts.createAgent() : new FakeAgent();
      if (this.agentRunHandler) {
        const agent = this.currentAgent;
        agent.setRunHandler((goal) => this.agentRunHandler!(goal, agent));
      }
      return this.currentAgent;
    };

    this.hostInstance = createNexumHost({
      createAgent: () => createAgent().asAgent(),
      workspaceRoot: mergedOpts.workspaceRoot ?? process.cwd(),
      db: this.pg.db,
      eventBus: this.redis.eventBus,
      host: mergedOpts.host ?? "127.0.0.1",
      port: 0,
      token: mergedOpts.token,
    });

    const bound = await this.hostInstance.start();
    this.baseUrl = `http://${bound.host}:${bound.port}`;
  }

  async restartServer(graceMs?: number): Promise<void> {
    await this.stopServer(graceMs);
    await this.startServer();
  }

  get db(): Database {
    return this.pg.db;
  }

  get eventBus(): RedisEventBus {
    return this.redis.eventBus;
  }

  get lastAgent(): FakeAgent | null {
    return this.currentAgent;
  }

  async getJson<T>(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    const body = (await res.json()) as T;
    return { status: res.status, body };
  }

  async postJson<T>(
    path: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  }

  async waitForRun(runId: string, timeoutMs = 5000): Promise<{ id: string; status: string; output?: string }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { status, body } = await this.getJson<{ id: string; status: string; output?: string }>(`/runs/${runId}`);
      if (status === 200 && ["completed", "failed", "cancelled", "interrupted"].includes(body.status)) {
        return body;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms`);
  }

  async stop(): Promise<void> {
    if (this.hostInstance) {
      await this.hostInstance.stop();
      this.hostInstance = null;
    }
    await this.redis.stop();
    await this.pg.stop();
  }
}
