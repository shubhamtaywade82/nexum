/**
 * Observability plane — budget accounting + OTel-compatible telemetry
 * (spans, OTLP export, Prometheus-renderable metrics).
 */

export type { TokenBudget } from "./budget.js";
export { createTokenBudget, budgetFromEnv, recordUsage, totalUsed } from "./budget.js";

export type { TelemetryOptions, EnvTelemetryOptions } from "./telemetry.js";
export { TelemetryService, telemetryFromEnv } from "./telemetry.js";

export type { Span, SpanKind, SpanStatus, SpanEvent, AttributeValue, StartSpanOptions } from "./otel/trace.js";
export { Tracer, SpanEventMapper, simpleHash } from "./otel/trace.js";

export type { SpanExporter } from "./otel/otlp-exporter.js";
export { OtlpHttpExporter, StdoutExporter, InMemorySpanExporter, spanToOtlp } from "./otel/otlp-exporter.js";

export type {
  MetricType,
  CounterSnapshot,
  GaugeSnapshot,
  HistogramSnapshot,
  MetricsSnapshot,
} from "./metrics/registry.js";
export { MetricsRegistry, DEFAULT_BUCKETS } from "./metrics/registry.js";
export { renderPrometheus } from "./metrics/prometheus.js";
