/**
 * Plugin system contracts — the formal "Everything is a Plugin" composition layer.
 *
 * Nexum's kernel (AgentRuntime, ModelGateway, ToolGateway, PolicyEngine,
 * ContextManager) is excellent, but it has no first-class way to mount, order,
 * and lifecycle-manage independent capability bundles. The Plugin layer fills
 * that gap without rewriting the kernel: a Plugin is simply a unit of
 * registration that, given a PluginContext, can wire tools, models, skills,
 * agents, hooks, services, or any other capability into the host.
 *
 * Design rules (matching existing Nexum patterns):
 *   - Interfaces only here; implementations live in `host.ts` / `registry.ts`.
 *   - No I/O in this file — pure contracts.
 *   - Plugins declare dependencies by id; the host topo-sorts before setup.
 *   - Lifecycle is explicit: setup → start → stop. setup may be async.
 *   - Plugin ids are kebab-case strings (matching ToolPack / AgentDescriptor ids).
 */

import type { EventSink } from "../../core/types.js";

/** A plugin identifier (kebab-case, unique within a PluginHost). */
export type PluginId = string;

/** A semver-style version string ("1.0.0", "0.2.1-alpha", …). */
export type PluginVersion = string;

/**
 * Static manifest declared by every plugin. Used for dependency resolution,
 * capability negotiation, and human-facing listings (CLI / TUI / docs).
 *
 * Mirrors the existing `AgentDescriptor` shape: declarative metadata that the
 * host reads *before* invoking any plugin code.
 */
export interface PluginManifest {
  id: PluginId;
  /** Human-facing name. */
  name: string;
  version: PluginVersion;
  description?: string;
  /** Plugin ids that must be mounted (and started) before this one. */
  dependencies?: PluginId[];
  /**
   * Capability tags this plugin provides (e.g. "tools", "skills", "models",
   * "subagents", "webhooks"). The host uses these for profile composition —
   * e.g. a "minimal" profile might mount only ["tools","sessions"] plugins.
   */
  provides?: string[];
  /** Capability tags this plugin expects the host to already provide. */
  requires?: string[];
  /** Optional home/license URL surfaced in `nexum plugins list`. */
  homepage?: string;
  /** Author / vendor string surfaced in listings. */
  author?: string;
  /** Whether the plugin can be disabled without breaking the host. */
  optional?: boolean;
}

/**
 * The host-facing surface a plugin receives during `setup`.
 *
 * Deliberately small and capability-oriented: a plugin never gets a reference
 * to the full AgentRuntime. Instead it gets typed registration methods, so the
 * host can audit, order, and revoke what each plugin contributes.
 *
 * This mirrors how `ToolCatalog.register` and `AgentRegistry.register` already
 * work — we are formalizing that pattern, not replacing it.
 */
export interface PluginContext {
  /** The manifest of the plugin currently being set up. */
  readonly manifest: PluginManifest;
  /** The host that owns this plugin (for cross-plugin lookups). */
  readonly host: PluginHost;
  /** Workspace root (for plugins that need filesystem access). */
  readonly workspaceRoot?: string;
  /** Logger scoped to this plugin id. */
  readonly log: PluginLogger;
  /**
   * Register a capability keyed by a string token. Other plugins can fetch
   * it via `context.lookup(token)`. This is the DI seam — see
   * `src/core/capabilities/` for the typed wrapper.
   */
  provide<T>(token: string, value: T): void;
  /** Fetch a capability provided by an already-setup plugin. */
  lookup<T>(token: string): T | undefined;
  /** Declare that this plugin contributes a named capability tag. */
  declareCapability(tag: string): void;
}

/** Minimal structured logger surface (compatible with console or pino). */
export interface PluginLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Lifecycle states a plugin moves through. */
export type PluginState =
  | "registered" // manifest known, setup not called yet
  | "setting-up" // setup() in flight
  | "ready" // setup() finished, not started
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

