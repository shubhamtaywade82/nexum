/**
 * AgentMessageBus — first-class agent-to-agent messaging.
 *
 * Nexum had delegation (supervisor → spawn child → result returned), which
 * is a call tree. General multi-agent work needs peer messaging:
 *
 *   Agent A ⇄ message bus ⇄ Agent B ⇄ message bus ⇄ Agent C
 *
 * with structured envelopes (correlation + conversation ids, reply links),
 * per-agent inboxes, topics, broadcast, and request/response correlation.
 * In-process today; the envelope + inbox contracts are the seam a
 * distributed transport (OTLP-style exporter, NATS, redis streams) plugs
 * into without touching the protocol layer above.
 *
 * Delivery semantics: at-least-once within the process. Unroutable messages
 * (no inbox registered) produce a dead-letter receipt — never a silent drop.
 */

import { randomUUID } from "node:crypto";

export type AgentAddress = string;
export type TopicName = string;

/** The wire format. Everything travels in one of these. */
export interface AgentMessage<P = unknown> {
  /** msg_<uuid>. */
  id: string;
  from: AgentAddress;
  /** Agent id, "*" (broadcast), or "topic:<name>". */
  to: AgentAddress | "*" | TopicName;
  /** Message type (see coordination-protocol.ts for the standard set). */
  type: string;
  payload: P;
  /** Links a request to its reply. */
  correlationId?: string;
  /** Groups a working thread (a task, a negotiation, ...). */
  conversationId?: string;
  /** Message id this message replies to. */
  inReplyTo?: string;
  ts: number;
}

/** What the bus accepts (id/ts are minted when omitted). */
export type AgentMessageInput<P = unknown> = Omit<AgentMessage<P>, "id" | "ts"> &
  Partial<Pick<AgentMessage<P>, "id" | "ts">>;

export interface DeliveryReceipt {
  messageId: string;
  to: AgentAddress | TopicName;
  delivered: boolean;
  reason?: string;
}

export function newMessageId(): string {
  return `msg_${randomUUID()}`;
}

/** Per-agent mailbox: FIFO queue + optional listener + async next(). */
export class AgentInbox {
  private readonly queue: AgentMessage[] = [];
  private readonly waiters: Array<(message: AgentMessage) => void> = [];
  private listener?: (message: AgentMessage) => void;

  constructor(readonly agentId: AgentAddress) {}

  /** Enqueue and wake one waiter or notify the listener. */
  deliver(message: AgentMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    if (this.listener) {
      this.listener(message);
      return;
    }
    this.queue.push(message);
  }

