import type { Redis } from "ioredis";

export type RedisEventHandler<T> = (event: T) => void;
export type Unsubscribe = () => Promise<void>;

/**
 * Thin pub/sub wrapper over two Redis connections (docs/plan §26: "don't
 * scatter redis.publish throughout the runtime" — callers use
 * eventBus.publish/.subscribe, never the ioredis client directly).
 *
 * Redis's own pub/sub delivers to whatever is subscribed at publish time
 * only (no backlog) — durability lives in Postgres (execution_events),
 * this class is purely the live fan-out layer.
 */
export interface RedisEventBusOptions {
  /**
   * How long a publish may wait for Redis before it fails. The publisher queues commands while Redis is
   * down (maxRetriesPerRequest is null), so without a bound a single publish can hold a run open forever.
   * Durability does not depend on this: events and status are persisted before they are published.
   */
  publishTimeoutMs?: number;
}

const DEFAULT_PUBLISH_TIMEOUT_MS = 1_000;

export class RedisEventBus {
  private readonly subscriptions = new Map<string, Set<RedisEventHandler<unknown>>>();

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly opts: RedisEventBusOptions = {},
  ) {
    this.subscriber.on("message", (channel: string, raw: string) => {
      const handlers = this.subscriptions.get(channel);
      if (!handlers || handlers.size === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // malformed payload — drop rather than crash the subscriber loop
      }
      for (const handler of [...handlers]) handler(parsed);
    });
  }

  async publish<T>(channel: string, event: T): Promise<void> {
    const timeoutMs = this.opts.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Redis publish to ${channel} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([this.publisher.publish(channel, JSON.stringify(event)), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Subscribes `handler` to `channel`; resolves once the SUBSCRIBE is acked
   * (so a caller can safely publish immediately after awaiting this without
   * losing the first event). Returns an unsubscribe function. */
  async subscribe<T>(channel: string, handler: RedisEventHandler<T>): Promise<Unsubscribe> {
    let handlers = this.subscriptions.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(channel, handlers);
      await this.subscriber.subscribe(channel);
    }
    handlers.add(handler as RedisEventHandler<unknown>);

    return async () => {
      const current = this.subscriptions.get(channel);
      if (!current) return;
      current.delete(handler as RedisEventHandler<unknown>);
      if (current.size === 0) {
        this.subscriptions.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
    };
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.publisher.ping();
      return res === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
