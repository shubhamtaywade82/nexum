import { createRedisClient } from "../../src/infrastructure/redis/client.js";
import { RedisEventBus } from "../../src/infrastructure/redis/pubsub.js";
import type { Redis } from "ioredis";

export const DEFAULT_TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

export class RedisHarness {
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;
  private bus: RedisEventBus | null = null;

  async start(url = DEFAULT_TEST_REDIS_URL): Promise<RedisEventBus> {
    this.pubClient = createRedisClient(url);
    this.subClient = createRedisClient(url);
    await this.pubClient.ping();
    await this.subClient.ping();
    this.bus = new RedisEventBus(this.pubClient, this.subClient);
    return this.bus;
  }

  get eventBus(): RedisEventBus {
    if (!this.bus) throw new Error("RedisHarness not started");
    return this.bus;
  }

  async stop(): Promise<void> {
    if (this.bus) {
      await this.bus.close();
      this.bus = null;
      this.pubClient = null;
      this.subClient = null;
    }
  }
}
