/**
 * Capability-based Dependency Injection.
 *
 * Nexum does NOT use a runtime DI container with decorators or reflect-metadata.
 * The existing pattern (AgentRegistry, ToolCatalog, GateRegistry, etc.) is
 * "constructor options + factory functions + typed registries". This module
 * formalizes that pattern into a generic CapabilityRegistry<T> so that new
 * services can expose typed capability lookups without each reinventing the
 * same Map<string, T>.
 *
 * The DI seam between plugins is the `provide<T>(token, value)` /
 * `lookup<T>(token)` pair on PluginContext. This module provides:
 *   - `CapabilityToken<T>`: a branded string token with compile-time type info
 *   - `CapabilityRegistry<T>`: a typed registry keyed by token
 *   - `defineCapabilityToken<T>(id)`: factory for typed tokens
 *
 * Pattern (recommended):
 *
 *   // in src/jobs/types.ts
 *   export const JOB_SERVICE = defineCapabilityToken<JobService>("nexum:jobs:service");
 *
 *   // in a plugin's setup()
 *   ctx.provide(JOB_SERVICE.id, new JobService(...));
 *
 *   // in another plugin's setup() that depends on jobs
 *   const jobs = ctx.lookup<JobService>(JOB_SERVICE.id);
 *   if (!jobs) throw new Error("job service not provided (did you mount the jobs plugin?)");
 *
 * This gives us compile-time safety (the token carries the type T) AND a
 * runtime discovery mechanism that works across plugin boundaries.
 */

/** Branded token carrying a type and a string id. */
export interface CapabilityToken<T> {
  readonly id: string;
  /** Phantom type slot — never read at runtime. */
  readonly __type?: T;
}

/** Factory for typed capability tokens. */
export function defineCapabilityToken<T>(id: string): CapabilityToken<T> {
  return { id } as CapabilityToken<T>;
}

/**
 * Typed registry of capabilities. Multiple plugins can register different
 * capabilities into the same registry, or each service can own its own
 * registry. The shape mirrors AgentRegistry / ToolCatalog.
 */
export class CapabilityRegistry<T> {
  private readonly items = new Map<string, T>();

  constructor(private readonly description: string = "capability") {}

  register(token: CapabilityToken<T>, value: T): this {
    if (this.items.has(token.id)) {
      throw new Error(`${this.description} "${token.id}" is already registered`);
    }
    this.items.set(token.id, value);
    return this;
  }

  unregister(token: CapabilityToken<T>): boolean {
    return this.items.delete(token.id);
  }

  has(token: CapabilityToken<T>): boolean {
    return this.items.has(token.id);
  }

  get(token: CapabilityToken<T>): T | undefined {
    return this.items.get(token.id);
  }

  require(token: CapabilityToken<T>): T {
    const v = this.items.get(token.id);
    if (v === undefined) {
      throw new Error(
        `required ${this.description} "${token.id}" is not registered. ` +
          `Available: ${[...this.items.keys()].sort().join(", ") || "(none)"}`,
      );
    }
    return v;
  }

  ids(): string[] {
    return [...this.items.keys()];
  }

  all(): { token: string; value: T }[] {
    return [...this.items.entries()].map(([token, value]) => ({ token, value }));
  }
}

/**
 * Sentinel root token — the plugin host itself. Plugins that need to talk
 * back to the host (rare) can lookup this token.
 */
export const PLUGIN_HOST = defineCapabilityToken<unknown>("nexum:plugin:host");
