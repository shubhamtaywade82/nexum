/**
 * Process-wide telemetry: one TelemetryService (one metrics registry, one
 * OTLP exporter) shared by every Agent in the process — the host runs an
 * Agent per session, and per-agent registries would split /metrics and
 * multiply exporters. Agents feed it through their run recorder's live
 * sink (see Agent). Configured from NEXUM_TELEMETRY_ENABLED /
 * NEXUM_OTEL_EXPORTER_OTLP_ENDPOINT / NEXUM_OTEL_SERVICE_NAME.
 */

import { TelemetryService, telemetryFromEnv } from "./telemetry.js";
import { renderPrometheus } from "./metrics/prometheus.js";

let shared: TelemetryService | undefined;
let enabled = true;

export function processTelemetry(): TelemetryService {
  if (!shared) {
    const opts = telemetryFromEnv();
    enabled = opts.enabled !== false;
    shared = new TelemetryService({
      ...opts,
      onError: (message) => process.stderr.write(`[nexum telemetry] export failed: ${message}\n`),
    });
    if (enabled) shared.start();
  }
  return shared;
}

/** Event sink for run recorders; undefined when telemetry is disabled. */
export function telemetrySink(): { publish(event: { type: string }): void } | undefined {
  const telemetry = processTelemetry();
  if (!enabled) return undefined;
  return { publish: (event) => telemetry.record(event as Parameters<TelemetryService["record"]>[0]) };
}

/** Prometheus text exposition of the shared registry. */
export function prometheusMetrics(): string {
  return renderPrometheus(processTelemetry().metrics);
}

/** Flush pending spans (shutdown paths). Never throws. */
export async function flushProcessTelemetry(): Promise<void> {
  await shared?.flush().catch(() => undefined);
}

/** Test seam: drop the shared instance so the next call re-reads the env. */
export async function resetProcessTelemetry(): Promise<void> {
  await shared?.stop().catch(() => undefined);
  shared = undefined;
  enabled = true;
}
