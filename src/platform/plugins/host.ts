/**
 * PluginHost — the runtime that mounts, orders, and lifecycles plugins.
 *
 * The host is the *only* object that calls `plugin.setup(ctx)`,
 * `plugin.start()`, and `plugin.stop()`. Plugins never invoke each other
 * directly; they go through `ctx.lookup(token)` (the capability DI seam).
 *
 * Lifecycle:
 *
 *   register(a); register(b); register(c)
 *        │
 *        ▼
 *   resolveOrder()  ──►  [a, b, c]   (topo-sorted by manifest.dependencies)
 *        │
 *        ▼
 *   start()
 *     ├─ for each id in order:
 *     │    ├─ transition(id, "setting-up")
 *     │    ├─ plugin.setup(ctx)       ← ctx.provide()/declareCapability()
 *     │    ├─ transition(id, "ready")
 *     │    ├─ transition(id, "starting")
 *     │    ├─ plugin.start()
 *     │    └─ transition(id, "running")
 *     └─ emit("host:start")
 *
 *   stop() runs the same list in reverse, calling plugin.stop().
 *
 * Error handling: a failed setup/start transitions the plugin to "error"
 * but does NOT abort the host. Dependent plugins will still be attempted
 * (their `lookup()` calls will simply return undefined). This matches the
 * "best-effort, collect-and-continue" semantics of WorkspaceManager.migrate().
 */

import { PluginRegistry, validateManifest } from "./registry.js";
import { resolvePluginOrder } from "./dependency-resolver.js";
import type {
  NexumPlugin,
  PluginContext,
  PluginHost,
  PluginHostEvent,
  PluginHostEventHandler,
  PluginId,
  PluginLogger,
  PluginRecord,
} from "./types.js";

export interface PluginHostOptions {
  /** Workspace root, exposed to plugins via PluginContext. */
  workspaceRoot?: string;
  /** Logger; defaults to a thin console wrapper. */
  logger?: PluginLogger;
  /**
   * If true, the host throws on dependency cycles instead of mounting the
   * cyclic plugins. Defaults to false (best-effort).
   */
  failOnCycle?: boolean;
  /** If true, throws when a declared dependency is not registered. */
  failOnMissingDependency?: boolean;
}

export class DefaultPluginHost implements PluginHost {
  private readonly registry = new PluginRegistry();
  private readonly capabilities = new Map<string, unknown>();
  private readonly capabilityOwner = new Map<string, PluginId>();
  private readonly handlers = new Map<PluginHostEvent, Set<PluginHostEventHandler>>();
  private readonly logger: PluginLogger;
  private readonly workspaceRoot?: string;
  private readonly failOnCycle: boolean;
  private readonly failOnMissingDependency: boolean;
  private started = false;

  constructor(opts: PluginHostOptions = {}) {
    this.logger = opts.logger ?? consoleLogger();
    this.workspaceRoot = opts.workspaceRoot;
    this.failOnCycle = opts.failOnCycle ?? false;
    this.failOnMissingDependency = opts.failOnMissingDependency ?? false;
  }

  register(plugin: NexumPlugin): this {
    const issues = validateManifest(plugin.manifest);
    if (issues.length > 0) {
      throw new Error(`invalid plugin manifest for "${plugin.manifest.id}":\n  - ${issues.join("\n  - ")}`);
    }
    this.registry.register(plugin);
    this.emit("plugin:register", this.registry.require(plugin.manifest.id));
    return this;
  }

  registerAll(plugins: NexumPlugin[]): this {
    for (const p of plugins) this.register(p);
    return this;
  }

  has(id: PluginId): boolean {
    return this.registry.has(id);
  }

  get(id: PluginId): PluginRecord | undefined {
    return this.registry.get(id);
  }

  require(id: PluginId): PluginRecord {
    return this.registry.require(id);
  }

  all(): PluginRecord[] {
    return this.registry.all();
  }

  byState(state: PluginRecord["state"]): PluginRecord[] {
    return this.registry.byState(state);
  }

  byCapability(tag: string): PluginRecord[] {
    return this.registry.byCapability(tag);
  }

  resolveOrder(): PluginId[] {
    const plugins = this.registry.plugins();
    const result = resolvePluginOrder(plugins);
    if (this.failOnCycle && result.cycles.length > 0) {
      const described = result.cycles.map((c) => c.join(" → ")).join("; ");
      throw new Error(`dependency cycle(s) detected: ${described}`);
    }
    if (this.failOnMissingDependency && result.missing.length > 0) {
      const described = result.missing.map((m) => `${m.id} → [${m.missing.join(", ")}]`).join("; ");
      throw new Error(`missing dependencies: ${described}`);
    }
    return result.order;
  }

