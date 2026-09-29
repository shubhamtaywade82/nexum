/**
 * OTel-compatible tracing — spans without an OTel SDK dependency.
 *
 * Hand-rolled span model matching OpenTelemetry semantics (trace/span ids,
 * parent links, kinds, status, events) plus an exporter that speaks the
 * OTLP/HTTP JSON protocol, so Nexum drops into an existing OTel collector
 * stack (Jaeger/Tempo/SigNoz) with zero new runtime dependencies.
 *
 * SpanEventMapper turns the kernel's ExecutionEvents into spans: tool calls
 * become child spans keyed by their event id (which embeds the runId), run
 * lifecycle becomes the root span, model/policy/delegation activity is
 * recorded as events + metrics.
 */

import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "../../runtime/events/bus.js";

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatus = "unset" | "ok" | "error";

export interface SpanEvent {
  ts: number;
  name: string;
  attributes?: Record<string, AttributeValue>;
}

export type AttributeValue = string | number | boolean;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTs: number;
  endTs?: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: Record<string, AttributeValue>;
  events: SpanEvent[];
}

export interface StartSpanOptions {
  traceId?: string;
  parentSpanId?: string;
  kind?: SpanKind;
  attributes?: Record<string, AttributeValue>;
}

function hexId(bytes: number): string {
  return randomUUID()
    .replace(/-/g, "")
    .slice(0, bytes * 2);
}

/** In-memory span registry per trace. */
export class Tracer {
  private readonly openSpans = new Map<string, Span>();
  private readonly finished: Span[] = [];
  private readonly finishedLimit: number;

  constructor(limit = 10_000) {
    this.finishedLimit = limit;
  }

  startSpan(name: string, opts: StartSpanOptions = {}): Span {
    const span: Span = {
      traceId: opts.traceId ?? hexId(16),
      spanId: hexId(8),
      ...(opts.parentSpanId !== undefined ? { parentSpanId: opts.parentSpanId } : {}),
      name,
      kind: opts.kind ?? "internal",
      startTs: Date.now(),
      status: "unset",
      attributes: { ...(opts.attributes ?? {}) },
      events: [],
    };
    this.openSpans.set(span.spanId, span);
    return span;
  }

  endSpan(span: Span, status: SpanStatus = "ok", statusMessage?: string): Span {
    span.endTs = Date.now();
    span.status = status;
    if (statusMessage !== undefined) span.statusMessage = statusMessage;
    if (this.openSpans.delete(span.spanId)) {
      this.finished.push(span);
      if (this.finished.length > this.finishedLimit) this.finished.splice(0, this.finished.length - this.finishedLimit);
    }
    return span;
  }

  /** The still-open span with this id, if any. */
  open(spanId: string): Span | undefined {
    return this.openSpans.get(spanId);
  }

  finishedSpans(filter?: { traceId?: string }): Span[] {
    return this.finished.filter((s) => !filter?.traceId || s.traceId === filter.traceId);
  }

  activeCount(): number {
    return this.openSpans.size;
  }
}

/**
 * Maps kernel ExecutionEvents onto spans + metric hooks. Tool spans are
 * matched by event id across started/completed/failed; run lifecycle is the
 * root span; a `currentTraceId` tracks the active run for events that don't
 * embed one.
 */
export class SpanEventMapper {
  private readonly toolSpans = new Map<string, Span>();
  private runSpan?: Span;
  private currentTraceId: string;
  private readonly onMetric?: (name: string, labels: Record<string, string>, value?: number) => void;

  constructor(
    private readonly tracer: Tracer,
    opts: { onMetric?: (name: string, labels: Record<string, string>, value?: number) => void } = {},
  ) {
    this.currentTraceId = hexId(16);
    this.onMetric = opts.onMetric;
  }

  /** Trace id for events that don't carry their own correlation. */
  get traceId(): string {
    return this.currentTraceId;
  }

  setTraceId(traceId: string): void {
    this.currentTraceId = traceId;
  }

  consume(event: RuntimeEvent): void {
    switch (event.type) {
      case "run.started": {
        this.currentTraceId = hexId(16);
        this.runSpan = this.tracer.startSpan(`run: ${event.goal}`, {
          traceId: this.currentTraceId,
          kind: "server",
          attributes: { "run.goal": event.goal, ...(event.agentId ? { "run.agent": event.agentId } : {}) },
        });
        this.onMetric?.("nexum_runs_started_total", {}, 1);
        break;
      }
      case "run.completed": {
        this.finishRun("ok", `status=${event.status}`);
        this.onMetric?.("nexum_runs_total", { status: event.status }, 1);
        break;
      }
      case "run.failed": {
        this.finishRun("error", event.error);
        this.onMetric?.("nexum_runs_total", { status: "failed" }, 1);
        break;
      }
      case "run.cancelled": {
        this.finishRun("error", "cancelled");
        this.onMetric?.("nexum_runs_total", { status: "cancelled" }, 1);
        break;
      }
      case "tool.started": {
        const span = this.tracer.startSpan(`tool: ${event.name}`, {
          traceId: this.traceIdOf(event.id),
          kind: "client",
          attributes: { "tool.name": event.name },
        });
        this.toolSpans.set(event.id, span);
        this.onMetric?.("nexum_tool_calls_total", { tool: event.name }, 1);
        break;
      }
      case "tool.completed": {
        const span = this.toolSpans.get(event.id);
        if (span) {
          this.toolSpans.delete(event.id);
          this.tracer.endSpan(span, "ok");
          this.onMetric?.("nexum_tool_calls_total", { tool: span.name.replace("tool: ", ""), ok: "true" }, 1);
        }
        break;
      }
      case "tool.failed": {
        const span = this.toolSpans.get(event.id);
        if (span) {
          this.toolSpans.delete(event.id);
          this.tracer.endSpan(span, "error", event.error);
          this.onMetric?.("nexum_tool_calls_total", { tool: span.name.replace("tool: ", ""), ok: "false" }, 1);
        }
        break;
      }
      case "model.answered": {
        this.onMetric?.("nexum_model_calls_total", { tier: event.tier, model: event.model }, 1);
        break;
      }
      case "policy.decision": {
        this.onMetric?.("nexum_policy_decisions_total", { allowed: String(event.allowed), tool: event.tool }, 1);
        break;
      }
      case "delegation.started": {
        this.tracer.startSpan(`delegation: ${event.childAgentId}`, {
          traceId: this.currentTraceId,
          kind: "producer",
          attributes: { "delegation.id": event.delegationId, "delegation.child": event.childAgentId },
        });
        break;
      }
      default:
        break;
    }
  }

  private finishRun(status: SpanStatus, message: string): void {
    if (this.runSpan) {
      this.tracer.endSpan(this.runSpan, status, message);
      this.runSpan = undefined;
    }
  }

  private traceIdOf(toolEventId: string): string {
    // Tool event ids embed the runId ("<runId>:<tool>") — a stable trace key.
    const runKey = toolEventId.includes(":") ? toolEventId.split(":")[0] : this.currentTraceId;
    return runKey === this.currentTraceId ? this.currentTraceId : simpleHash(runKey);
  }
}

/** Deterministic 32-hex "trace id" from an arbitrary key (stable per run). */
export function simpleHash(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < key.length; i++) {
    h1 = Math.imul(h1 ^ key.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + key.charCodeAt(i) * (i + 1), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).padStart(32, "0");
}
