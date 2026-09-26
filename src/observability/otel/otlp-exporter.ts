/**
 * OTLP exporters — hand-rolled OTLP/HTTP JSON, no SDK dependency.
 *
 * OtlpHttpExporter POSTs finished spans to an OTLP collector endpoint
 * (e.g. http://collector:4318/v1/traces) in the standard OTLP JSON shape
 * (resourceSpans → scopeSpans → spans, Unix-nano timestamps, numeric span
 * kinds). Export failures are reported through onError and NEVER thrown —
 * telemetry must not break the runtime.
 *
 * StdoutExporter prints one JSON line per batch (dev / CI debugging).
 */

import type { Span, SpanKind } from "./trace.js";

export type SpanExporter = {
  export(spans: Span[]): Promise<void>;
};

const OTLP_KIND: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

const OTLP_STATUS: Record<string, number> = { unset: 0, ok: 1, error: 2 };

function toAttributes(attributes: Record<string, string | number | boolean>) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value:
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "number"
          ? { doubleValue: value }
          : { boolValue: value },
  }));
}

export function spanToOtlp(span: Span) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: OTLP_KIND[span.kind],
    startTimeUnixNano: String(span.startTs * 1e6),
    ...(span.endTs !== undefined ? { endTimeUnixNano: String(span.endTs * 1e6) } : {}),
    attributes: toAttributes(span.attributes),
    status: { code: OTLP_STATUS[span.status] ?? 0, ...(span.statusMessage ? { message: span.statusMessage } : {}) },
    events: span.events.map((event) => ({
      timeUnixNano: String(event.ts * 1e6),
      name: event.name,
      ...(event.attributes ? { attributes: toAttributes(event.attributes) } : {}),
    })),
  };
}

export interface OtlpHttpExporterOptions {
  /** Full OTLP traces endpoint (e.g. http://localhost:4318/v1/traces). */
  endpoint: string;
  serviceName?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Injection point for tests. */
  fetchImpl?: typeof fetch;
  onError?: (error: string) => void;
}

export class OtlpHttpExporter implements SpanExporter {
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError?: (error: string) => void;

  constructor(opts: OtlpHttpExporterOptions) {
    this.endpoint = opts.endpoint;
    this.serviceName = opts.serviceName ?? "nexum";
    this.headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onError = opts.onError;
  }

  async export(spans: Span[]): Promise<void> {
    if (spans.length === 0) return;
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: toAttributes({ "service.name": this.serviceName }),
          },
          scopeSpans: [
            {
              scope: { name: "nexum.runtime", version: "1" },
              spans: spans.map(spanToOtlp),
            },
          ],
        },
      ],
    });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: this.headers,
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          this.onError?.(`OTLP export HTTP ${response.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Never throw: telemetry must not break the runtime.
      this.onError?.(err instanceof Error ? err.message : String(err));
    }
  }
}

export class StdoutExporter implements SpanExporter {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async export(spans: Span[]): Promise<void> {
    if (spans.length === 0) return;
    for (const span of spans) {
      this.log(
        JSON.stringify({
          traceId: span.traceId,
          spanId: span.spanId,
          name: span.name,
          durationMs: span.endTs !== undefined ? span.endTs - span.startTs : null,
          status: span.status,
        }),
      );
    }
  }
}

/** Collects spans in memory (tests / inspection). */
export class InMemorySpanExporter implements SpanExporter {
  readonly exported: Span[] = [];

  async export(spans: Span[]): Promise<void> {
    this.exported.push(...spans);
  }
}
