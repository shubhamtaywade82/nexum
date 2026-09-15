/**
 * Tests for the JobService.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService } from "../../src/jobs/index.js";

describe("JobService", () => {
  let tmpDir: string;
  let service: JobService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-jobs-"));
    service = new JobService({ maxConcurrent: 4 });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("submit", () => {
    it("submits a job and returns an id immediately", () => {
      const id = service.submit({
        description: "test job",
        run: async () => "done",
      });
      expect(id).toMatch(/^task_/);
    });

    it("runs the job and stores the result", async () => {
      const id = service.submit({
        description: "echo",
        run: async () => "hello",
      });
      // Wait for completion.
      await waitForState(service, id, "completed");
      const record = service.status(id);
      expect(record?.state).toBe("completed");
      expect(record?.result).toBe("hello");
    });

    it("captures job errors", async () => {
      const id = service.submit({
        description: "fail",
        run: async () => {
          throw new Error("boom");
        },
      });
      await waitForState(service, id, "failed");
      const record = service.status(id);
      expect(record?.state).toBe("failed");
      expect(record?.error).toBe("boom");
    });
  });

  describe("cancel", () => {
    it("cancels a running job via AbortSignal", async () => {
      const id = service.submit({
        description: "long",
        run: async (signal) => {
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new Error("aborted by signal"));
            });
          });
        },
      });
      await waitForState(service, id, "running");
      await service.cancel(id, "test cancel");
      await waitForState(service, id, ["cancelled", "failed"]);
      const record = service.status(id);
      expect(["cancelled", "failed"]).toContain(record?.state);
    });
  });

  describe("timeout", () => {
    it("enforces timeoutMs", async () => {
      const id = service.submit({
        description: "slow",
        timeoutMs: 50,
        run: async (signal) => {
          return new Promise<string>((_resolve, reject) => {
            const t = setTimeout(() => resolve(undefined as never), 1000);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error(signal.reason?.message ?? "aborted"));
            });
          });
        },
      });
      await waitForState(service, id, ["timed-out", "cancelled", "failed"]);
      const record = service.status(id);
      expect(["timed-out", "cancelled", "failed"]).toContain(record?.state);
    });
  });

  describe("list", () => {
    it("lists jobs filtered by state", async () => {
      service.submit({ description: "a", run: async () => 1 });
      service.submit({
        description: "b",
        run: async () => {
          throw new Error("x");
        },
      });
      await sleep(50);
      const completed = service.list({ state: "completed" });
      const failed = service.list({ state: "failed" });
      expect(completed.length).toBe(1);
      expect(failed.length).toBe(1);
    });

    it("lists jobs filtered by tag", () => {
      service.submit({ description: "a", tags: ["shell"], run: async () => 1 });
      service.submit({ description: "b", tags: ["tests"], run: async () => 2 });
      const shell = service.list({ tag: "shell" });
      expect(shell.length).toBe(1);
      expect(shell[0].description).toBe("a");
    });
  });

  describe("output", () => {
    it("captures emitted output lines", async () => {
      const id = service.submit({
        description: "log",
        run: async (_signal) => {
          // simulate a job that emits progress
          return "done";
        },
      });
      service.emit(id, "line 1");
      service.emit(id, "line 2");
      const output = service.output(id);
      expect(output).toEqual(["line 1", "line 2"]);
    });
  });

  describe("counts", () => {
    it("returns counts by state", async () => {
      service.submit({ description: "a", run: async () => 1 });
      service.submit({ description: "b", run: async () => 2 });
      await sleep(50);
      const counts = service.counts();
      expect(counts.completed).toBe(2);
    });
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(service: JobService, id: string, states: string | string[]): Promise<void> {
  const target = Array.isArray(states) ? states : [states];
  for (let i = 0; i < 100; i++) {
    const record = service.status(id);
    if (record && target.includes(record.state)) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for state ${target.join("|")} (last: ${service.status(id)?.state})`);
}

// Unused import cleanup.
void join;
void rmSync;
