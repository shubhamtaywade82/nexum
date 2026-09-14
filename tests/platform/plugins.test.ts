/**
 * Tests for the plugin system (PluginHost, PluginRegistry, dependency resolver).
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultPluginHost,
  definePlugin,
  pluginFromRegistration,
  resolvePluginOrder,
  validateManifest,
  type NexumPlugin,
  type PluginHost,
} from "../../src/platform/plugins/index.js";

describe("DefaultPluginHost", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-plugins-"));
  });

  describe("register", () => {
    it("registers a plugin and exposes its manifest", () => {
      const host = new DefaultPluginHost({ workspaceRoot: tmpDir });
      const plugin = definePlugin({
        manifest: { id: "test", name: "Test", version: "1.0.0" },
      });
      host.register(plugin);
      expect(host.has("test")).toBe(true);
      expect(host.get("test")?.manifest.name).toBe("Test");
    });

    it("throws on duplicate registration", () => {
      const host = new DefaultPluginHost();
      const plugin = definePlugin({
        manifest: { id: "dup", name: "Dup", version: "1.0.0" },
      });
      host.register(plugin);
      expect(() => host.register(plugin)).toThrow(/already registered/);
    });

    it("rejects invalid manifest (non-kebab-case id)", () => {
      const host = new DefaultPluginHost();
      const plugin = definePlugin({
        manifest: { id: "BadID", name: "Bad", version: "1.0.0" },
      });
      expect(() => host.register(plugin)).toThrow(/kebab-case/);
    });
  });

  describe("registerAll", () => {
    it("registers multiple plugins at once", () => {
      const host = new DefaultPluginHost();
      host.registerAll([
        definePlugin({ manifest: { id: "a", name: "A", version: "1.0.0" } }),
        definePlugin({ manifest: { id: "b", name: "B", version: "1.0.0" } }),
      ]);
      expect(host.ids?.length ?? host.all().length).toBe(2);
      expect(host.has("a")).toBe(true);
      expect(host.has("b")).toBe(true);
    });
  });

  describe("require", () => {
    it("throws with helpful message listing registered plugins", () => {
      const host = new DefaultPluginHost();
      host.register(definePlugin({ manifest: { id: "known", name: "Known", version: "1.0.0" } }));
      expect(() => host.require("missing")).toThrow(/unknown plugin "missing".*known/);
    });
  });

  describe("byCapability", () => {
    it("filters plugins by declared capability tag", async () => {
      const host = new DefaultPluginHost();
      host.register(
        definePlugin({
          manifest: { id: "a", name: "A", version: "1.0.0", provides: ["tools"] },
          setup(ctx) {
            ctx.declareCapability("tools");
          },
        }),
      );
      host.register(definePlugin({ manifest: { id: "b", name: "B", version: "1.0.0", provides: ["models"] } }));
      await host.start();
      const tools = host.byCapability("tools");
      expect(tools.length).toBe(1);
      expect(tools[0].manifest.id).toBe("a");
      await host.stop();
    });
  });

  describe("start / stop lifecycle", () => {
    it("calls setup → start on each plugin in order", async () => {
      const calls: string[] = [];
      const host = new DefaultPluginHost();
      host.register(
        definePlugin({
          manifest: { id: "a", name: "A", version: "1.0.0" },
          setup() {
            calls.push("a:setup");
          },
          start() {
            calls.push("a:start");
          },
          stop() {
            calls.push("a:stop");
          },
        }),
      );
      await host.start();
      expect(calls).toEqual(["a:setup", "a:start"]);
      await host.stop();
      expect(calls).toEqual(["a:setup", "a:start", "a:stop"]);
    });

    it("respects dependencies (setup order)", async () => {
      const calls: string[] = [];
      const host = new DefaultPluginHost();
      host.register(
        definePlugin({
          manifest: { id: "b", name: "B", version: "1.0.0", dependencies: ["a"] },
          setup() {
            calls.push("b:setup");
          },
        }),
      );
      host.register(
        definePlugin({
          manifest: { id: "a", name: "A", version: "1.0.0" },
          setup() {
            calls.push("a:setup");
          },
        }),
      );
      await host.start();
      expect(calls).toEqual(["a:setup", "b:setup"]);
      await host.stop();
    });

    it("transitions failed plugin to error state but continues", async () => {
      const host = new DefaultPluginHost();
      host.register(
        definePlugin({
          manifest: { id: "bad", name: "Bad", version: "1.0.0" },
          setup() {
            throw new Error("setup failed");
          },
        }),
      );
      host.register(
        definePlugin({
          manifest: { id: "good", name: "Good", version: "1.0.0" },
        }),
      );
      await host.start();
      expect(host.get("bad")?.state).toBe("error");
      expect(host.get("good")?.state).toBe("running");
      await host.stop();
    });
  });

  describe("capability lookup (DI seam)", () => {
    it("allows plugins to provide and lookup capabilities", async () => {
      const host = new DefaultPluginHost();
      host.register(
        definePlugin({
          manifest: { id: "provider", name: "Provider", version: "1.0.0" },
          setup(ctx) {
            ctx.provide("my-service", { hello: () => "world" });
          },
        }),
      );
      host.register(
        definePlugin({
          manifest: { id: "consumer", name: "Consumer", version: "1.0.0", dependencies: ["provider"] },
          setup(ctx) {
            const svc = ctx.lookup<{ hello: () => string }>("my-service");
            if (!svc) throw new Error("my-service not provided");
          },
        }),
      );
      await host.start();
      expect(host.provides("my-service")).toBe(true);
      const svc = host.lookup<{ hello: () => string }>("my-service");
      expect(svc?.hello()).toBe("world");
      await host.stop();
    });

    it("throws when a plugin tries to override an existing capability", async () => {
      const host = new DefaultPluginHost();
      host.register(
        definePlugin({
          manifest: { id: "a", name: "A", version: "1.0.0" },
          setup(ctx) {
            ctx.provide("token", "from-a");
          },
        }),
      );
      host.register(
        definePlugin({
          manifest: { id: "b", name: "B", version: "1.0.0" },
          setup(ctx) {
            ctx.provide("token", "from-b"); // should throw
          },
        }),
      );
      await host.start();
      expect(host.get("b")?.state).toBe("error");
      expect(host.get("b")?.error).toMatch(/already provided/);
      await host.stop();
    });
  });

  describe("events", () => {
    it("emits plugin:register event on registration", () => {
      const host = new DefaultPluginHost();
      const events: string[] = [];
      host.on("plugin:register", (record) => {
        events.push(record.manifest.id);
      });
      host.register(definePlugin({ manifest: { id: "a", name: "A", version: "1.0.0" } }));
      expect(events).toEqual(["a"]);
    });
  });
});

describe("pluginFromRegistration", () => {
  it("wraps a simple registration callback as a plugin", async () => {
    let called = false;
    const plugin = pluginFromRegistration(
      { id: "reg", name: "Reg", version: "1.0.0" },
      () => {
        called = true;
      },
    );
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();
    expect(called).toBe(true);
    await host.stop();
  });
});

describe("resolvePluginOrder", () => {
  it("returns plugins in dependency order", () => {
    const plugins: NexumPlugin[] = [
      { manifest: { id: "c", name: "C", version: "1.0.0", dependencies: ["a", "b"] } },
      { manifest: { id: "b", name: "B", version: "1.0.0", dependencies: ["a"] } },
      { manifest: { id: "a", name: "A", version: "1.0.0" } },
    ];
    const result = resolvePluginOrder(plugins);
    expect(result.order).toEqual(["a", "b", "c"]);
    expect(result.cycles).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("detects missing dependencies", () => {
    const plugins: NexumPlugin[] = [
      { manifest: { id: "a", name: "A", version: "1.0.0", dependencies: ["nonexistent"] } },
    ];
    const result = resolvePluginOrder(plugins);
    expect(result.missing).toEqual([{ id: "a", missing: ["nonexistent"] }]);
  });

  it("detects cycles", () => {
    const plugins: NexumPlugin[] = [
      { manifest: { id: "a", name: "A", version: "1.0.0", dependencies: ["b"] } },
      { manifest: { id: "b", name: "B", version: "1.0.0", dependencies: ["a"] } },
    ];
    const result = resolvePluginOrder(plugins);
    expect(result.cycles.length).toBeGreaterThan(0);
  });

  it("is stable (alphabetical tie-breaking)", () => {
    const plugins: NexumPlugin[] = [
      { manifest: { id: "z", name: "Z", version: "1.0.0" } },
      { manifest: { id: "a", name: "A", version: "1.0.0" } },
      { manifest: { id: "m", name: "M", version: "1.0.0" } },
    ];
    const result = resolvePluginOrder(plugins);
    expect(result.order).toEqual(["a", "m", "z"]);
  });
});

describe("validateManifest", () => {
  it("returns no issues for a valid manifest", () => {
    const issues = validateManifest({ id: "valid-id", name: "Valid", version: "1.0.0" });
    expect(issues).toEqual([]);
  });

  it("flags non-kebab-case id", () => {
    const issues = validateManifest({ id: "BadID", name: "Bad", version: "1.0.0" });
    expect(issues.some((i) => i.includes("kebab-case"))).toBe(true);
  });

  it("flags missing name", () => {
    const issues = validateManifest({ id: "x", name: "", version: "1.0.0" });
    expect(issues.some((i) => i.includes("name"))).toBe(true);
  });

  it("flags non-semver version", () => {
    const issues = validateManifest({ id: "x", name: "X", version: "latest" });
    expect(issues.some((i) => i.includes("semver"))).toBe(true);
  });

  it("flags self-dependency", () => {
    const issues = validateManifest({
      id: "x",
      name: "X",
      version: "1.0.0",
      dependencies: ["x"],
    });
    expect(issues.some((i) => i.includes("depends on itself"))).toBe(true);
  });
});
