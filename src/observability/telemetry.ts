/**
 * TelemetryService — one facade: EventBus → spans (OTLP export) + metrics.
 *
 *     ExecutionEvent ─→ SpanEventMapper ─→ Tracer ─→ OTLP exporter (batched)
 *                        │
 *                        └─→ MetricsRegistry ─→ Prometheus text (scrape)
 *
 * Environment configuration (product composition calls fromEnv()):
 *   NEXUM_TELEMETRY_ENABLED=0                      disable entirely
 *   NEXUM_OTEL_EXPORTER_OTLP_ENDPOINT=<url>        OTLP/HTTP traces endpoint
 *   NEXUM_OTEL_SERVICE_NAME=<name>                 resource service.name
 *   NEXUM_OTEL_EXPORT_INTERVAL_MS=<n>              batch flush interval
 *
 * Export/observation failures are reported, never thrown — telemetry must
 * not break the runtime it observes.
 */

import type { EventBus } from "../runtime/events/bus.js";
import { Tracer, SpanEventMapper } from "./otel/trace.js";
import type { SpanExporter } from "./otel/otlp-exporter.js";
import { OtlpHttpExporter } from "./otel/otlp-exporter.js";
import { MetricsRegistry } from "./metrics/registry.js";

export interface TelemetryOptions {
  bus?: EventBus;
  enabled?: boolean;
  exporter?: SpanExporter;
  metrics?: MetricsRegistry;
  /** Batch flush interval for span export (default 5000ms; 0 = manual only). */
  flushIntervalMs?: number;
  onError?: (error: string) => void;
}

export class TelemetryService {
  readonly tracer: Tracer;
  readonly metrics: MetricsRegistry;
  private readonly exporter?: SpanExporter;
  private readonly flushIntervalMs: number;
  private readonly onError?: (error: string) => void;
  private readonly bus?: EventBus;
  private mapper?: SpanEventMapper;
  private detachBus?: () => void;
  private flushTimer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(opts: TelemetryOptions = {}) {
    this.tracer = new Tracer();
    this.metrics = opts.metrics ?? new MetricsRegistry();
    this.exporter = opts.exporter;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.onError = opts.onError;
    this.bus = opts.bus;
    if (opts.bus) {
      this.mapper = new SpanEventMapper(this.tracer, {
        onMetric: (name, labels, value) => {
          if (value === 1) this.metrics.inc(name, labels);
          else if (value !== undefined) this.metrics.observe(name, labels, value);
        },
      });
    }
  }

  /** Start: attach the bus listener (constructor bus, or this call's) and the flush timer. */
  start(bus?: EventBus): this {
    const target = bus ?? this.bus;
    if (target && this.mapper) {
      this.detachBus = target.subscribe((event) => this.mapper?.consume(event));
    }
    if (this.exporter && this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
    this.started = true;
    return this;
  }

  /** Stop: detach and flush remaining spans. */
  async stop(): Promise<void> {
    this.detachBus?.();
    this.detachBus = undefined;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    await this.flush();
    this.started = false;
  }

  isRunning(): boolean {
    return this.started;
  }

  /** Export all finished spans (called by the timer and stop()). */
  async flush(): Promise<void> {
    if (!this.exporter) return;
    const spans = this.tracer.finishedSpans();
    if (spans.length === 0) return;
    try {
      await this.exporter.export(spans);
    } catch (err) {
      this.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  /** Feed a single event manually (bus-less embedding). */
  record(event: Parameters<SpanEventMapper["consume"]>[0]): void {
    this.mapper?.consume(event);
  }
}

export interface EnvTelemetryOptions {
  endpoint?: string;
  serviceName?: string;
  enabled?: boolean;
  flushIntervalMs?: number;
}

/** Resolve telemetry options from the NEXUM_* environment. */
export function telemetryFromEnv(env: EnvTelemetryOptions = {}): TelemetryOptions {
  const endpoint = env.endpoint ?? process.env.NEXUM_OTEL_EXPORTER_OTLP_ENDPOINT;
  const enabled = env.enabled ?? process.env.NEXUM_TELEMETRY_ENABLED !== "0";
  const serviceName = env.serviceName ?? process.env.NEXUM_OTEL_SERVICE_NAME ?? "nexum";
  const flushIntervalMs =
    env.flushIntervalMs ??
    (process.env.NEXUM_OTEL_EXPORT_INTERVAL_MS !== undefined
      ? Number(process.env.NEXUM_OTEL_EXPORT_INTERVAL_MS)
      : 5000);
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    ...(endpoint !== undefined ? { exporter: new OtlpHttpExporter({ endpoint, serviceName }) } : {}),
    flushIntervalMs,
  };
}
