/**
 * Tests for the ControlPlaneService.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import { ControlPlaneService, registerDefaultMetrics } from "../../src/control-plane/index.js";

describe("ControlPlaneService", () => {
  let service: ControlPlaneService;

  beforeEach(() => {
    service = new ControlPlaneService();
    registerDefaultMetrics(service);
  });

  describe("metric registration", () => {
    it("throws on duplicate registration", () => {
      expect(() => service.registerMetric({ name: "agent.runs.total", type: "counter" })).toThrow(/already registered/);
    });
  });

  describe("counter", () => {
    it("increments a counter", () => {
      service.increment("agent.runs.total", 1, { agent: "devagent" });
      service.increment("agent.runs.total", 2, { agent: "devagent" });
      const metric = service.getMetric("agent.runs.total", { agent: "devagent" });
      expect(metric?.value).toBe(3);
      expect(metric?.type).toBe("counter");
    });

    it("tracks separate label values", () => {
      service.increment("agent.runs.total", 1, { agent: "devagent" });
      service.increment("agent.runs.total", 1, { agent: "crypto" });
      const dev = service.getMetric("agent.runs.total", { agent: "devagent" });
      const crypto = service.getMetric("agent.runs.total", { agent: "crypto" });
      expect(dev?.value).toBe(1);
      expect(crypto?.value).toBe(1);
    });

    it("emits metric events", () => {
      const events: Array<{ name: string; value: number }> = [];
      service.on("metric", (e) => events.push(e));
      service.increment("agent.runs.total", 1);
      expect(events.length).toBe(1);
      expect(events[0].name).toBe("agent.runs.total");
    });
  });

  describe("gauge", () => {
    it("sets a gauge value", () => {
      service.setGauge("agent.runs.active", 5, { agent: "devagent" });
      const metric = service.getMetric("agent.runs.active", { agent: "devagent" });
      expect(metric?.value).toBe(5);
    });
  });

  describe("histogram", () => {
    it("observes values and tracks buckets", () => {
      // spec.buckets for "tool.calls.duration_ms" is [1, 10, 50, 100, 500, 1000, 5000]
      service.observe("tool.calls.duration_ms", 5, { tool: "read_file" });
      service.observe("tool.calls.duration_ms", 50, { tool: "read_file" });
      service.observe("tool.calls.duration_ms", 2000, { tool: "read_file" });
      const metric = service.getMetric("tool.calls.duration_ms", { tool: "read_file" });
      expect(metric?.count).toBe(3);
      expect(metric?.sum).toBe(2055);
      expect(metric?.buckets).toBeDefined();
      // 5 is <=10, <=50, <=100, <=500, <=1000, <=5000
      expect(metric?.buckets?.["<=10"]).toBe(1);
      // 50 is <=50, <=100, <=500, <=1000, <=5000
      expect(metric?.buckets?.["<=50"]).toBe(2);
      // 2000 is <=5000 only
      expect(metric?.buckets?.["<=1000"]).toBe(2);
      expect(metric?.buckets?.["<=5000"]).toBe(3);
    });
  });

  describe("metricsSnapshot", () => {
    it("returns all metric snapshots", () => {
      service.increment("agent.runs.total");
      service.setGauge("agent.runs.active", 1);
      const snapshot = service.metricsSnapshot();
      expect(snapshot.length).toBeGreaterThan(0);
    });
  });

  describe("health checks", () => {
    it("returns healthy when all checks pass", async () => {
      service.registerHealthCheck("memory", () => ({ name: "memory", status: "healthy" }));
      const report = await service.health();
      expect(report.overall).toBe("healthy");
      expect(report.checks.length).toBe(1);
    });

    it("returns unhealthy when a check fails", async () => {
      service.registerHealthCheck("disk", () => ({ name: "disk", status: "unhealthy", message: "full" }));
      const report = await service.health();
      expect(report.overall).toBe("unhealthy");
    });

    it("returns degraded when a check is degraded", async () => {
      service.registerHealthCheck("network", () => ({ name: "network", status: "degraded" }));
      const report = await service.health();
      expect(report.overall).toBe("degraded");
    });

    it("catches thrown check errors", async () => {
      service.registerHealthCheck("bad", () => {
        throw new Error("check failed");
      });
      const report = await service.health();
      expect(report.overall).toBe("unhealthy");
      expect(report.checks[0].message).toContain("check failed");
    });

    it("throws on duplicate registration", () => {
      service.registerHealthCheck("dup", () => ({ name: "dup", status: "healthy" }));
      expect(() => service.registerHealthCheck("dup", () => ({ name: "dup", status: "healthy" }))).toThrow(
        /already registered/,
      );
    });
  });

  describe("phase control", () => {
    it("starts in stopped phase", () => {
      expect(service.getPhase()).toBe("stopped");
    });

    it("transitions through start → drain → stop", () => {
      service.start();
      expect(service.getPhase()).toBe("running");
      service.drain();
      expect(service.getPhase()).toBe("draining");
      service.stop();
      expect(service.getPhase()).toBe("stopped");
    });

    it("emits phase events", () => {
      const events: string[] = [];
      service.on("phase", (p) => events.push(p));
      service.start();
      service.stop();
      expect(events).toEqual(["running", "stopped"]);
    });
  });

  describe("control actions", () => {
    it("pause while running → draining", () => {
      service.start();
      const resp = service.control({ action: "pause" });
      expect(resp.accepted).toBe(true);
      expect(service.getPhase()).toBe("draining");
    });

    it("resume while draining → running", () => {
      service.start();
      service.control({ action: "pause" });
      const resp = service.control({ action: "resume" });
      expect(resp.accepted).toBe(true);
      expect(service.getPhase()).toBe("running");
    });

    it("drain transitions to draining", () => {
      service.start();
      const resp = service.control({ action: "drain" });
      expect(resp.accepted).toBe(true);
      expect(service.getPhase()).toBe("draining");
    });

    it("shutdown transitions to stopped", () => {
      service.start();
      const resp = service.control({ action: "shutdown" });
      expect(resp.accepted).toBe(true);
      expect(service.getPhase()).toBe("stopped");
    });

    it("pause while not running is rejected", () => {
      const resp = service.control({ action: "pause" });
      expect(resp.accepted).toBe(false);
    });
  });

  describe("status", () => {
    it("returns runtime status with phase + memory", () => {
      service.start();
      const status = service.status({ activeRuns: 3, queuedJobs: 5, activeSubagents: 2 });
      expect(status.phase).toBe("running");
      expect(status.activeRuns).toBe(3);
      expect(status.queuedJobs).toBe(5);
      expect(status.activeSubagents).toBe(2);
      expect(status.memoryUsageMb).toBeGreaterThan(0);
      expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(status.startedAt).toBeTruthy();
    });
  });

  describe("registerDefaultMetrics", () => {
    it("registers all expected metrics", () => {
      // After beforeEach already calls registerDefaultMetrics, check a few.
      const snapshot = service.metricsSnapshot();
      // No values yet — snapshot is empty until metrics are observed.
      expect(snapshot.length).toBe(0);
      // Increment to verify registration.
      service.increment("agent.runs.total");
      service.increment("tool.calls.total", 1, { tool: "x" });
      service.increment("model.calls.total", 1, { model: "y" });
      expect(service.metricsSnapshot().length).toBe(3);
    });
  });
});
