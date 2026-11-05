/**
 * Tier 1 plugin sandbox — policy mediation around PluginContext operations.
 *
 * All tests are in-process and deterministic; no worker threads here (see
 * plugin-sandbox-isolated.test.ts for Tier 2).
 */
import { describe, it, expect } from "@jest/globals";
import { DefaultPluginHost } from "../../src/platform/plugins/host.js";
import {
  sandboxPlugin,
  PluginSandboxViolation,
  PluginSandboxTimeout,
  type NexumPlugin,
} from "../../src/platform/plugins/sandbox.js";

describe("sandboxPlugin (Tier 1 — policy mediation)", () => {
  describe("provide", () => {
    it("allows tokens matching the provide allow-list", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "p", name: "p", version: "1.0.0" },
        setup(ctx) {
          ctx.provide("nexum:tools:catalog", { size: 1 });
          ctx.provide("nexum:tools:gateway", { size: 2 });
        },
      };
      const sandboxed = sandboxPlugin(inner, { provide: ["nexum:tools:*"] });
      const host = new DefaultPluginHost();
      host.register(sandboxed);
      await host.start();
      expect(host.provides("nexum:tools:catalog")).toBe(true);
      expect(host.provides("nexum:tools:gateway")).toBe(true);
    });

    it("denies tokens outside the allow-list with PluginSandboxViolation", async () => {
      const violations: string[] = [];
      const inner: NexumPlugin = {
        manifest: { id: "p", name: "p", version: "1.0.0" },
        setup(ctx) {
          ctx.provide("nexum:models:registry", {});
        },
      };
      const sandboxed = sandboxPlugin(inner, {
        provide: ["nexum:tools:*"],
        onViolation: (v) => violations.push(`${v.operation}:${v.target}:${v.reason}`),
      });
      const host = new DefaultPluginHost();
      host.register(sandboxed);
      await host.start();
      // The host collects the error; the capability never lands.
      expect(host.get("p")?.state).toBe("error");
      expect(host.provides("nexum:models:registry")).toBe(false);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("provide");
      expect(violations[0]).toContain("nexum:models:registry");
    });

    it("denies everything when no allow-list is given (deny-by-default)", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "p", name: "p", version: "1.0.0" },
        setup(ctx) {
          ctx.provide("anything", 1);
        },
      };
      const host = new DefaultPluginHost();
      host.register(sandboxPlugin(inner, {}));
      await host.start();
      expect(host.get("p")?.state).toBe("error");
      expect(host.provides("anything")).toBe(false);
    });

    it("enforces the maxProvides cap", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "p", name: "p", version: "1.0.0" },
        setup(ctx) {
          ctx.provide("a", 1);
          ctx.provide("b", 2);
          ctx.provide("c", 3);
        },
      };
      const sandboxed = sandboxPlugin(inner, { provide: ["*"], maxProvides: 2 });
      const host = new DefaultPluginHost();
      host.register(sandboxed);
      await host.start();
      expect(host.provides("a")).toBe(true);
      expect(host.provides("b")).toBe(true);
      expect(host.provides("c")).toBe(false); // third provide denied
      expect(host.get("p")?.state).toBe("error");
      expect(sandboxed.sandbox.audit().some((e) => e.reason?.includes("cap reached"))).toBe(true);
    });
  });

  describe("lookup", () => {
    it("allows lookups matching the allow-list and returns the value", async () => {
      const seen: unknown[] = [];
      const provider: NexumPlugin = {
        manifest: { id: "provider", name: "provider", version: "1.0.0" },
        setup(ctx) {
          ctx.provide("nexum:jobs:service", { enqueue: 42 });
        },
      };
      const consumer: NexumPlugin = {
        manifest: { id: "consumer", name: "consumer", version: "1.0.0", dependencies: ["provider"] },
        setup(ctx) {
          const jobs = ctx.lookup<{ enqueue: number }>("nexum:jobs:service");
          seen.push(jobs);
        },
      };
      const host = new DefaultPluginHost();
      host.register(provider);
      host.register(sandboxPlugin(consumer, { lookup: ["nexum:jobs:*"] }));
      await host.start();
      expect(seen).toEqual([{ enqueue: 42 }]);
      expect(host.get("consumer")?.state).toBe("running");
    });

    it("denies lookups outside the allow-list (plugin cannot read other capabilities)", async () => {
      const provider: NexumPlugin = {
        manifest: { id: "provider", name: "provider", version: "1.0.0" },
        setup(ctx) {
          ctx.provide("nexum:secrets:service", { token: "s3cr3t" });
        },
      };
      const consumer: NexumPlugin = {
        manifest: { id: "consumer", name: "consumer", version: "1.0.0", dependencies: ["provider"] },
        setup(ctx) {
          ctx.lookup("nexum:secrets:service");
        },
      };
      const sandboxed = sandboxPlugin(consumer, { lookup: ["nexum:jobs:*"] });
      const host = new DefaultPluginHost();
      host.register(provider);
      host.register(sandboxed);
      await host.start();
      expect(host.get("consumer")?.state).toBe("error");
      const denied = sandboxed.sandbox.audit().filter((e) => e.decision === "denied");
      expect(denied).toHaveLength(1);
      expect(denied[0].target).toBe("nexum:secrets:service");
    });

    it("passes undefined through for allowed-but-missing capabilities (not a violation)", async () => {
      const seen: unknown[] = [];
      const consumer: NexumPlugin = {
        manifest: { id: "consumer", name: "consumer", version: "1.0.0" },
        setup(ctx) {
          seen.push(ctx.lookup("nexum:jobs:service"));
        },
      };
      const host = new DefaultPluginHost();
      host.register(sandboxPlugin(consumer, { lookup: ["nexum:jobs:*"] }));
      await host.start();
      expect(seen).toEqual([undefined]);
      expect(host.get("consumer")?.state).toBe("running");
    });
  });

  describe("declareCapability", () => {
    it("allows declared tags within the allow-list", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "p", name: "p", version: "1.0.0" },
        setup(ctx) {
          ctx.declareCapability("tools");
        },
      };
      const host = new DefaultPluginHost();
      host.register(sandboxPlugin(inner, { declare: ["tools"] }));
      await host.start();
      expect(host.byCapability("tools").map((r) => r.manifest.id)).toEqual(["p"]);
    });

    it("denies capability tags outside the allow-list", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "p", name: "p", version: "1.0.0" },
        setup(ctx) {
          ctx.declareCapability("models");
        },
      };
      const host = new DefaultPluginHost();
      host.register(sandboxPlugin(inner, { declare: ["tools"] }));
      await host.start();
      expect(host.get("p")?.state).toBe("error");
      expect(host.byCapability("models")).toHaveLength(0);
    });
  });

  describe("timeouts", () => {
    it("turns a hanging setup into PluginSandboxTimeout and an error state", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "hang", name: "hang", version: "1.0.0" },
        setup() {
          return new Promise<void>(() => {
            /* never resolves */
          });
        },
      };
      const sandboxed = sandboxPlugin(inner, { setupTimeoutMs: 150 });
      const host = new DefaultPluginHost();
      host.register(sandboxed);
      await host.start();
      const record = host.get("hang");
      expect(record?.state).toBe("error");
      expect(record?.error).toContain("timed out");
    });

    it("turns a hanging start into an error", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "hang-start", name: "hang-start", version: "1.0.0" },
        start() {
          return new Promise<void>(() => {
            /* never resolves */
          });
        },
      };
      const host = new DefaultPluginHost();
      host.register(sandboxPlugin(inner, { startTimeoutMs: 150 }));
      await host.start();
      expect(host.get("hang-start")?.state).toBe("error");
    });

    it("does not fire when the plugin is fast", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "fast", name: "fast", version: "1.0.0" },
        async setup() {
          await new Promise((r) => setTimeout(r, 10));
        },
      };
      const host = new DefaultPluginHost();
      host.register(sandboxPlugin(inner, { setupTimeoutMs: 5_000 }));
      await host.start();
      expect(host.get("fast")?.state).toBe("running");
    });

    it("timeout of 0 disables the timebox", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "slow", name: "slow", version: "1.0.0" },
        async setup() {
          await new Promise((r) => setTimeout(r, 50));
        },
      };
      const host = new DefaultPluginHost();
      host.register(sandboxPlugin(inner, { setupTimeoutMs: 0 }));
      await host.start();
      expect(host.get("slow")?.state).toBe("running");
    });
  });

  describe("audit + integration", () => {
    it("records allowed and denied operations in the audit trail", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "audited", name: "audited", version: "1.0.0" },
        setup(ctx) {
          try {
            ctx.lookup("forbidden");
          } catch {
            /* expected */
          }
          ctx.provide("allowed-token", 1);
        },
      };
      const sandboxed = sandboxPlugin(inner, {
        provide: ["allowed-*"],
        lookup: ["other-*"],
      });
      const host = new DefaultPluginHost();
      host.register(sandboxed);
      await host.start();
      const audit = sandboxed.sandbox.audit();
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "lookup", target: "forbidden", decision: "denied" }),
          expect.objectContaining({ operation: "provide", target: "allowed-token", decision: "allowed" }),
        ]),
      );
    });

    it("exposes the original manifest so dependency resolution is unchanged", async () => {
      const dep: NexumPlugin = { manifest: { id: "dep", name: "dep", version: "1.0.0" } };
      const dependent: NexumPlugin = {
        manifest: { id: "dependent", name: "dependent", version: "1.0.0", dependencies: ["dep"] },
      };
      const host = new DefaultPluginHost();
      host.register(sandboxPlugin(dep, {}));
      host.register(sandboxPlugin(dependent, {}));
      expect(host.resolveOrder()).toEqual(["dep", "dependent"]);
      await host.start();
      expect(host.get("dependent")?.state).toBe("running");
    });

    it("PluginSandboxViolation carries structured violation details", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "p", name: "p", version: "1.0.0" },
        setup(ctx) {
          ctx.provide("nope", 1);
        },
      };
      const sandboxed = sandboxPlugin(inner, {});
      const fakeCtx = {
        manifest: inner.manifest,
        host: {} as never,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        provide: () => undefined,
        lookup: () => undefined,
        declareCapability: () => undefined,
      };
      await expect(sandboxed.setup?.(fakeCtx)).rejects.toThrow(PluginSandboxViolation);
      // The audit trail records the denial even when the plugin swallows it.
      expect(sandboxed.sandbox.audit()).toHaveLength(1);
    });

    it("an unsandboxed plugin keeps legacy behaviour (no mediation)", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "legacy", name: "legacy", version: "1.0.0" },
        setup(ctx) {
          ctx.provide("anything.at.all", 1);
          ctx.declareCapability("whatever");
        },
      };
      const host = new DefaultPluginHost();
      host.register(inner);
      await host.start();
      expect(host.provides("anything.at.all")).toBe(true);
      expect(host.get("legacy")?.state).toBe("running");
    });

    it("stop timeout surfaces through host stop()", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "hang-stop", name: "hang-stop", version: "1.0.0" },
        stop() {
          return new Promise<void>(() => {
            /* never resolves */
          });
        },
      };
      const host = new DefaultPluginHost();
      host.register(sandboxPlugin(inner, { stopTimeoutMs: 150 }));
      await host.start();
      await host.stop();
      expect(host.get("hang-stop")?.state).toBe("error");
      expect(host.get("hang-stop")?.error).toContain("stop");
    });

    it("PluginSandboxTimeout error names are distinguishable", async () => {
      const inner: NexumPlugin = {
        manifest: { id: "x", name: "x", version: "1.0.0" },
        setup() {
          return new Promise<void>(() => {});
        },
      };
      const sandboxed = sandboxPlugin(inner, { setupTimeoutMs: 100 });
      const host = new DefaultPluginHost();
      const errors: unknown[] = [];
      host.on("plugin:setup:error", (r) => errors.push(r.error));
      host.register(sandboxed);
      await host.start();
      expect(errors[0]).toContain("timed out");
      // Name check via direct construction.
      const t = new PluginSandboxTimeout("m", "x", "setup", 5);
      expect(t.name).toBe("PluginSandboxTimeout");
      const v = new PluginSandboxViolation("m", {
        pluginId: "x",
        operation: "provide",
        target: "t",
        reason: "r",
        at: "now",
      });
      expect(v.name).toBe("PluginSandboxViolation");
    });
  });
});
