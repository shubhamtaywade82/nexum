/**
 * Profile system — composable product profiles.
 *
 * Nexum's existing `minimalProfile` / `standardProfile` / `fullProfile`
 * (in platform/plugins/profiles.ts) are simple plugin bundles. This module
 * formalizes the profile system with:
 *
 *   - ProfileRegistry      — registry of named profiles
 *   - ProfileBundle        — a profile = plugin list + settings + capabilities
 *   - ProfileLoader        — loads profiles from filesystem (`.nexum/profiles/`)
 *   - ProfileComposer      — composes multiple profiles (merge plugins/settings)
 *   - ProfileResolver      — resolves a profile to a concrete PluginHost config
 *
 * A profile is more than a plugin list: it carries settings overrides,
 * capability declarations, and metadata. This lets products ship with
 * curated profiles (e.g. "nexum-cli", "nexum-server", "nexum-crypto-bot")
 * that users can extend or compose.
 *
 * Example:
 *   const registry = new ProfileRegistry();
 *   registry.register(serverProfile);
 *   registry.register(cryptoBotProfile);
 *   const composed = ProfileComposer.compose([serverProfile, cryptoBotProfile]);
 *   // → composed has the union of plugins + merged settings (later wins)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { workspaceStateDir, globalStateDir } from "../platform/paths.js";
import type { NexumPlugin } from "../platform/plugins/types.js";
import type { SettingValue } from "../settings/index.js";

// ── Contracts ───────────────────────────────────────────────────────────────

export interface ProfileBundle {
  /** Unique profile id (kebab-case). */
  id: string;
  /** Display name. */
  name: string;
  /** Description. */
  description?: string;
  /** Version. */
  version: string;
  /** Plugins this profile mounts (factories, so they can be re-instantiated). */
  plugins: Array<() => NexumPlugin>;
  /** Settings overrides applied after plugins are mounted. */
  settings?: Record<string, SettingValue>;
  /** Capability tags this profile provides (e.g. ["crypto", "trading"]). */
  capabilities?: string[];
  /** Tags for filtering (e.g. ["server", "automation"]). */
  tags?: string[];
  /** Other profile ids this profile depends on (composed before this one). */
  dependsOn?: string[];
  /** Author. */
  author?: string;
  /** Home URL. */
  homepage?: string;
}

export interface ProfileRecord {
  bundle: ProfileBundle;
  /** Whether the profile is built-in or user-defined. */
  source: "builtin" | "user" | "remote";
  /** Path the profile was loaded from (for user/remote). */
  loadedFrom?: string;
}

export interface ComposedProfile {
  /** Merged plugin factories (in dependency order). */
  plugins: Array<() => NexumPlugin>;
  /** Merged settings (later profiles override earlier). */
  settings: Record<string, SettingValue>;
  /** Union of capabilities. */
  capabilities: string[];
  /** Union of tags. */
  tags: string[];
  /** Source profile ids (in order). */
  sources: string[];
}

// ── ProfileRegistry ─────────────────────────────────────────────────────────

export class ProfileRegistry {
  private readonly profiles = new Map<string, ProfileRecord>();

  register(bundle: ProfileBundle, source: "builtin" | "user" | "remote" = "builtin", loadedFrom?: string): this {
    if (this.profiles.has(bundle.id)) {
      throw new Error(`profile "${bundle.id}" already registered`);
    }
    this.profiles.set(bundle.id, { bundle, source, loadedFrom });
    return this;
  }

  unregister(id: string): boolean {
    return this.profiles.delete(id);
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  get(id: string): ProfileRecord | undefined {
    return this.profiles.get(id);
  }

  require(id: string): ProfileRecord {
    const rec = this.profiles.get(id);
    if (!rec) {
      throw new Error(`unknown profile "${id}". Registered: ${this.ids().sort().join(", ") || "(none)"}`);
    }
    return rec;
  }

  ids(): string[] {
    return [...this.profiles.keys()];
  }

  all(): ProfileRecord[] {
    return [...this.profiles.values()];
  }

  byTag(tag: string): ProfileRecord[] {
    return this.all().filter((r) => r.bundle.tags?.includes(tag));
  }

  byCapability(cap: string): ProfileRecord[] {
    return this.all().filter((r) => r.bundle.capabilities?.includes(cap));
  }
}

// ── ProfileLoader ───────────────────────────────────────────────────────────

export interface ProfileLoaderOptions {
  /** Workspace root for `.nexum/profiles/`. */
  workspaceRoot?: string;
  /** Home dir for `~/.nexum/profiles/` (global user profiles). */
  homeDir?: string;
}

export class ProfileLoader {
  constructor(private readonly opts: ProfileLoaderOptions = {}) {}

