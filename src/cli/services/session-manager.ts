/**
 * SessionManager service (review item 1) — conversation persistence the
 * Agent god class used to own inline.
 *
 * Owns: the SessionStore, the current session id, transcript saves, reset/
 * resume flows, session listing, and the background summarization trigger
 * (quick-tier, single-flight).
 */

import { SessionStore, SessionMeta } from "../../runtime/session.js";
import { ChatMessage } from "../../models/adapters/provider.js";
import { MemoryStore } from "../../memory/store.js";
import { generateSummary } from "../../memory/summarizer.js";
import type { ModelStack } from "./model-stack.js";

export interface SessionManagerOptions {
  store: SessionStore;
  memory: MemoryStore;
  /** Chat surface for background summaries (quick-tier routing). */
  stack: ModelStack;
  onMemorySummary?: (summary: string) => void;
  onError?: (error: Error) => void;
}

export class SessionManager {
  private currentSessionId: string;
  private isSummarizing = false;

  constructor(private readonly opts: SessionManagerOptions) {
    this.currentSessionId = this.opts.store.startNew();
  }

  get sessionId(): string {
    return this.currentSessionId;
  }

  /** Persist the transcript after every turn (not just success). */
  save(messages: ChatMessage[]): void {
    this.opts.store.save(this.currentSessionId, messages);
  }

  reset(): string {
    this.opts.store.clear(this.currentSessionId);
    this.currentSessionId = this.opts.store.startNew();
    return this.currentSessionId;
  }

  hasResumableSession(): boolean {
    return this.opts.store.mostRecentId() !== null;
  }

  listSessions(): SessionMeta[] {
    return this.opts.store.listSessions();
  }

  /** Restore the most recently persisted transcript (crash recovery). */
  resumeSession(): ChatMessage[] | null {
    const id = this.opts.store.mostRecentId();
    return id ? this.resumeSessionById(id) : null;
  }

  resumeSessionById(id: string): ChatMessage[] | null {
    const saved = this.opts.store.load(id);
    if (!saved) return null;
    this.currentSessionId = id;
    return saved;
  }

  /**
   * Forces this Agent instance to use an externally-minted id instead of
   * the one `startNew()` generated at construction time — for a host that
   * assigns session ids itself (src/host/agent-registry.ts) and only
   * constructs the Agent lazily, on first use. Only meaningful before the
   * first `save()`; once a transcript exists under the constructor's own
   * id, `resumeSessionById` is the right call instead.
   */
  adopt(id: string): void {
    this.currentSessionId = id;
  }

  /** Background summarization (quick tier, single-flight). */
  triggerSummarization(): void {
    if (this.isSummarizing) return;
    this.isSummarizing = true;
    generateSummary(this.opts.memory, {
      chat: (messages, opts) => this.opts.stack.routeWithFallback("quick", messages, opts),
    })
      .then((summary) => this.opts.onMemorySummary?.(summary))
      .catch((e) => this.opts.onError?.(e instanceof Error ? e : new Error(String(e))))
      .finally(() => {
        this.isSummarizing = false;
      });
  }
}
