/**
 * ControlPlaneService — runtime observability + control.
 *
 * Nexum already has budget tracking, event sourcing, and execution
 * recording. What's missing is a unified control plane that aggregates
 * these signals into a queryable, mutable runtime state:
 *
 *   - Metrics     (counters, gauges, histograms)
 *   - Health      (liveness, readiness checks)
 *   - Status      (active runs, queued jobs, subagent count)
 *   - Controls    (pause/resume/cancel runtime operations)
 *
 * This service is the model-facing observability layer. It exposes:
 *   - metrics() → snapshot of all metrics
 *   - health()  → liveness + readiness probes
 *   - status()  → overall runtime status
 *   - control(action, target) → runtime control operations
 *
 * The data is fed by:
 *   - EventBus subscriptions (execution/domain/state/presentation events)
 *   - ServiceRegistry lifecycle events
 *   - PluginHost state transitions
 *   - Direct metric calls from services (jobs, subagents, compaction)
 *
 * This is what an operator (CLI `nexum status`, RPC `control.status`,
 * dashboard UI) would call to see what's happening.
 */

import { EventEmitter } from "node:events";

// ── Contracts ───────────────────────────────────────────────────────────────

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricSpec {
  name: string;
  type: MetricType;
  description?: string;
  /** Labels for multi-dimensional metrics (e.g. {agent, tool}). */
  labels?: string[];
  /** For histograms: bucket boundaries. */
  buckets?: number[];
}

export interface MetricSnapshot {
  name: string;
  type: MetricType;
  value: number;
  /** For histograms: bucket counts. */
  buckets?: Record<string, number>;
  /** Sum (for histograms). */
  sum?: number;
  count?: number;
  /** Label values (for multi-dimensional metrics). */
  labels?: Record<string, string>;
  /** When the metric was last updated. */
  updatedAt: string;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  message?: string;
  /** When the check was last run. */
  checkedAt?: string;
}

export interface HealthReport {
  overall: HealthStatus;
  checks: HealthCheck[];
}

export type RuntimePhase = "starting" | "running" | "draining" | "stopped";

export interface RuntimeStatus {
  phase: RuntimePhase;
  activeRuns: number;
  queuedJobs: number;
  activeSubagents: number;
  memoryUsageMb: number;
  uptimeMs: number;
  startedAt: string;
}

export type ControlAction =
  | "pause" // stop accepting new work
  | "resume" // accept new work again
  | "drain" // finish in-flight work, then stop
  | "shutdown"; // immediate shutdown

export interface ControlRequest {
  action: ControlAction;
  /** Target: "all" or a specific service id. */
  target?: string;
  /** Reason (audit). */
  reason?: string;
}

export interface ControlResponse {
  action: ControlAction;
  accepted: boolean;
  message?: string;
}

// ── ControlPlaneService ──────────────────────────────────────────────────────

export class ControlPlaneService extends EventEmitter {
  private readonly metrics = new Map<string, MetricSpec>();
  private readonly values = new Map<string, MetricSnapshot>();
  private readonly healthChecks = new Map<string, () => Promise<HealthCheck> | HealthCheck>();
  private phase: RuntimePhase = "stopped";
  private startedAt: string | null = null;
  private startedMs: number | null = null;

  // ── Metric registration ─────────────────────────────────────────────────

  registerMetric(spec: MetricSpec): this {
    if (this.metrics.has(spec.name)) {
      throw new Error(`metric "${spec.name}" already registered`);
    }
    this.metrics.set(spec.name, spec);
    return this;
  }

  /** Increment a counter. */
  increment(name: string, by: number = 1, labels?: Record<string, string>): void {
    const spec = this.metrics.get(name);
    if (!spec || spec.type !== "counter") return;
    const key = metricKey(name, labels);
    const existing = this.values.get(key);
    const value = (existing?.value ?? 0) + by;
    this.values.set(key, {
      name,
      type: "counter",
      value,
      labels,
      updatedAt: new Date().toISOString(),
    });
    this.emit("metric", { name, value, by });
  }

