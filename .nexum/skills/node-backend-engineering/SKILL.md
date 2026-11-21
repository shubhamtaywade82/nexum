---
name: node-backend-engineering
description: Production Node.js backend engineering and workspace patterns. Use when implementing async concurrency, resource cleanup, process signal handling, runtime validation, database integrations, or monorepo package boundaries.
---

# Node.js Backend & Workspace Engineering

Apply these patterns to ensure resilient, leak-free, and high-performance Node.js service architecture.

## 1. Structured Async Concurrency & Error Propagation

- Never leave floating promises unhandled (`void doAsyncWork()` must catch or log).
- Distinguish between `Promise.all` (fail-fast) and `Promise.allSettled` (independent worker batches).
- Wrap top-level route/job handlers in error handling that forwards to the logger or next error middleware.

```typescript
export async function executeInParallelBatches<T, R>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((item) => worker(item)));
    results.push(...batchResults);
  }
  return results;
}
```

---

## 2. Cancellation & Timeouts via AbortSignal

Always propagate `AbortSignal` through async call chains (HTTP fetch, child processes, database transactions, timers) to prevent zombie processes and leaked event listeners.

```typescript
export async function runWithTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
```

---

## 3. Process Lifecycle & Graceful Shutdown

Handle process signals (`SIGTERM`, `SIGINT`) cleanly:

1. Stop accepting new incoming requests.
2. Allow active in-flight jobs to complete or abort cleanly within a drain deadline.
3. Close database pools, MCP connections, and temporary scratch worktrees.
4. Exit with code 0 on clean exit, or 1 on timeout/failure.

```typescript
export function registerGracefulShutdown(cleanup: () => Promise<void>, timeoutMs = 10_000): void {
  const handler = async (signal: string) => {
    console.log(`Received ${signal}, starting graceful shutdown...`);
    const forceExit = setTimeout(() => process.exit(1), timeoutMs);
    forceExit.unref();
    try {
      await cleanup();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      console.error("Error during graceful shutdown:", err);
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => handler("SIGTERM"));
  process.once("SIGINT", () => handler("SIGINT"));
}
```

---

## 4. Atomic File Mutations & CAS (Compare-And-Swap)

When modifying files in workspaces or state stores:

- Write to a temporary file first (`${path}.tmp.${Date.now()}`).
- Flush with `fs.promises.rename` for POSIX atomic replacement.
- Use explicit file locks for multi-process concurrency.