  /** Await the next message; resolves undefined on timeout. */
  async next(timeoutMs?: number): Promise<AgentMessage | undefined> {
    if (this.queue.length > 0) return this.queue.shift();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (message: AgentMessage) => {
        if (timer) clearTimeout(timer);
        resolve(message);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(undefined);
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  /** Install a push listener; replaces any previous one. Returns uninstall. */
  onMessage(listener: (message: AgentMessage) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  pending(): AgentMessage[] {
    return [...this.queue];
  }

  /** Synchronously take up to n queued messages (listener mode: no-op). */
  drain(n = Number.MAX_SAFE_INTEGER): AgentMessage[] {
    return this.queue.splice(0, n);
  }

  get size(): number {
    return this.queue.length;
  }
}

export interface BusOptions {
  /** Bounded envelope history for debugging/audit (default 1000). */
  historyLimit?: number;
}

interface TopicSubscription {
  /** Deliver into this agent's inbox. */
  inboxAgentId?: AgentAddress;
  /** And/or call this listener directly. */
  listener?: (message: AgentMessage) => void;
}

interface PendingRequest {
  replyTo: AgentAddress;
  resolve: (message: AgentMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentMessageBus {
  private readonly inboxes = new Map<AgentAddress, AgentInbox>();
  private readonly topics = new Map<TopicName, Set<TopicSubscription>>();
  private readonly historyBuffer: AgentMessage[] = [];
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly historyLimit: number;

  constructor(opts: BusOptions = {}) {
    this.historyLimit = opts.historyLimit ?? 1000;
  }

  register(agentId: AgentAddress): AgentInbox {
    if (this.inboxes.has(agentId)) throw new Error(`agent inbox "${agentId}" is already registered`);
    const inbox = new AgentInbox(agentId);
    this.inboxes.set(agentId, inbox);
    return inbox;
  }

  unregister(agentId: AgentAddress): boolean {
    return this.inboxes.delete(agentId);
  }

  inbox(agentId: AgentAddress): AgentInbox | undefined {
    return this.inboxes.get(agentId);
  }

  requireInbox(agentId: AgentAddress): AgentInbox {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) throw new Error(`no inbox for agent "${agentId}". Registered: ${this.agents().join(", ") || "(none)"}`);
    return inbox;
  }

  agents(): AgentAddress[] {
    return [...this.inboxes.keys()];
  }

  /**
   * Send one envelope. Routing:
   *   specific agent → that inbox (dead-letter receipt when unregistered)
   *   "*"            → every inbox except the sender
   *   "topic:<name>" → topic subscribers
   * Replies matching an open request() correlation are resolved directly.
   */
  send<P>(input: AgentMessageInput<P>): DeliveryReceipt[] {
    const message: AgentMessage = {
      ...input,
      id: input.id ?? newMessageId(),
      ts: input.ts ?? Date.now(),
    } as AgentMessage;
    this.recordHistory(message);

    // Request/response interception: a reply carrying a correlationId we are
    // waiting on resolves the promise instead of landing in the queue.
    if (message.correlationId && message.inReplyTo) {
      const pending = this.pendingRequests.get(message.correlationId);
      if (pending && message.to === pending.replyTo) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.correlationId);
        pending.resolve(message);
        return [{ messageId: message.id, to: message.to, delivered: true }];
      }
    }

    if (message.to === "*") {
      const receipts: DeliveryReceipt[] = [];
      for (const [agentId, inbox] of this.inboxes) {
        if (agentId === message.from) continue;
        inbox.deliver(message);
        receipts.push({ messageId: message.id, to: agentId, delivered: true });
      }
      return receipts;
    }

    if (message.to.startsWith("topic:")) {
      const subs = this.topics.get(message.to) ?? new Set<TopicSubscription>();
      const receipts: DeliveryReceipt[] = [];
      let delivered = 0;
      for (const sub of subs) {
        if (sub.inboxAgentId) {
          const inbox = this.inboxes.get(sub.inboxAgentId);
          if (inbox) {
            inbox.deliver(message);
            receipts.push({ messageId: message.id, to: sub.inboxAgentId, delivered: true });
            delivered++;
          }
        }
        if (sub.listener) {
          sub.listener(message);
          delivered++;
        }
      }
      if (delivered === 0) {
        receipts.push({ messageId: message.id, to: message.to, delivered: false, reason: "no subscribers" });
      }
      return receipts;
    }

    const inbox = this.inboxes.get(message.to);
    if (!inbox) {
      return [{ messageId: message.id, to: message.to, delivered: false, reason: "no inbox registered" }];
    }
    inbox.deliver(message);
    return [{ messageId: message.id, to: message.to, delivered: true }];
  }

  /** Convenience reply: correlation + inReplyTo set automatically. */
  reply<P>(original: AgentMessage, type: string, payload: P): DeliveryReceipt[] {
    return this.send({
      from: original.to === "*" ? "" : String(original.to),
      to: original.from,
      type,
      payload,
      ...(original.correlationId ? { correlationId: original.correlationId } : {}),
      ...(original.conversationId ? { conversationId: original.conversationId } : {}),
      inReplyTo: original.id,
    });
  }

  /**
   * Send-and-await: sends `type`/`payload`, resolves with the reply matched
   * by correlationId. Rejects on timeout. The reply never enters the inbox
   * queue (intercepted), so request/response and queue polling don't mix.
   */
  async request<P>(
    from: AgentAddress,
    to: AgentAddress,
    type: string,
    payload: P,
    opts: { timeoutMs?: number; conversationId?: string } = {},
  ): Promise<AgentMessage> {
    const correlationId = `corr_${randomUUID()}`;
    const timeoutMs = opts.timeoutMs ?? 5000;

    // Register the waiter BEFORE sending: a synchronous responder (an
    // onMessage listener replying inside send()) would otherwise beat the
    // registration and the reply would land in the queue instead of
    // resolving this promise.
    const replyPromise = new Promise<AgentMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`request ${type} to "${to}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(correlationId, { replyTo: from, resolve, timer });
    });

    const receipts = this.send({
      from,
      to,
      type,
      payload,
      correlationId,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    });
    const failed = receipts.find((r) => !r.delivered);
    if (failed) {
      const pending = this.pendingRequests.get(correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(correlationId);
      }
      throw new Error(`request to "${to}" was not delivered: ${failed.reason}`);
    }
    return replyPromise;
  }

  /** Subscribe an inbox (or raw listener) to a topic. Returns unsubscribe. */
  subscribeTopic(
    topic: TopicName,
    sub: { agentId?: AgentAddress; listener?: (message: AgentMessage) => void },
  ): () => void {
    if (!topic.startsWith("topic:")) throw new Error(`topic names must start with "topic:" (got "${topic}")`);
    const set = this.topics.get(topic) ?? new Set<TopicSubscription>();
    const entry: TopicSubscription = {
      ...(sub.agentId ? { inboxAgentId: sub.agentId } : {}),
      ...(sub.listener ? { listener: sub.listener } : {}),
    };
    set.add(entry);
    this.topics.set(topic, set);
    return () => set.delete(entry);
  }

  topicNames(): TopicName[] {
    return [...this.topics.keys()];
  }

  /** Bounded envelope history, newest last. */
  history(filter?: {
    from?: AgentAddress;
    to?: AgentAddress | "*";
    type?: string;
    conversationId?: string;
  }): AgentMessage[] {
    return this.historyBuffer.filter(
      (m) =>
        (!filter?.from || m.from === filter.from) &&
        (!filter?.to || m.to === filter.to) &&
        (!filter?.type || m.type === filter.type) &&
        (!filter?.conversationId || m.conversationId === filter.conversationId),
    );
  }

  private recordHistory(message: AgentMessage): void {
    this.historyBuffer.push(message);
    if (this.historyBuffer.length > this.historyLimit) {
      this.historyBuffer.splice(0, this.historyBuffer.length - this.historyLimit);
    }
  }
}
