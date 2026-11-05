/**
 * Tests for the durable job queue: leases, heartbeats, retries,
 * dead-lettering, reaping, dedupe, priority, and the worker loop.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJobQueue, QueueWorker } from "../../src/jobs/durable-queue.js";

describe("DurableJobQueue", () => {
  let dir: string;
  let queue: DurableJobQueue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-durable-"));
    queue = new DurableJobQueue(join(dir, "queue.db"));
  });

  afterEach(() => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("enqueues, claims under lease, and completes", () => {
    const id = queue.enqueue({ task: "scan" });
    expect(id).toMatch(/^job_/);
    expect(queue.stats()).toMatchObject({ queued: 1 });

    const claimed = queue.claim("w1", { leaseMs: 60_000 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].state).toBe("leased");
    expect(claimed[0].leasedBy).toBe("w1");
    expect(claimed[0].attempts).toBe(1);
    expect(queue.stats()).toMatchObject({ leased: 1, queued: 0 });

    // A second worker cannot claim the same job.
    expect(queue.claim("w2")).toHaveLength(0);

    expect(queue.complete(claimed[0].id, "w1", { lines: 3 })).toBe(true);
    expect(queue.get(claimed[0].id)).toMatchObject({ state: "done", result: { lines: 3 } });
    expect(queue.complete(claimed[0].id, "w1")).toBe(false); // not leased anymore
  });

  it("claims by priority and respects run_at delays", () => {
    queue.enqueue({ task: "low" }, { priority: -5 });
    queue.enqueue({ task: "high" }, { priority: 10 });
    queue.enqueue({ task: "later" }, { delayMs: 60_000 });

    const claimed = queue.claim("w1", { limit: 3 });
    expect(claimed.map((j) => (j.payload as { task: string }).task)).toEqual(["high", "low"]);
  });

  it("retries failures and dead-letters after maxAttempts", () => {
    const id = queue.enqueue({ task: "flaky" }, { maxAttempts: 2 })!;
    const first = queue.claim("w1")[0];
    expect(queue.fail(first.id, "w1", "timeout")).toBe("retried");
    expect(queue.get(id)?.state).toBe("queued");
    expect(queue.get(id)?.attempts).toBe(1);

    const second = queue.claim("w2")[0];
    expect(second.attempts).toBe(2);
    expect(queue.fail(second.id, "w2", "timeout again")).toBe("dead");
    const dead = queue.get(id);
    expect(dead?.state).toBe("dead");
    expect(dead?.error).toBe("timeout again");
    expect(queue.deadLetters()).toHaveLength(1);

    expect(queue.retryDead(id)).toBe(true);
    expect(queue.get(id)).toMatchObject({ state: "queued", attempts: 0 });
    expect(queue.retryDead(id)).toBe(false); // not dead anymore
  });

  it("fail() honors retry: false and ignores foreign workers", () => {
    const id = queue.enqueue({ task: "x" })!;
    const job = queue.claim("w1")[0];
    expect(queue.fail(job.id, "w2", "not mine")).toBe("ignored");
    expect(queue.fail(job.id, "w1", "fatal", { retry: false })).toBe("dead");
    expect(queue.get(id)?.state).toBe("dead");
  });

  it("extends leases via heartbeat and rejects stale heartbeats", () => {
    queue.enqueue({ task: "x" });
    const job = queue.claim("w1", { leaseMs: 10_000 })[0];
    expect(queue.heartbeat(job.id, "w1", 60_000)).toBe(true);
    expect(queue.get(job.id)?.leaseUntil).toBeGreaterThan(Date.now() + 30_000);
    expect(queue.heartbeat(job.id, "w2")).toBe(false);
  });

  it("reaps expired leases: retry first, dead-letter when exhausted", () => {
    const id = queue.enqueue({ task: "x" }, { maxAttempts: 2 })!;
    queue.claim("w1", { leaseMs: -1 }); // already expired; attempts = 1 < maxAttempts → back to queued
    expect(queue.reap()).toBe(1);
    expect(queue.get(id)?.state).toBe("queued");

    queue.claim("w2", { leaseMs: -1 }); // attempts = 2 = maxAttempts
    expect(queue.reap()).toBe(1);
    expect(queue.get(id)).toMatchObject({ state: "dead", error: "lease expired" });
  });

  it("refuses duplicate logical jobs via dedupeKey (effectively-once enqueue)", () => {
    const first = queue.enqueue({ n: 1 }, { dedupeKey: "invoice-42" });
    const duplicate = queue.enqueue({ n: 2 }, { dedupeKey: "invoice-42" });
    expect(first).toBeDefined();
    expect(duplicate).toBeUndefined();
    expect(queue.stats().queued).toBe(1);
    // Non-duplicate keys still enqueue.
    expect(queue.enqueue({ n: 3 }, { dedupeKey: "invoice-43" })).toBeDefined();
  });

  it("filters claims by tags", () => {
    queue.enqueue({ task: "shell" }, { tags: ["shell"] });
    queue.enqueue({ task: "research" }, { tags: ["research"] });
    const claimed = queue.claim("w1", { tags: ["research"] });
    expect(claimed).toHaveLength(1);
    expect((claimed[0].payload as { task: string }).task).toBe("research");
  });

  it("persists across queue instances (crash survival)", () => {
    const id = queue.enqueue({ task: "survive" })!;
    const claimed = queue.claim("w1", { leaseMs: 60_000 })[0];
    queue.close();

    const reopened = new DurableJobQueue(join(dir, "queue.db"));
    const job = reopened.get(id);
    expect(job?.state).toBe("leased"); // lease still held
    expect(job?.leasedBy).toBe("w1");
    expect(reopened.complete(claimed.id, "w1")).toBe(true);
    reopened.close();
  });
});

describe("QueueWorker", () => {
  let dir: string;
  let queue: DurableJobQueue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-worker-"));
    queue = new DurableJobQueue(join(dir, "queue.db"));
  });

  afterEach(async () => {
    await new QueueWorker(queue, async () => {}).stop();
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("processes jobs to completion and stops cleanly", async () => {
    const processed: string[] = [];
    const worker = new QueueWorker(
      queue,
      async (payload) => {
        processed.push(String((payload as { task: string }).task));
        return "ok";
      },
      { idleMs: 10, leaseMs: 5_000 },
    );
    queue.enqueue({ task: "a" });
    queue.enqueue({ task: "b" });
    worker.start();

    await waitFor(() => processed.length >= 2, 3000);
    await worker.stop();
    expect(processed.sort()).toEqual(["a", "b"]);
    expect(queue.stats()).toMatchObject({ done: 2 });
    expect(worker.isRunning()).toBe(false);
  });

  it("failed handlers retry then dead-letter", async () => {
    const attempts: number[] = [];
    const worker = new QueueWorker(
      queue,
      async (_payload, job) => {
        attempts.push(job.attempts);
        throw new Error("handler bug");
      },
      { idleMs: 5, leaseMs: 5_000 },
    );
    queue.enqueue({ task: "doomed" }, { maxAttempts: 2 });
    worker.start();

    await waitFor(() => queue.stats().dead === 1, 3000);
    await worker.stop();
    expect(attempts).toEqual([1, 2]);
    expect(queue.deadLetters()[0].error).toBe("handler bug");
  });
});

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}
