import {
  processTelemetry,
  prometheusMetrics,
  resetProcessTelemetry,
  telemetrySink,
} from "../../src/observability/process-telemetry.js";

describe("process telemetry", () => {
  afterEach(async () => {
    delete process.env.NEXUM_TELEMETRY_ENABLED;
    await resetProcessTelemetry();
  });

  it("is a single shared instance fed by run events, rendered as Prometheus text", () => {
    const sink = telemetrySink()!;
    expect(processTelemetry()).toBe(processTelemetry());
    sink.publish({ type: "run.started", runId: "r1", agentId: "devagent", goal: "g", strategy: "react" } as never);
    sink.publish({ type: "run.completed", runId: "r1", status: "completed", durationMs: 12 } as never);
    const text = prometheusMetrics();
    expect(text).toContain("nexum_runs_started_total");
    expect(text).toMatch(/nexum_runs_total\{status="completed"\} 1/);
  });

  it("returns no sink when disabled", async () => {
    await resetProcessTelemetry();
    process.env.NEXUM_TELEMETRY_ENABLED = "0";
    expect(telemetrySink()).toBeUndefined();
  });
});