  /** Set a gauge value. */
  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    const spec = this.metrics.get(name);
    if (!spec || spec.type !== "gauge") return;
    const key = metricKey(name, labels);
    this.values.set(key, {
      name,
      type: "gauge",
      value,
      labels,
      updatedAt: new Date().toISOString(),
    });
    this.emit("metric", { name, value });
  }

  /** Observe a value for a histogram. */
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const spec = this.metrics.get(name);
    if (!spec || spec.type !== "histogram") return;
    const key = metricKey(name, labels);
    const existing = this.values.get(key);
    const buckets = existing?.buckets ?? {};
    const bucketKeys = spec.buckets ?? [1, 5, 10, 50, 100, 500, 1000];
    for (const boundary of bucketKeys) {
      if (value <= boundary) {
        const bucketKey = `<=${boundary}`;
        buckets[bucketKey] = (buckets[bucketKey] ?? 0) + 1;
      }
    }
    buckets[`>+∞`] = (buckets[`>+∞`] ?? 0) + 1;
    const sum = (existing?.sum ?? 0) + value;
    const count = (existing?.count ?? 0) + 1;
    this.values.set(key, {
      name,
      type: "histogram",
      value,
      buckets,
      sum,
      count,
      labels,
      updatedAt: new Date().toISOString(),
    });
    this.emit("metric", { name, value });
  }

  /** Get a snapshot of all metrics. */
  metricsSnapshot(): MetricSnapshot[] {
    return [...this.values.values()];
  }

  /** Get a single metric. */
  getMetric(name: string, labels?: Record<string, string>): MetricSnapshot | undefined {
    const key = metricKey(name, labels);
    return this.values.get(key);
  }

  // ── Health checks ─────────────────────────────────────────────────────────

  registerHealthCheck(name: string, check: () => Promise<HealthCheck> | HealthCheck): this {
    if (this.healthChecks.has(name)) {
      throw new Error(`health check "${name}" already registered`);
    }
    this.healthChecks.set(name, check);
    return this;
  }

  /** Run all health checks and return the overall status. */
  async health(): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    for (const [name, check] of this.healthChecks.entries()) {
      try {
        const result = await check();
        checks.push({ ...result, name, checkedAt: new Date().toISOString() });
      } catch (err) {
        checks.push({
          name,
          status: "unhealthy",
          message: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString(),
        });
      }
    }
    const overall = checks.some((c) => c.status === "unhealthy")
      ? "unhealthy"
      : checks.some((c) => c.status === "degraded")
        ? "degraded"
        : "healthy";
    return { overall, checks };
  }

  // ── Runtime status ───────────────────────────────────────────────────────

  /** Start the runtime (transition from stopped → running). */
  start(): void {
    if (this.phase === "running") return;
    this.phase = "running";
    this.startedAt = new Date().toISOString();
    this.startedMs = Date.now();
    this.emit("phase", this.phase);
  }

  /** Drain the runtime (finish in-flight, then stop). */
  drain(): void {
    if (this.phase !== "running") return;
    this.phase = "draining";
    this.emit("phase", this.phase);
  }

  /** Stop the runtime. */
  stop(): void {
    this.phase = "stopped";
    this.emit("phase", this.phase);
  }

  /** Apply a control action. */
  control(request: ControlRequest): ControlResponse {
    switch (request.action) {
      case "pause":
        if (this.phase === "running") {
          this.phase = "draining";
          this.emit("control", request);
          return { action: request.action, accepted: true, message: "runtime draining" };
        }
        return { action: request.action, accepted: false, message: `runtime in phase ${this.phase}` };
      case "resume":
        if (this.phase === "draining") {
          this.phase = "running";
          this.emit("control", request);
          return { action: request.action, accepted: true, message: "runtime resumed" };
        }
        return { action: request.action, accepted: false, message: `runtime in phase ${this.phase}` };
      case "drain":
        this.drain();
        return { action: request.action, accepted: true, message: "runtime draining" };
      case "shutdown":
        this.stop();
        return { action: request.action, accepted: true, message: "runtime stopped" };
      default:
        return { action: request.action, accepted: false, message: "unknown action" };
    }
  }

  /** Get the current runtime status. */
  status(statusInput?: { activeRuns?: number; queuedJobs?: number; activeSubagents?: number }): RuntimeStatus {
    const mem = process.memoryUsage();
    return {
      phase: this.phase,
      activeRuns: statusInput?.activeRuns ?? 0,
      queuedJobs: statusInput?.queuedJobs ?? 0,
      activeSubagents: statusInput?.activeSubagents ?? 0,
      memoryUsageMb: Math.round(mem.rss / 1024 / 1024),
      uptimeMs: this.startedMs ? Date.now() - this.startedMs : 0,
      startedAt: this.startedAt ?? "",
    };
  }

  /** Get the current phase. */
  getPhase(): RuntimePhase {
    return this.phase;
  }
}