/** Snapshot of a plugin's runtime status (for `nexum plugins list`). */
export interface PluginRecord {
  manifest: PluginManifest;
  state: PluginState;
  /** Set when state === "error". */
  error?: string;
  /** ISO timestamp of last state transition. */
  updatedAt: string;
  /** Capabilities declared by this plugin. */
  capabilities: string[];
}

/**
 * The host-facing contract. `PluginHost` is what an embedding application
 * (CLI, TUI, RPC server) holds; it mounts plugins, resolves dependencies,
 * drives lifecycle, and exposes the resulting capability map.
 *
 * This is intentionally an interface so that tests can substitute fakes.
 */
export interface PluginHost {
  /** Register a plugin. Does NOT set it up — call `start()` to activate. */
  register(plugin: NexumPlugin): this;
  /** Register many plugins at once (convenience for profile bundles). */
  registerAll(plugins: NexumPlugin[]): this;
  /** True iff a plugin with this id is registered. */
  has(id: PluginId): boolean;
  /** Get the manifest + state for a plugin. */
  get(id: PluginId): PluginRecord | undefined;
  /** Throw if missing, like other Nexum registries. */
  require(id: PluginId): PluginRecord;
  /** All registered plugin records. */
  all(): PluginRecord[];
  /** Plugins currently in a given state. */
  byState(state: PluginState): PluginRecord[];
  /** Plugins that declare a given capability tag. */
  byCapability(tag: string): PluginRecord[];
  /** Resolve dependency order (topo-sorted) without activating anything. */
  resolveOrder(): PluginId[];
  /** Set up + start all registered plugins in dependency order. */
  start(): Promise<void>;
  /** Stop all plugins in reverse dependency order. */
  stop(): Promise<void>;
  /** Fetch a capability value by token (the DI lookup). */
  lookup<T>(token: string): T | undefined;
  /** True iff some plugin has provided this token. */
  provides(token: string): boolean;
  /** Subscribe to host lifecycle events. Returns an unsubscribe function. */
  on(event: PluginHostEvent, handler: PluginHostEventHandler): () => void;
}

/** Host lifecycle events emitted to subscribers. */
export type PluginHostEvent =
  | "plugin:register"
  | "plugin:setup:start"
  | "plugin:setup:done"
  | "plugin:setup:error"
  | "plugin:start:start"
  | "plugin:start:done"
  | "plugin:start:error"
  | "plugin:stop:start"
  | "plugin:stop:done"
  | "host:start"
  | "host:stop";

export interface PluginHostEventHandler {
  (record: PluginRecord, host: PluginHost): void;
}

/**
 * The plugin contract itself. A plugin is just a manifest plus three optional
 * lifecycle methods. This is deliberately compatible with the `ToolPack`
 * factory pattern — a `ToolPack` can be wrapped in a one-liner plugin.
 *
 * Lifecycle invariants:
 *   - `setup(ctx)` runs exactly once, after all dependencies have been set up.
 *   - `start()` runs after `setup()` completes; may be called again after stop.
 *   - `stop()` runs in reverse dependency order on host shutdown.
 *   - Any thrown error transitions the plugin to `error` state; the host
 *     collects the error and continues with remaining plugins (best-effort).
 */
export interface NexumPlugin {
  manifest: PluginManifest;
  setup?(ctx: PluginContext): Promise<void> | void;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

/**
 * Helper for declaring a plugin inline with full type inference.
 * Mirrors `defineToolPack` / `defineToolMetadata` shape.
 */
export function definePlugin(plugin: NexumPlugin): NexumPlugin {
  return plugin;
}

/**
 * Wrap a simple registration callback (e.g. "mount these tool packs") into a
 * plugin. Useful for migrating existing `ToolPack` mounting to the plugin host.
 */
export function pluginFromRegistration(
  manifest: PluginManifest,
  register: (ctx: PluginContext) => void | Promise<void>,
): NexumPlugin {
  return { manifest, setup: register };
}

/** Sentinel event sink token for plugins that want to subscribe to kernel events. */
export const PLUGIN_EVENT_SINK_TOKEN = "nexum:plugin:event-sink";

/** Type helper for fetching the event sink capability. */
export type PluginEventSinkCapability = EventSink;
