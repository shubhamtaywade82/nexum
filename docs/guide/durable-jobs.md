# Durable Job Queue

The JobService runs in-process background jobs — when the process dies, the work dies with it. The **DurableJobQueue** adds work that survives the process: jobs persisted in SQLite, claimed under **leases**, kept alive by **heartbeats**, reclaimed when a worker dies, and **dead-lettered** after too many attempts.

```
enqueue(payload, {dedupeKey})   effectively-once logical jobs
claim(worker, {leaseMs})        atomic lease — at most one worker per job
heartbeat(job, worker)          extend the lease while working
complete / fail(job, worker)    done | retry | dead-letter
reap()                         reclaim expired leases (crashed workers)
```

## Semantics

**At-least-once delivery, effectively-once effects**: `dedupeKey` refuses duplicate logical jobs at enqueue (unique partial index); a job may be redelivered after a lease expiry or worker crash, so handlers should be idempotent — the same contract SQS / River / Graphile Worker use.

## Queue

```ts
import { DurableJobQueue } from "@nemesis-oss/nexum";

const queue = new DurableJobQueue(".nexum/jobs.db");

const id = queue.enqueue({ taskId: "scan-42" }, {
  priority: 10,          // higher claims first
  delayMs: 60_000,       // don't run before now + 1min
  maxAttempts: 3,        // attempts before dead-letter (default 3)
  dedupeKey: "scan-42",  // refuse duplicates (returns undefined)
  tags: ["scan"],
});

const jobs = queue.claim("worker-1", { limit: 4, leaseMs: 30_000, tags: ["scan"] });
queue.heartbeat(jobs[0].id, "worker-1", 30_000);       // still working
queue.complete(jobs[0].id, "worker-1", { found: 3 });  // done
queue.fail(jobs[0].id, "worker-1", "timeout");          // retried or dead

queue.reap();            // expired leases → retry or dead-letter
queue.deadLetters();     // inspect + retryDead(id)
queue.stats();           // { queued, leased, done, failed, dead }
```

Leases are exclusive: a second worker cannot claim an in-flight job, and `complete`/`fail`/`heartbeat` only work for the leasing worker. `reap()` reclaims jobs whose lease expired (crashed worker): back to `queued` while attempts remain, `dead` when exhausted.

## Worker loop

```ts
import { QueueWorker } from "@nemesis-oss/nexum";

const worker = new QueueWorker(queue, async (payload, job) => {
  const result = await doWork(payload); // throw to fail/retry
  return result;
}, { batchSize: 4, leaseMs: 30_000, idleMs: 200, tags: ["scan"] }).start();

await worker.stop(); // waits for in-flight handlers
```

The worker claims batches, heartbeats each lease at `leaseMs/3`, runs handlers concurrently, and maps thrown errors to `fail()` (retry → dead-letter). `reap: false` disables its per-cycle reaping for multi-writer setups where an external reaper owns expiry.

## Persistence

Everything lives in one WAL-mode SQLite file (`durable_jobs` table) — enqueue a job in one process, claim it in another; leases, attempts, results, and errors are all durable across restarts.
