/**
 * Prometheus text exposition renderer.
 *
 * Renders a MetricsRegistry into the Prometheus scrape format
 * (https://prometheus.io/docs/instrumenting/exposition_formats/):
 *
 *   # HELP nexum_runs_total Total agent runs by status.
 *   # TYPE nexum_runs_total counter
 *   nexum_runs_total{status="completed"} 3
 *   # TYPE nexum_run_latency_ms histogram
 *   nexum_run_latency_ms_bucket{le="100"} 2
 *   ...
 */

import type { MetricsRegistry, MetricsSnapshot } from "./registry.js";

export function renderPrometheus(registry: MetricsRegistry, opts: { help?: Record<string, string> } = {}): string {
  return renderSnapshot(registry.snapshot(), opts);
}

export function renderSnapshot(snapshot: MetricsSnapshot, opts: { help?: Record<string, string> } = {}): string {
  const lines: string[] = [];
  const seenTypes = new Set<string>();

  const typeLine = (name: string, type: string) => {
    if (seenTypes.has(name)) return;
    seenTypes.add(name);
    const help = opts.help?.[name];
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  const renderLabels = (labels: Record<string, string>, extra?: string): string => {
    const entries = Object.entries(labels)
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .filter(Boolean);
    if (extra !== undefined) entries.push(extra);
    return entries.length > 0 ? `{${entries.join(",")}}` : "";
  };

  for (const counter of snapshot.counters) {
    typeLine(counter.name, "counter");
    lines.push(`${counter.name}${renderLabels(counter.labels)} ${counter.value}`);
  }
  for (const gauge of snapshot.gauges) {
    typeLine(gauge.name, "gauge");
    lines.push(`${gauge.name}${renderLabels(gauge.labels)} ${gauge.value}`);
  }
  for (const histogram of snapshot.histograms) {
    typeLine(histogram.name, "histogram");
    for (const bucket of histogram.buckets) {
      const le = bucket.le === Number.POSITIVE_INFINITY ? "+Inf" : String(bucket.le);
      lines.push(`${histogram.name}_bucket${renderLabels(histogram.labels, `le="${le}"`)} ${bucket.count}`);
    }
    lines.push(`${histogram.name}_sum${renderLabels(histogram.labels)} ${histogram.sum}`);
    lines.push(`${histogram.name}_count${renderLabels(histogram.labels)} ${histogram.count}`);
    if (histogram.count > 0) {
      lines.push(`${histogram.name}_min${renderLabels(histogram.labels)} ${histogram.min}`);
      lines.push(`${histogram.name}_max${renderLabels(histogram.labels)} ${histogram.max}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
