import { Redis } from "ioredis";

/**
 * Creates a fresh ioredis connection. Callers need at least two: pub/sub
 * requires a dedicated connection per side once `.subscribe()` is called
 * on it (a subscribed connection can no longer issue other commands) — see
 * pubsub.ts's RedisEventBus, which owns exactly one publisher + one
 * subscriber connection for the whole host process.
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}
