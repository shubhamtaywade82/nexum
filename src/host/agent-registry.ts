/**
 * Session-scoped AgentRuntime (docs/plan Phase 5: "the runtime should
 * become session-scoped, not process-global"). Replaces the single
 * process-global Agent from the first vertical slice with a registry keyed
 * by session id, so independent sessions can run concurrently — each still
 * serializes its own runs (one ReAct loop per session at a time), matching
 * a single conversation's turn-taking nature, but different sessions no
 * longer block each other.
 *
 * Every Agent instance is genuinely heavy (LSP servers, browser manager,
 * Binance stream manager, plugin host) — this registry evicts idle entries
 * rather than keeping every session's Agent alive forever, and never
 * evicts one mid-run.
 */

import type { Agent } from "../cli/agent.js";
import type { MessageRepository } from "../persistence/repositories/message-repository.js";
import { RunEventBridge } from "./event-bridge.js";
import { McpHub } from "./mcp-hub.js";
import type { NexumMcpServerInfo } from "../protocol/types.js";

export interface AgentEntry {
  agent: Agent;
  bridge: RunEventBridge;
  lastUsedAt: number;
}

export interface HostAgentRegistryOptions {
  createAgent: () => Agent;
  /** Canonical PostgreSQL message repository to hydrate conversation turns */
  messages?: MessageRepository;
  /** Idle time before an unused session's Agent is torn down. Default 30 min. */
  idleTtlMs?: number;
  /** How long an unanswered approval/clarification waits before failing closed. Default 5 min. */
  interactionTimeoutMs?: number;
}

export class HostAgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly idleTtlMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private mcpHub: McpHub | null = null;
  private mcpReady: Promise<void> | null = null;
  private readonly warnedCollisions = new Set<string>();

  constructor(private readonly opts: HostAgentRegistryOptions) {
    this.idleTtlMs = opts.idleTtlMs ?? 30 * 60 * 1000;
  }

  /** Returns the cached entry for `sessionId`, or null if never created. Does not construct. */
  peek(sessionId: string): AgentEntry | null {
    return this.entries.get(sessionId) ?? null;
  }

  /**
   * Returns the session's Agent, constructing one on first use.
   * If messages repository is provided, hydrates conversation history directly
   * from canonical PostgreSQL storage, bypassing the legacy local JSON store.
   */
  async getOrCreate(sessionId: string): Promise<AgentEntry> {
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const agent = this.opts.createAgent();
    await this.attachMcp(agent);
    try {
      await agent.startHost();
    } catch (err) {
      process.stderr.write(`[nexum host] plugin host start failed for session ${sessionId}: ${describeError(err)}\n`);
    }

    if (this.opts.messages) {
      const history = await this.opts.messages.listBySession(sessionId);
      if (history.length > 0) {
        agent.conversation.loadMessages(
          history.map((m) => ({
            role: m.role as "user" | "assistant" | "system" | "tool",
            content: m.content,
          })),
        );
      }
    } else {
      const resumed = agent.resumeSessionById(sessionId);
      if (!resumed) {
        agent.sessions.adopt(sessionId);
      }
    }

    const entry: AgentEntry = {
      agent,
      bridge: new RunEventBridge(agent, { interactionTimeoutMs: this.opts.interactionTimeoutMs }),
      lastUsedAt: Date.now(),
    };
    this.entries.set(sessionId, entry);
    this.ensureSweepScheduled();
    return entry;
  }

  /**
   * The first agent supplies the MCP config and trust policy; the servers then run once for the host
   * and every agent registers their tools (waiting for the connect attempt to settle, so a session
   * never starts with a half-connected tool set).
   */
  private async attachMcp(agent: Agent): Promise<void> {
    if (!this.mcpHub) {
      const { servers, trust } = agent.mcpHostConfig();
      this.mcpHub = new McpHub(servers, trust);
      this.mcpReady = this.mcpHub.start();
    }
    await this.mcpReady;
    const { skipped } = agent.tools.registerMcpTools(this.mcpHub.tools());
    for (const name of skipped) {
      if (this.warnedCollisions.has(name)) continue;
      this.warnedCollisions.add(name);
      process.stderr.write(`[nexum host] MCP tool "${name}" ignored: a tool with that name already exists\n`);
    }
  }

  /** State of each configured MCP server (empty until the first agent exists). */
  mcpServers(): NexumMcpServerInfo[] {
    return this.mcpHub?.describe() ?? [];
  }

  private ensureSweepScheduled(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweepIdle(), 60_000);
    this.sweepTimer.unref?.();
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, entry] of [...this.entries]) {
      if (entry.bridge.isBusy) continue; // never evict mid-run
      if (now - entry.lastUsedAt < this.idleTtlMs) continue;
      this.entries.delete(sessionId);
      await entry.agent.stopHost().catch(() => {});
    }
  }

  /** Tears down every cached Agent (host shutdown). */
  async stopAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((e) => e.agent.stopHost().catch(() => {})));
    await this.mcpHub?.stop();
    this.mcpHub = null;
    this.mcpReady = null;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
