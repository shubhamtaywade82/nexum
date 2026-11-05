/**
 * MetricsRegistry — counters, gauges, histograms; Prometheus-renderable.
 *
 * Deliberately small and dependency-free: the standard runtime metrics
 * (runs, tool calls, model calls, policy decisions, latency) live here and
 * render straight into the Prometheus text exposition format for scraping
 * (see prometheus.ts). The control plane's MetricSpec system remains the
 * health/ops view; this registry is the high-cardinality time-series view.
 */

export type MetricType = "counter" | "gauge" | "histogram";

export interface CounterSnapshot {
  name: string;
  labels: Record<string, string>;
  value: number;
}
export interface GaugeSnapshot {
  name: string;
  labels: Record<string, string>;
  value: number;
}
export interface HistogramSnapshot {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: Array<{ le: number; count: number }>;
}

export interface MetricsSnapshot {
  counters: CounterSnapshot[];
  gauges: GaugeSnapshot[];
  histograms: HistogramSnapshot[];
}

export const DEFAULT_BUCKETS: readonly number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function labelKey(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",");
}

interface CounterState {
  value: number;
}
interface GaugeState {
  value: number;
}
interface HistogramState {
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: number[]; // cumulative counts aligned with DEFAULT_BUCKETS + Inf
}

export class MetricsRegistry {
  private readonly counters = new Map<string, CounterState>();
  private readonly gauges = new Map<string, GaugeState>();
  private readonly histograms = new Map<string, HistogramState>();
  private readonly buckets: readonly number[];

  constructor(buckets: readonly number[] = DEFAULT_BUCKETS) {
    this.buckets = buckets;
  }

  /** Increment a counter (optionally by n). */
  inc(name: string, labels: Record<string, string> = {}, n = 1): void {
    this.assertName(name);
    const key = `${name}{${labelKey(labels)}}`;
    const state = this.counters.get(key) ?? { value: 0 };
    state.value += n;
    this.counters.set(key, state);
  }

  /** Set a gauge. */
  set(name: string, labels: Record<string, string> = {}, value: number): void {
    this.assertName(name);
    this.gauges.set(`${name}{${labelKey(labels)}}`, { value });
  }

  /** Observe a histogram value. */
  observe(name: string, labels: Record<string, string> = {}, value: number): void {
    this.assertName(name);
    const key = `${name}{${labelKey(labels)}}`;
    const state =
      this.histograms.get(key) ??
      ({
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        buckets: new Array(this.buckets.length + 1).fill(0),
      } as HistogramState);
    state.count += 1;
    state.sum += value;
    state.min = Math.min(state.min, value);
    state.max = Math.max(state.max, value);
    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        state.buckets[i] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) state.buckets[this.buckets.length] += 1; // +Inf bucket
    this.histograms.set(key, state);
  }

  counterValue(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(`${name}{${labelKey(labels)}}`)?.value ?? 0;
  }

  gaugeValue(name: string, labels: Record<string, string> = {}): number | undefined {
    return this.gauges.get(`${name}{${labelKey(labels)}}`)?.value;
  }

  snapshot(): MetricsSnapshot {
    const parseKey = (key: string): { name: string; labels: Record<string, string> } => {
      const brace = key.indexOf("{");
      if (brace < 0) return { name: key, labels: {} };
      const name = key.slice(0, brace);
      const labels: Record<string, string> = {};
      for (const part of splitLabels(key.slice(brace + 1, key.length - 1))) {
        const eq = part.indexOf("=");
        if (eq > 0)
          labels[part.slice(0, eq)] = part
            .slice(eq + 2, -1)
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
      }
      return { name, labels };
    };

    const counters: CounterSnapshot[] = [...this.counters.entries()].map(([key, state]) => ({
      ...parseKey(key),
      value: state.value,
    }));
    const gauges: GaugeSnapshot[] = [...this.gauges.entries()].map(([key, state]) => ({
      ...parseKey(key),
      value: state.value,
    }));
    const histograms: HistogramSnapshot[] = [...this.histograms.entries()].map(([key, state]) => ({
      ...parseKey(key),
      count: state.count,
      sum: round(state.sum),
      min: round(state.min),
      max: round(state.max),
      buckets: [
        ...this.buckets.map((le, i) => ({ le, count: state.buckets.slice(0, i + 1).reduce((s, c) => s + c, 0) })),
        { le: Number.POSITIVE_INFINITY, count: state.count },
      ],
    }));
    return { counters, gauges, histograms };
  }

  private assertName(name: string): void {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`invalid metric name "${name}" (must match ${NAME_PATTERN})`);
    }
  }
}

function splitLabels(joined: string): string[] {
  // Split on commas that are not inside quoted values.
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === '"' && joined[i - 1] !== "\\") inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts.filter(Boolean);
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
