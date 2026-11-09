/**
 * A Redis outage must not hold a run open. The publisher's commands queue while
 * Redis is down (maxRetriesPerRequest is null), so an unbounded publish never settles.
 */
import { describe, it, expect } from "@jest/globals";
import type { Redis } from "ioredis";
import { RedisEventBus } from "../../src/infrastructure/redis/pubsub.js";

const neverSettles = (): Promise<number> => new Promise<number>(() => {});

function bus(publish: () => Promise<unknown>, publishTimeoutMs?: number): RedisEventBus {
  const publisher = { publish } as unknown as Redis;
  const subscriber = { on: () => undefined } as unknown as Redis;
  return new RedisEventBus(publisher, subscriber, { publishTimeoutMs });
}

describe("RedisEventBus.publish during an outage", () => {
  it("rejects once the publish has waited past its timeout, instead of hanging", async () => {
    const started = Date.now();
    await expect(bus(neverSettles, 50).publish("run:1", { type: "x" })).rejects.toThrow(/timed out after 50ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("passes the publish through when Redis answers in time", async () => {
    const calls: Array<[string, string]> = [];
    const publish = async (channel: string, payload: string) => {
      calls.push([channel, payload]);
      return 1;
    };
    await bus(publish, 50).publish("run:1", { type: "x" });
    expect(calls).toEqual([["run:1", JSON.stringify({ type: "x" })]]);
  });
});