  /** Discover and load all user profiles from filesystem. */
  load(): ProfileRecord[] {
    const records: ProfileRecord[] = [];
    const dirs: Array<{ dir: string; source: "user" }> = [];
    if (this.opts.workspaceRoot) {
      dirs.push({ dir: join(workspaceStateDir(this.opts.workspaceRoot), "profiles"), source: "user" });
    }
    if (this.opts.homeDir) {
      const home = this.opts.homeDir || homedir();
      dirs.push({ dir: join(globalStateDir(home), "profiles"), source: "user" });
    }
    for (const { dir, source } of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const path = join(dir, entry.name);
          try {
            const data = JSON.parse(readFileSync(path, "utf8"));
            if (isValidProfileBundle(data)) {
              records.push({ bundle: data as ProfileBundle, source, loadedFrom: path });
            }
          } catch {
            // corrupt file — skip
          }
        }
      } catch {
        // unreadable dir — skip
      }
    }
    return records;
  }
}

// ── ProfileComposer ─────────────────────────────────────────────────────────

export class ProfileComposer {
  /**
   * Compose multiple profiles into one. Plugins are concatenated in order;
   * settings are merged (later wins); capabilities/tags are unioned.
   * Dependency order is respected (dependsOn).
   */
  static compose(registry: ProfileRegistry, ids: string[]): ComposedProfile {
    const sorted = ProfileComposer.sortByDependencies(registry, ids);
    const plugins: Array<() => NexumPlugin> = [];
    const settings: Record<string, SettingValue> = {};
    const capabilities = new Set<string>();
    const tags = new Set<string>();

    for (const id of sorted) {
      const rec = registry.require(id);
      for (const factory of rec.bundle.plugins) {
        plugins.push(factory);
      }
      if (rec.bundle.settings) {
        Object.assign(settings, rec.bundle.settings);
      }
      for (const cap of rec.bundle.capabilities ?? []) capabilities.add(cap);
      for (const tag of rec.bundle.tags ?? []) tags.add(tag);
    }

    return {
      plugins,
      settings,
      capabilities: [...capabilities],
      tags: [...tags],
      sources: sorted,
    };
  }

  /** Topo-sort profile ids by their dependsOn declarations. */
  static sortByDependencies(registry: ProfileRegistry, ids: string[]): string[] {
    const visited = new Set<string>();
    const result: string[] = [];
    const visiting = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) return; // cycle — skip
      visiting.add(id);
      const rec = registry.get(id);
      if (rec?.bundle.dependsOn) {
        for (const dep of rec.bundle.dependsOn) {
          if (ids.includes(dep)) visit(dep);
        }
      }
      visiting.delete(id);
      visited.add(id);
      result.push(id);
    };

    for (const id of ids) visit(id);
    return result;
  }
}

// ── ProfileResolver ─────────────────────────────────────────────────────────

export class ProfileResolver {
  /**
   * Resolve a profile to a concrete PluginHost configuration: instantiate
   * all plugins and return them along with the settings overrides.
   */
  static resolve(composed: ComposedProfile): { plugins: NexumPlugin[]; settings: Record<string, SettingValue> } {
    const plugins = composed.plugins.map((factory) => factory());
    return { plugins, settings: composed.settings };
  }
}

// ── Built-in profiles ────────────────────────────────────────────────────────

/** Built-in CLI profile: standard agent with tools, skills, jobs, compaction. */
export function cliProfileBundle(): ProfileBundle {
  return {
    id: "nexum-cli",
    name: "Nexum CLI",
    description: "Standard CLI/TUI agent profile.",
    version: "1.0.0",
    plugins: [], // populated by the embedding app (it has access to plugin factories)
    capabilities: ["cli", "agent"],
    tags: ["interactive"],
  };
}

/** Built-in server profile: RPC server + jobs + workflows. */
export function serverProfileBundle(): ProfileBundle {
  return {
    id: "nexum-server",
    name: "Nexum Server",
    description: "Server-grade profile for RPC/automation hosts.",
    version: "1.0.0",
    plugins: [],
    capabilities: ["rpc", "automation"],
    tags: ["server"],
  };
}

/** Built-in crypto-bot profile: trading + webhooks + workflows. */
export function cryptoBotProfileBundle(): ProfileBundle {
  return {
    id: "nexum-crypto-bot",
    name: "Nexum Crypto Bot",
    description: "Autonomous crypto trading agent profile.",
    version: "1.0.0",
    plugins: [],
    capabilities: ["crypto", "trading", "automation"],
    tags: ["trading", "webhooks"],
    dependsOn: ["nexum-server"],
  };
}

/** Register all built-in profiles. */
export function registerBuiltinProfiles(registry: ProfileRegistry): void {
  registry.register(cliProfileBundle(), "builtin");
  registry.register(serverProfileBundle(), "builtin");
  registry.register(cryptoBotProfileBundle(), "builtin");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidProfileBundle(value: unknown): value is ProfileBundle {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" && typeof v.name === "string" && typeof v.version === "string" && Array.isArray(v.plugins)
  );
}

void readdirSync; // keep import for future use
