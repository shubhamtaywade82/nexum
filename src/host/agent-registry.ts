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
}

export class HostAgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly idleTtlMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

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

    const entry: AgentEntry = { agent, bridge: new RunEventBridge(agent), lastUsedAt: Date.now() };
    this.entries.set(sessionId, entry);
    this.ensureSweepScheduled();
    return entry;
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
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
