/**
 * Tests for the telemetry plane: tracer + event mapping, OTLP exporter,
 * metrics registry, Prometheus rendering, and the TelemetryService facade.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import type { RuntimeEvent } from "../../src/runtime/events/bus.js";
import { Tracer, SpanEventMapper, simpleHash } from "../../src/observability/otel/trace.js";
import {
  OtlpHttpExporter,
  StdoutExporter,
  InMemorySpanExporter,
  spanToOtlp,
} from "../../src/observability/otel/otlp-exporter.js";
import { MetricsRegistry } from "../../src/observability/metrics/registry.js";
import { renderPrometheus } from "../../src/observability/metrics/prometheus.js";
import { TelemetryService, telemetryFromEnv } from "../../src/observability/telemetry.js";
import { EventBus } from "../../src/runtime/events/bus.js";

describe("Tracer", () => {
  it("creates spans with ids, parents, kinds, and finishes them", () => {
    const tracer = new Tracer();
    const parent = tracer.startSpan("run: goal", { kind: "server" });
    const child = tracer.startSpan("tool: read_file", {
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      kind: "client",
    });
    expect(parent.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(parent.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(tracer.activeCount()).toBe(2);

    tracer.endSpan(child, "ok");
    expect(tracer.activeCount()).toBe(1);
    const finished = tracer.finishedSpans({ traceId: parent.traceId });
    expect(finished).toHaveLength(1);
    expect(finished[0].name).toBe("tool: read_file");
    expect(finished[0].endTs).toBeGreaterThanOrEqual(finished[0].startTs);
  });

  it("bounds finished span memory", () => {
    const tracer = new Tracer(5);
    for (let i = 0; i < 20; i++) {
      const span = tracer.startSpan(`s${i}`);
      tracer.endSpan(span);
    }
    expect(tracer.finishedSpans()).toHaveLength(5);
  });
});

describe("SpanEventMapper", () => {
  it("maps a run lifecycle to a root span and tool events to child spans", () => {
    const tracer = new Tracer();
    const metrics: string[] = [];
    const mapper = new SpanEventMapper(tracer, { onMetric: (name) => metrics.push(name) });

    const events: RuntimeEvent[] = [
      { type: "run.started", goal: "fix the bug", agentId: "devagent" },
      { type: "tool.started", id: "run_1:read_file", name: "read_file", args: {} },
      { type: "tool.completed", id: "run_1:read_file", result: {} },
      { type: "tool.started", id: "run_1:shell", name: "shell", args: {} },
      { type: "tool.failed", id: "run_1:shell", error: "exit 1" },
      { type: "model.answered", tier: "local", model: "qwen3" },
      { type: "policy.decision", tool: "shell", allowed: true, requireConfirmation: false, reason: "ok" },
      { type: "run.completed", status: "completed" },
    ];
    for (const event of events) mapper.consume(event);

    const spans = tracer.finishedSpans();
    const run = spans.find((s) => s.name === "run: fix the bug");
    expect(run?.status).toBe("ok");
    const shell = spans.find((s) => s.name === "tool: shell");
    expect(shell?.status).toBe("error");
    expect(shell?.statusMessage).toBe("exit 1");
    expect(spans.find((s) => s.name === "tool: read_file")?.status).toBe("ok");
    expect(metrics).toContain("nexum_runs_started_total");
    expect(metrics).toContain("nexum_model_calls_total");
    expect(metrics).toContain("nexum_policy_decisions_total");
  });

  it("stable trace ids per embedded runId", () => {
    expect(simpleHash("run_1")).toBe(simpleHash("run_1"));
    expect(simpleHash("run_1")).not.toBe(simpleHash("run_2"));
    expect(simpleHash("x")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("OtlpHttpExporter", () => {
  it("POSTs OTLP JSON with resource and nano timestamps", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const exporter = new OtlpHttpExporter({
      endpoint: "http://collector:4318/v1/traces",
      serviceName: "nexum-test",
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const tracer = new Tracer();
    const span = tracer.startSpan("run: g", { kind: "server" });
    tracer.endSpan(span, "ok");

    await exporter.export(tracer.finishedSpans());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://collector:4318/v1/traces");
    const body = JSON.parse(String(calls[0].init.body)) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
        scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
      }>;
    };
    expect(body.resourceSpans[0].resource.attributes[0]).toEqual({
      key: "service.name",
      value: { stringValue: "nexum-test" },
    });
    const otlpSpan = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(otlpSpan.kind).toBe(2); // server
    expect(otlpSpan.status.code).toBe(1); // ok
    expect(String(otlpSpan.startTimeUnixNano)).toMatch(/^\d+$/);
  });

  it("never throws on export failure", async () => {
    const errors: string[] = [];
    const exporter = new OtlpHttpExporter({
      endpoint: "http://down",
      onError: (e) => errors.push(e),
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    const tracer = new Tracer();
    tracer.endSpan(tracer.startSpan("x"));
    await expect(exporter.export(tracer.finishedSpans())).resolves.toBeUndefined();
    expect(errors).toEqual(["connection refused"]);
  });

  it("stdout and in-memory exporters work", async () => {
    const lines: string[] = [];
    const stdout = new StdoutExporter((line) => lines.push(line));
    const tracer = new Tracer();
    tracer.endSpan(tracer.startSpan("s"));
    await stdout.export(tracer.finishedSpans());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).name).toBe("s");

    const memory = new InMemorySpanExporter();
    await memory.export(tracer.finishedSpans());
    expect(memory.exported).toHaveLength(1);
  });

  it("spanToOtlp maps kinds and attributes", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("t", {
      kind: "producer",
      attributes: { "tool.name": "shell", attempts: 2, ok: true },
    });
    const otlp = spanToOtlp(span);
    expect(otlp.kind).toBe(4);
    expect(otlp.attributes).toEqual([
      { key: "tool.name", value: { stringValue: "shell" } },
      { key: "attempts", value: { doubleValue: 2 } },
      { key: "ok", value: { boolValue: true } },
    ]);
  });
});

describe("MetricsRegistry + Prometheus", () => {
  it("counts, sets, and observes with label dimensions", () => {
    const registry = new MetricsRegistry();
    registry.inc("nexum_runs_total", { status: "completed" });
    registry.inc("nexum_runs_total", { status: "completed" });
    registry.inc("nexum_runs_total", { status: "failed" });
    registry.set("nexum_active_agents", {}, 3);
    registry.observe("nexum_run_latency_ms", {}, 50);
    registry.observe("nexum_run_latency_ms", {}, 5000);

    expect(registry.counterValue("nexum_runs_total", { status: "completed" })).toBe(2);
    expect(registry.gaugeValue("nexum_active_agents")).toBe(3);
    const histogram = registry.snapshot().histograms[0];
    expect(histogram.count).toBe(2);
    expect(histogram.sum).toBe(5050);
    expect(histogram.buckets.find((b) => b.le === 100)?.count).toBe(1);
    expect(histogram.buckets.find((b) => b.le === Number.POSITIVE_INFINITY)?.count).toBe(2);
  });

  it("rejects invalid metric names", () => {
    const registry = new MetricsRegistry();
    expect(() => registry.inc("bad name")).toThrow("invalid metric name");
  });

  it("renders the Prometheus text exposition format", () => {
    const registry = new MetricsRegistry();
    registry.inc("nexum_runs_total", { status: "completed" }, 3);
    registry.observe("nexum_run_latency_ms", {}, 42);
    const text = renderPrometheus(registry, { help: { nexum_runs_total: "Total agent runs by status." } });

    expect(text).toContain("# HELP nexum_runs_total Total agent runs by status.");
    expect(text).toContain("# TYPE nexum_runs_total counter");
    expect(text).toContain('nexum_runs_total{status="completed"} 3');
    expect(text).toContain("# TYPE nexum_run_latency_ms histogram");
    expect(text).toContain('nexum_run_latency_ms_bucket{le="50"} 1');
    expect(text).toContain("nexum_run_latency_ms_count 1");
    expect(text).toContain("nexum_run_latency_ms_sum 42");
  });
});

describe("TelemetryService", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("wires bus events to spans and metrics, flushing on stop", async () => {
    const exporter = new InMemorySpanExporter();
    const service = new TelemetryService({ bus, exporter, flushIntervalMs: 0 }).start();

    bus.publish({ type: "run.started", goal: "goal", agentId: "devagent" });
    bus.publish({ type: "tool.started", id: "run_1:shell", name: "shell", args: {} });
    bus.publish({ type: "tool.completed", id: "run_1:shell", result: {} });
    bus.publish({ type: "run.completed", status: "completed" });

    expect(service.metrics.counterValue("nexum_runs_total", { status: "completed" })).toBe(1);
    expect(service.metrics.counterValue("nexum_tool_calls_total", { tool: "shell" })).toBe(1);
    expect(service.isRunning()).toBe(true);

    await service.stop();
    expect(service.isRunning()).toBe(false);
    const names = exporter.exported.map((s) => s.name);
    expect(names).toContain("run: goal");
    expect(names).toContain("tool: shell");
  });

  it("detaches from the bus on stop", async () => {
    const service = new TelemetryService({ bus, flushIntervalMs: 0 }).start();
    await service.stop();
    bus.publish({ type: "run.started", goal: "after stop" });
    expect(service.tracer.finishedSpans()).toHaveLength(0);
  });

  it("telemetryFromEnv respects the kill switch and endpoint", () => {
    process.env.NEXUM_TELEMETRY_ENABLED = "0";
    expect(telemetryFromEnv()).toEqual({ enabled: false });
    delete process.env.NEXUM_TELEMETRY_ENABLED;

    process.env.NEXUM_OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/v1/traces";
    const opts = telemetryFromEnv();
    expect(opts.enabled).toBe(true);
    expect(opts.exporter).toBeDefined();
    delete process.env.NEXUM_OTEL_EXPORTER_OTLP_ENDPOINT;
  });
});