// ── Default metric specs ─────────────────────────────────────────────────────

/** Register a default set of metrics for an agent runtime. */
export function registerDefaultMetrics(service: ControlPlaneService): void {
  service.registerMetric({
    name: "agent.runs.total",
    type: "counter",
    description: "Total agent runs started",
    labels: ["agent"],
  });
  service.registerMetric({
    name: "agent.runs.active",
    type: "gauge",
    description: "Currently active agent runs",
    labels: ["agent"],
  });
  service.registerMetric({
    name: "agent.runs.completed",
    type: "counter",
    description: "Completed agent runs",
    labels: ["agent", "status"],
  });
  service.registerMetric({
    name: "agent.runs.failed",
    type: "counter",
    description: "Failed agent runs",
    labels: ["agent"],
  });

  service.registerMetric({
    name: "tool.calls.total",
    type: "counter",
    description: "Total tool calls",
    labels: ["tool"],
  });
  service.registerMetric({
    name: "tool.calls.failed",
    type: "counter",
    description: "Failed tool calls",
    labels: ["tool"],
  });
  service.registerMetric({
    name: "tool.calls.duration_ms",
    type: "histogram",
    description: "Tool call duration (ms)",
    labels: ["tool"],
    buckets: [1, 10, 50, 100, 500, 1000, 5000],
  });

  service.registerMetric({
    name: "model.calls.total",
    type: "counter",
    description: "Total model calls",
    labels: ["model"],
  });
  service.registerMetric({
    name: "model.tokens.prompt",
    type: "counter",
    description: "Prompt tokens consumed",
    labels: ["model"],
  });
  service.registerMetric({
    name: "model.tokens.completion",
    type: "counter",
    description: "Completion tokens produced",
    labels: ["model"],
  });
  service.registerMetric({
    name: "model.latency_ms",
    type: "histogram",
    description: "Model call latency (ms)",
    labels: ["model"],
    buckets: [50, 200, 500, 1000, 5000, 30000],
  });

  service.registerMetric({ name: "subagents.active", type: "gauge", description: "Currently active subagents" });
  service.registerMetric({
    name: "subagents.spawned",
    type: "counter",
    description: "Total subagents spawned",
    labels: ["provider"],
  });

  service.registerMetric({ name: "jobs.active", type: "gauge", description: "Currently active jobs" });
  service.registerMetric({
    name: "jobs.completed",
    type: "counter",
    description: "Completed jobs",
    labels: ["status"],
  });

  service.registerMetric({ name: "compaction.events", type: "counter", description: "Compaction events" });
  service.registerMetric({
    name: "compaction.tokens_saved",
    type: "counter",
    description: "Tokens saved by compaction",
  });

  service.registerMetric({
    name: "webhooks.received",
    type: "counter",
    description: "Webhook events received",
    labels: ["endpoint", "verified"],
  });
  service.registerMetric({
    name: "webhooks.delivered",
    type: "counter",
    description: "Webhook events delivered to handlers",
    labels: ["endpoint"],
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function metricKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const labelStr = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return `${name}{${labelStr}}`;
}