  async start(): Promise<void> {
    if (this.started) {
      this.logger.warn("plugin host already started — ignoring duplicate start()");
      return;
    }
    const order = this.resolveOrder();
    this.logger.info("starting plugin host", { count: order.length });

    for (const id of order) {
      const plugin = this.registry.requirePlugin(id);

      // setup()
      if (plugin.setup) {
        this.registry.transition(id, "setting-up");
        this.emit("plugin:setup:start", this.registry.require(id));
        try {
          const ctx = this.makeContext(plugin.manifest);
          await plugin.setup(ctx);
          this.registry.transition(id, "ready");
          this.emit("plugin:setup:done", this.registry.require(id));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`setup failed for plugin "${id}"`, { error: msg });
          this.registry.transition(id, "error", msg);
          this.emit("plugin:setup:error", this.registry.require(id));
          continue; // skip start() for this plugin; dependents may still try
        }
      } else {
        this.registry.transition(id, "ready");
      }

      // start()
      if (plugin.start) {
        this.registry.transition(id, "starting");
        this.emit("plugin:start:start", this.registry.require(id));
        try {
          await plugin.start();
          this.registry.transition(id, "running");
          this.emit("plugin:start:done", this.registry.require(id));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`start failed for plugin "${id}"`, { error: msg });
          this.registry.transition(id, "error", msg);
          this.emit("plugin:start:error", this.registry.require(id));
        }
      } else {
        this.registry.transition(id, "running");
      }
    }

    this.started = true;
    this.emit("host:start", {
      manifest: {
        id: "@host",
        name: "PluginHost",
        version: "1.0.0",
      },
      state: "running",
      updatedAt: new Date().toISOString(),
      capabilities: [],
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    const order = this.resolveOrder();
    const reversed = [...order].reverse();
    this.logger.info("stopping plugin host", { count: reversed.length });

    for (const id of reversed) {
      const plugin = this.registry.requirePlugin(id);
      const record = this.registry.require(id);
      if (record.state !== "running" && record.state !== "error") continue;

      if (plugin.stop) {
        this.registry.transition(id, "stopping");
        this.emit("plugin:stop:start", this.registry.require(id));
        try {
          await plugin.stop();
          this.registry.transition(id, "stopped");
          this.emit("plugin:stop:done", this.registry.require(id));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`stop failed for plugin "${id}"`, { error: msg });
          this.registry.transition(id, "error", msg);
        }
      } else {
        this.registry.transition(id, "stopped");
      }
    }

    this.started = false;
    this.emit("host:stop", {
      manifest: {
        id: "@host",
        name: "PluginHost",
        version: "1.0.0",
      },
      state: "stopped",
      updatedAt: new Date().toISOString(),
      capabilities: [],
    });
  }

  lookup<T>(token: string): T | undefined {
    return this.capabilities.get(token) as T | undefined;
  }

  provides(token: string): boolean {
    return this.capabilities.has(token);
  }

  on(event: PluginHostEvent, handler: PluginHostEventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  // ── internals ───────────────────────────────────────────────────────────

  private makeContext(manifest: NexumPlugin["manifest"]): PluginContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- intentional: closed over by object-literal methods below
    const self = this;
    return {
      manifest,
      host: self,
      workspaceRoot: self.workspaceRoot,
      log: scopedLogger(self.logger, manifest.id),
      provide<T>(token: string, value: T): void {
        if (self.capabilities.has(token)) {
          const owner = self.capabilityOwner.get(token);
          if (owner && owner !== manifest.id) {
            throw new Error(
              `capability token "${token}" is already provided by plugin "${owner}" ` +
                `(plugin "${manifest.id}" attempted to override).`,
            );
          }
        }
        self.capabilities.set(token, value);
        self.capabilityOwner.set(token, manifest.id);
      },
      lookup<T>(token: string): T | undefined {
        return self.lookup<T>(token);
      },
      declareCapability(tag: string): void {
        self.registry.declareCapability(manifest.id, tag);
      },
    };
  }

  private emit(event: PluginHostEvent, record: PluginRecord): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        h(record, this);
      } catch (err) {
        this.logger.error(`event handler for "${event}" threw`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

// ── Loggers ────────────────────────────────────────────────────────────────

function consoleLogger(): PluginLogger {
  return {
    debug: (msg, meta) => console.debug(`[plugins] ${msg}`, meta ?? ""),
    info: (msg, meta) => console.info(`[plugins] ${msg}`, meta ?? ""),
    warn: (msg, meta) => console.warn(`[plugins] ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`[plugins] ${msg}`, meta ?? ""),
  };
}

function scopedLogger(parent: PluginLogger, pluginId: string): PluginLogger {
  return {
    debug: (msg, meta) => parent.debug(`[${pluginId}] ${msg}`, meta),
    info: (msg, meta) => parent.info(`[${pluginId}] ${msg}`, meta),
    warn: (msg, meta) => parent.warn(`[${pluginId}] ${msg}`, meta),
    error: (msg, meta) => parent.error(`[${pluginId}] ${msg}`, meta),
  };
}
