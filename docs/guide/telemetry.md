# Telemetry (OpenTelemetry-compatible)

Nexum's internal observability (EventBus, ExecutionEventStore, correlation ids, control plane) is strong but process-local. This plane adds the **distributed-telemetry standards**: OTel-compatible spans exported over OTLP, and Prometheus-renderable metrics — with zero new runtime dependencies.

```
ExecutionEvent ─→ SpanEventMapper ─→ Tracer ─→ OTLP/HTTP JSON exporter (batched)
                     │
                     └─→ MetricsRegistry ─→ Prometheus text exposition
```

## Quick start

```ts
import { TelemetryService, telemetryFromEnv } from "@nemesis-oss/nexum";

const telemetry = new TelemetryService({ bus, ...telemetryFromEnv() }).start();
// ... runs happen on the EventBus ...
await telemetry.stop(); // flush remaining spans
```

Environment:

| Variable | Effect |
|---|---|
| `NEXUM_TELEMETRY_ENABLED=0` | Disable entirely |
| `NEXUM_OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP traces endpoint (e.g. `http://collector:4318/v1/traces`) |
| `NEXUM_OTEL_SERVICE_NAME` | Resource `service.name` (default `nexum`) |
| `NEXUM_OTEL_EXPORT_INTERVAL_MS` | Span batch flush interval (default 5000) |

## Tracing

`Tracer` produces OTel-semantics spans (trace/span ids, parent links, kinds, status, events). `SpanEventMapper` maps the kernel's ExecutionEvents automatically: run lifecycle → root span, tool calls → child spans keyed by event id (which embeds the runId), model/policy/delegation activity → events and metrics.

Exporters: `OtlpHttpExporter` (OTLP/HTTP JSON with resource + scope + Unix-nano timestamps — **never throws**, failures go to `onError`), `StdoutExporter` (JSON lines), `InMemorySpanExporter` (tests).

## Metrics

`MetricsRegistry` — counters, gauges, histograms with label dimensions and default latency buckets. Standard metrics wired from execution events:

| Metric | Labels |
|---|---|
| `nexum_runs_total` | `status` |
| `nexum_runs_started_total` | — |
| `nexum_tool_calls_total` | `tool`, `ok` |
| `nexum_model_calls_total` | `tier`, `model` |
| `nexum_policy_decisions_total` | `allowed`, `tool` |

`renderPrometheus(registry)` renders the Prometheus text exposition format (TYPE/HELP lines, `_bucket`/`_sum`/`_count` for histograms, escaped labels) — mount it behind any HTTP handler for scraping.

## Design notes

- Hand-rolled OTLP JSON instead of the OTel SDK: the runtime gains collector compatibility without new dependencies; the span model matches OTel semantics so a future SDK swap is mechanical.
- Telemetry failures are **reported, never thrown** — observation must not break the observed runtime.
- The control plane's `MetricSpec`/health system remains the ops view; this registry is the time-series view. Both can coexist on the same process.
