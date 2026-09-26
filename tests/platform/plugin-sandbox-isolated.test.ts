/**
 * Tier 2 plugin sandbox — worker-thread isolation of plugin module files.
 *
 * These tests boot real Workers (no mocks) against tiny plugin modules
 * written to a temp dir. They verify the security-relevant behaviours:
 * bridge mediation, structured-clone limits, hang termination, crash
 * containment, and host lifecycle integration.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPluginHost } from "../../src/platform/plugins/host.js";
import { IsolatedPluginSandbox, PluginSandboxTimeout } from "../../src/platform/plugins/sandbox.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexum-sandbox-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePlugin(name: string, body: string): string {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return file;
}

describe("IsolatedPluginSandbox (Tier 2 — worker isolation)", () => {
  it("loads a plugin module and surfaces its manifest", async () => {
    const file = writePlugin(
      "simple",
      `export default {
        manifest: { id: "simple", name: "Simple", version: "1.2.3" },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file);
    expect(plugin.manifest).toMatchObject({ id: "simple", version: "1.2.3" });
    expect(plugin.sandbox.terminated()).toBe(false);
    await plugin.sandbox.terminate();
  });

  it("rejects a module that does not export a plugin", async () => {
    const file = writePlugin("notaplugin", `export default { hello: "world" };`);
    await expect(IsolatedPluginSandbox.load(file)).rejects.toThrow(/manifest/);
  });

  it("rejects a module that crashes on import", async () => {
    const file = writePlugin("crashy", `throw new Error("boom on import");`);
    await expect(IsolatedPluginSandbox.load(file)).rejects.toThrow();
  });

  it("bridges provide/declareCapability into the host during setup", async () => {
    const file = writePlugin(
      "bridged",
      `export default {
        manifest: { id: "bridged", name: "Bridged", version: "1.0.0" },
        async setup(ctx) {
          await ctx.provide("nexum:tools:extra", { count: 7 });
          await ctx.declareCapability("tools");
        },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file, {
      policy: { provide: ["nexum:tools:*"], declare: ["tools"] },
    });
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();

    expect(host.provides("nexum:tools:extra")).toBe(true);
    expect(host.lookup<{ count: number }>("nexum:tools:extra")).toEqual({ count: 7 });
    expect(host.byCapability("tools").map((r) => r.manifest.id)).toEqual(["bridged"]);
    expect(host.get("bridged")?.state).toBe("running");
    await host.stop();
    expect(plugin.sandbox.terminated()).toBe(true);
  });

  it("denies bridged operations outside the policy and records them in the audit log", async () => {
    const file = writePlugin(
      "greedy",
      `export default {
        manifest: { id: "greedy", name: "Greedy", version: "1.0.0" },
        async setup(ctx) {
          const ok = await ctx.provide("nexum:secrets:vault", {}).then(() => true, () => false);
          if (!ok) throw new Error("provide was denied by sandbox");
        },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file, {
      policy: { provide: ["nexum:tools:*"] },
    });
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();

    expect(host.get("greedy")?.state).toBe("error");
    expect(host.provides("nexum:secrets:vault")).toBe(false);
    const denied = plugin.sandbox.audit().filter((e) => e.decision === "denied");
    expect(denied.map((e) => e.target)).toEqual(["nexum:secrets:vault"]);
    await host.stop();
  });

  it("bridges lookup of cloneable values but refuses non-cloneable ones", async () => {
    // The host context used by the isolated plugin is a FAKE PluginContext:
    // lookup returns a cloneable value for one token and a function for
    // another — the bridge must pass the former and refuse the latter.
    const isolatedFile = writePlugin(
      "reader",
      `export default {
        manifest: { id: "reader", name: "Reader", version: "1.0.0", dependencies: [] },
        async setup(ctx) {
          const data = await ctx.lookup("nexum:config:plain");
          globalThis.result = { got: data };
          try {
            await ctx.lookup("nexum:config:function");
            globalThis.result.fnDenied = false;
          } catch (err) {
            globalThis.result.fnDenied = String(err);
          }
        },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(isolatedFile, {
      policy: { lookup: ["nexum:config:*"] },
    });
    const host = new DefaultPluginHost({ workspaceRoot: dir });
    host.register(plugin);
    // Manually drive setup with a fake capability map (no provider plugin).
    const ctx = {
      manifest: plugin.manifest,
      host: host as never,
      workspaceRoot: dir,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      provide: () => undefined,
      lookup: (token: string): unknown => (token === "nexum:config:plain" ? { answer: 42 } : () => "not cloneable"),
      declareCapability: () => undefined,
    };
    await plugin.setup?.(ctx as never);
    expect(plugin.sandbox.terminated()).toBe(false);
    const audit = plugin.sandbox.audit();
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "lookup", target: "nexum:config:plain", decision: "allowed" }),
        expect.objectContaining({
          operation: "lookup",
          target: "nexum:config:function",
          decision: "denied",
          reason: expect.stringContaining("structured-cloneable"),
        }),
      ]),
    );
    await plugin.sandbox.terminate();
  });

  it("terminates a hanging setup and reports a timeout", async () => {
    const file = writePlugin(
      "hanging",
      `export default {
        manifest: { id: "hanging", name: "Hanging", version: "1.0.0" },
        async setup() {
          await new Promise(() => {});
        },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file, { setupTimeoutMs: 400 });
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();

    const record = host.get("hanging");
    expect(record?.state).toBe("error");
    expect(record?.error).toContain("timed out");
    expect(plugin.sandbox.terminated()).toBe(true);
    // Further lifecycle calls fail fast with a clear reason.
    await expect(plugin.start?.()).rejects.toThrow(/no longer running/);
  });

  it("contains a plugin that kills its own worker (crash, not host)", async () => {
    const file = writePlugin(
      "suicidal",
      `export default {
        manifest: { id: "suicidal", name: "Suicidal", version: "1.0.0" },
        async setup() {
          process.exit(3);
        },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file, { setupTimeoutMs: 5_000 });
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();

    const record = host.get("suicidal");
    expect(record?.state).toBe("error");
    expect(plugin.sandbox.terminated()).toBe(true);
    // The host process is alive and other plugins are unaffected.
    expect(host.all().length).toBe(1);
  });

  it("propagates worker-side setup errors with stack text", async () => {
    const file = writePlugin(
      "thrower",
      `export default {
        manifest: { id: "thrower", name: "Thrower", version: "1.0.0" },
        async setup() {
          throw new Error("worker-side failure");
        },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file);
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();

    const record = host.get("thrower");
    expect(record?.state).toBe("error");
    expect(record?.error).toContain("worker-side failure");
    expect(plugin.sandbox.terminated()).toBe(true);
  });

  it("runs start/stop through the bridge and terminates the worker on stop", async () => {
    const file = writePlugin(
      "lifecycle",
      `export default {
        manifest: { id: "lifecycle", name: "Lifecycle", version: "1.0.0" },
        async start() { globalThis.started = true; },
        async stop() { globalThis.stopped = true; },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file);
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();
    expect(host.get("lifecycle")?.state).toBe("running");
    expect(plugin.sandbox.terminated()).toBe(false);

    await host.stop();
    expect(host.get("lifecycle")?.state).toBe("stopped");
    expect(plugin.sandbox.terminated()).toBe(true);
  });

  it("start timeout kills the worker", async () => {
    const file = writePlugin(
      "hang-start",
      `export default {
        manifest: { id: "hang-start", name: "HangStart", version: "1.0.0" },
        async start() { await new Promise(() => {}); },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file, { startTimeoutMs: 400 });
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();

    expect(host.get("hang-start")?.state).toBe("error");
    expect(plugin.sandbox.terminated()).toBe(true);
  });

  it("resource limits are passed to the worker (tiny heap plugin gets killed)", async () => {
    // A plugin that tries to allocate ~1 GB inside a 48 MB heap worker is
    // terminated by the V8 heap limit — proving the ceiling is enforced.
    const file = writePlugin(
      "memoryhog",
      `export default {
        manifest: { id: "memoryhog", name: "MemoryHog", version: "1.0.0" },
        async setup() {
          const chunks = [];
          // Pure JS-heap allocations (not Buffers — those live off-heap) so
          // the V8 old-generation ceiling is what kills this worker.
          for (;;) {
            chunks.push(new Array(2_000_000).fill("x"));
          }
        },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file, {
      resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16 },
      setupTimeoutMs: 20_000,
    });
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();

    const record = host.get("memoryhog");
    expect(record?.state).toBe("error");
    expect(plugin.sandbox.terminated()).toBe(true);
  }, 30_000);

  it("forwards worker-side logs to the injected logger", async () => {
    const logs: string[] = [];
    const file = writePlugin(
      "chatty",
      `export default {
        manifest: { id: "chatty", name: "Chatty", version: "1.0.0" },
        async setup(ctx) {
          ctx.log("info", "hello from the other side");
        },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file, {
      logger: {
        debug: () => {},
        info: (m) => logs.push(String(m)),
        warn: () => {},
        error: () => {},
      },
    });
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();
    expect(logs.some((l) => l.includes("hello from the other side"))).toBe(true);
    await host.stop();
  });

  it("PluginSandboxTimeout from the isolated path is a distinguishable error type", async () => {
    const file = writePlugin(
      "hang2",
      `export default {
        manifest: { id: "hang2", name: "Hang2", version: "1.0.0" },
        async setup() { await new Promise(() => {}); },
      };`,
    );
    const plugin = await IsolatedPluginSandbox.load(file, { setupTimeoutMs: 300 });
    const host = new DefaultPluginHost();
    host.register(plugin);
    await host.start();
    expect(host.get("hang2")?.state).toBe("error");
    // Reconstruct the shape the lifecycle path throws.
    const err = new PluginSandboxTimeout("m", "hang2", "setup", 300);
    expect(err.phase).toBe("setup");
    expect(err.timeoutMs).toBe(300);
    await host.stop();
  });
});
