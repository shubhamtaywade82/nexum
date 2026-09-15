/**
 * PluginRegistry — the in-memory store of plugin manifests + state.
 *
 * Follows the exact shape of Nexum's existing registries (AgentRegistry,
 * StrategyRegistry, ToolCatalog, GateRegistry):
 *   - register(item): this     (chainable)
 *   - get(id): T | undefined
 *   - require(id): T           (throws with helpful "registered: ..." message)
 *   - has(id): boolean
 *   - all(): T[]
 *   - ids(): string[]
 *
 * The registry holds (manifest, plugin, state, error) tuples. Lifecycle
 * transitions are the host's job; the registry just records what happened.
 */

import type { NexumPlugin, PluginId, PluginManifest, PluginRecord, PluginState } from "./types.js";

interface RegistryEntry {
  plugin: NexumPlugin;
  record: PluginRecord;
}

export class PluginRegistry {
  private readonly entries = new Map<PluginId, RegistryEntry>();

  register(plugin: NexumPlugin): this {
    const existing = this.entries.get(plugin.manifest.id);
    if (existing) {
      throw new Error(
        `plugin "${plugin.manifest.id}" is already registered (version ${existing.record.manifest.version}). ` +
          `Call unregister() first or use a unique id.`,
      );
    }
    this.entries.set(plugin.manifest.id, {
      plugin,
      record: {
        manifest: plugin.manifest,
        state: "registered",
        updatedAt: new Date().toISOString(),
        capabilities: [],
      },
    });
    return this;
  }

  registerAll(plugins: NexumPlugin[]): this {
    for (const p of plugins) this.register(p);
    return this;
  }

  unregister(id: PluginId): boolean {
    return this.entries.delete(id);
  }

  has(id: PluginId): boolean {
    return this.entries.has(id);
  }

  get(id: PluginId): PluginRecord | undefined {
    return this.entries.get(id)?.record;
  }

  require(id: PluginId): PluginRecord {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`unknown plugin "${id}". Registered plugins: ${this.ids().sort().join(", ") || "(none)"}`);
    }
    return entry.record;
  }

  /** Get the underlying plugin object (host-only — not exposed via PluginHost). */
  pluginFor(id: PluginId): NexumPlugin | undefined {
    return this.entries.get(id)?.plugin;
  }

  requirePlugin(id: PluginId): NexumPlugin {
    const p = this.pluginFor(id);
    if (!p) {
      throw new Error(`unknown plugin "${id}". Registered plugins: ${this.ids().sort().join(", ") || "(none)"}`);
    }
    return p;
  }

  ids(): PluginId[] {
    return [...this.entries.keys()];
  }

  all(): PluginRecord[] {
    return [...this.entries.values()].map((e) => e.record);
  }

  plugins(): NexumPlugin[] {
    return [...this.entries.values()].map((e) => e.plugin);
  }

  byState(state: PluginState): PluginRecord[] {
    return this.all().filter((r) => r.state === state);
  }

  byCapability(tag: string): PluginRecord[] {
    return this.all().filter((r) => r.capabilities.includes(tag) || (r.manifest.provides ?? []).includes(tag));
  }

  /** Transition a plugin's state (host-only). */
  transition(id: PluginId, state: PluginState, error?: string): PluginRecord {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`cannot transition unknown plugin "${id}"`);
    }
    entry.record = {
      ...entry.record,
      state,
      error,
      updatedAt: new Date().toISOString(),
    };
    return entry.record;
  }

  /** Add a capability tag to a plugin's record (host-only). */
  declareCapability(id: PluginId, tag: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!entry.record.capabilities.includes(tag)) {
      entry.record.capabilities.push(tag);
    }
  }
}

/** Validate a manifest's basic shape. Returns a list of human-readable issues. */
export function validateManifest(manifest: PluginManifest): string[] {
  const issues: string[] = [];
  if (!manifest.id || !/^[a-z0-9-]+$/.test(manifest.id)) {
    issues.push(`id must be kebab-case (got "${manifest.id}")`);
  }
  if (!manifest.name || manifest.name.trim().length === 0) {
    issues.push("name is required");
  }
  if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    issues.push(`version must look like semver (got "${manifest.version}")`);
  }
  if (manifest.dependencies) {
    for (const d of manifest.dependencies) {
      if (d === manifest.id) issues.push(`plugin "${manifest.id}" depends on itself`);
    }
  }
  return issues;
}
