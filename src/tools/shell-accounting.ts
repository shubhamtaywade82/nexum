/**
 * Shell lifecycle / resource accounting (review item 27).
 *
 * Every sandbox execution is tracked by:
 *   containerId, cpu limit, memory limit, pids limit, network mode,
 *   duration, output bytes, exit status — plus live docker-stats samples
 * (CPU %, memory bytes) taken while the container runs — and the metadata
 * is PERSISTED (JSONL under the workspace state dir) so post-mortems,
 * budget audits and replay can see exactly what each shell call cost.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ShellExecutionRecord {
  /** Container name/id from docker run --name. */
  containerId: string;
  /** Correlation (runId/agentId/toolCallId — review item 33). */
  runId?: string;
  agentId?: string;
  toolCallId?: string;
  command: string;
  /** Declared resource limits (from docker args). */
  cpuLimit: string;
  memoryLimitMb: string;
  pidsLimit: number;
  networkMode: string;
  image: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  stdoutBytes: number;
  stderrBytes: number;
  exitStatus?: number | null;
  error?: string;
  timeoutSec?: number;
  /** Best-effort live usage samples (docker stats --no-stream). */
  samples: Array<{ ts: number; cpuPercent?: string; memUsage?: string; memBytes?: number; pids?: number }>;
}

export interface ShellAccountantOptions {
  /** JSONL file for durable execution metadata (e.g. .nexum/shell-executions.jsonl). */
  file?: string;
  /** Stats sampling interval while a container runs (default 2000ms; 0 disables). */
  sampleIntervalMs?: number;
  /** Records kept in memory (default 200). */
  maxMemoryRecords?: number;
}

export class ShellExecutionAccountant {
  private readonly records: ShellExecutionRecord[] = [];
  private readonly file?: string;
  private readonly sampleIntervalMs: number;
  private readonly maxMemoryRecords: number;

  constructor(opts: ShellAccountantOptions = {}) {
    this.file = opts.file;
    this.sampleIntervalMs = opts.sampleIntervalMs ?? 2000;
    this.maxMemoryRecords = opts.maxMemoryRecords ?? 200;
  }

  /**
   * Begin tracking one sandbox execution. Returns the record handle: the
   * ShellTool updates bytes/exit/duration as data arrives, and
   * `complete()` persists it.
   */
  begin(
    exec: Omit<ShellExecutionRecord, "samples" | "stdoutBytes" | "stderrBytes" | "startedAt"> & { startedAt?: number },
  ): ShellExecutionRecord {
    const record: ShellExecutionRecord = {
      ...exec,
      startedAt: exec.startedAt ?? Date.now(),
      stdoutBytes: 0,
      stderrBytes: 0,
      samples: [],
    };
    return record;
  }

  /**
   * Start docker-stats sampling for a running container (best-effort).
   * Returns the stop function — call it when the container exits.
   */
  sampleContainer(record: ShellExecutionRecord): () => void {
    if (this.sampleIntervalMs <= 0) return () => undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const sample = await dockerStats(record.containerId);
      if (sample && !stopped) record.samples.push({ ts: Date.now(), ...sample });
    };
    void tick();
    const timer = setInterval(() => void tick(), this.sampleIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  /** Finish the record: duration + exit status + persistence. */
  complete(record: ShellExecutionRecord, exitStatus: number | null, error?: string): ShellExecutionRecord {
    record.endedAt = Date.now();
    record.durationMs = record.endedAt - record.startedAt;
    record.exitStatus = exitStatus;
    if (error) record.error = error;
    this.records.push(record);
    while (this.records.length > this.maxMemoryRecords) this.records.shift();
    this.persist(record);
    return record;
  }

  /** In-memory history (observability / audits). */
  history(): ShellExecutionRecord[] {
    return [...this.records];
  }

  /** Aggregate resource usage across executions. */
  totals(): {
    executions: number;
    totalDurationMs: number;
    totalOutputBytes: number;
    failures: number;
    timeouts: number;
    peakMemoryBytes: number;
  } {
    let totalDurationMs = 0;
    let totalOutputBytes = 0;
    let failures = 0;
    let timeouts = 0;
    let peakMemoryBytes = 0;
    for (const r of this.records) {
      totalDurationMs += r.durationMs ?? 0;
      totalOutputBytes += r.stdoutBytes + r.stderrBytes;
      if ((r.exitStatus ?? 0) !== 0) failures += 1;
      if (r.error === "TimeoutError") timeouts += 1;
      for (const s of r.samples) if ((s.memBytes ?? 0) > peakMemoryBytes) peakMemoryBytes = s.memBytes ?? 0;
    }
    return {
      executions: this.records.length,
      totalDurationMs,
      totalOutputBytes,
      failures,
      timeouts,
      peakMemoryBytes,
    };
  }

  private persist(record: ShellExecutionRecord): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // best-effort durability: in-memory accounting still works
    }
  }

  /** Compact summary for a tool result payload. */
  summarize(record: ShellExecutionRecord): Record<string, unknown> {
    const last = record.samples[record.samples.length - 1];
    return {
      containerId: record.containerId,
      durationMs: record.durationMs,
      cpuLimit: record.cpuLimit,
      memoryLimit: record.memoryLimitMb,
      pidsLimit: record.pidsLimit,
      networkMode: record.networkMode,
      outputBytes: record.stdoutBytes + record.stderrBytes,
      exitStatus: record.exitStatus,
      ...(last?.cpuPercent ? { cpuPercent: last.cpuPercent } : {}),
      ...(last?.memUsage ? { memUsage: last.memUsage } : {}),
      ...(last?.pids !== undefined ? { pids: last.pids } : {}),
    };
  }
}

/** One `docker stats --no-stream <container>` sample (best-effort). */
export function dockerStats(
  container: string,
): Promise<{ cpuPercent?: string; memUsage?: string; memBytes?: number; pids?: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}",
      container,
    ]);
    let out = "";
    let err = false;
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.on("error", () => {
      err = true;
      resolve(null);
    });
    proc.on("close", (code) => {
      if (err || code !== 0) return resolve(null);
      const [cpuPercent, memUsage, pids] = out.trim().split("\t");
      if (!cpuPercent) return resolve(null);
      const memBytes = parseMemUsage(memUsage);
      resolve({
        cpuPercent,
        memUsage,
        memBytes,
        pids: pids !== undefined ? Number(pids) || undefined : undefined,
      });
    });
    // never let a hung docker stats stall a tool call
    const guard = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, 5000);
    if (typeof guard.unref === "function") guard.unref();
  });
}

function parseMemUsage(usage?: string): number | undefined {
  if (!usage) return undefined;
  const match = usage.match(/^([\d.]+)\s*([KMGT]?i?B)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  return value * (multipliers[unit] ?? 1);
}
