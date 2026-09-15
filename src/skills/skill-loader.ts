/**
 * SkillLoader — orchestrates multiple SkillProviders, dedupes skills, and
 * applies scope precedence (workspace > global, like the existing loader).
 *
 * The Loader is the single source of truth for "what skills exist right now".
 * It refreshes on demand (cheap: just calls each provider's list()) and
 * caches the result until `refresh()` is called.
 */

import type { SkillProvider } from "./formal-types.js";
import type { SkillMeta } from "./types.js";

export interface LoadResult {
  skills: SkillMeta[];
  /** Per-provider counts, for diagnostics. */
  byProvider: Record<string, number>;
  /** Duplicate ids that were merged (kept the first-seen). */
  duplicates: string[];
}

export class SkillLoader {
  private cache: LoadResult | null = null;
  private readonly providers: SkillProvider[] = [];

  constructor(providers: SkillProvider[] = []) {
    this.providers.push(...providers);
  }

  addProvider(provider: SkillProvider): this {
    this.providers.push(provider);
    this.invalidate();
    return this;
  }

  removeProvider(id: string): boolean {
    const idx = this.providers.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.providers.splice(idx, 1);
    this.invalidate();
    return true;
  }

  listProviders(): string[] {
    return this.providers.map((p) => p.id);
  }

  invalidate(): void {
    this.cache = null;
  }

  async load(): Promise<LoadResult> {
    if (this.cache) return this.cache;

    const skills: SkillMeta[] = [];
    const seen = new Set<string>();
    const duplicates: string[] = [];
    const byProvider: Record<string, number> = {};

    for (const provider of this.providers) {
      let metas: SkillMeta[];
      try {
        metas = await provider.list();
      } catch {
        // A failing provider shouldn't break the whole system.
        byProvider[provider.id] = 0;
        continue;
      }
      byProvider[provider.id] = 0;
      for (const meta of metas) {
        if (seen.has(meta.id)) {
          duplicates.push(meta.id);
          continue;
        }
        seen.add(meta.id);
        skills.push(meta);
        byProvider[provider.id]++;
      }
    }

    this.cache = { skills, byProvider, duplicates };
    return this.cache;
  }

  /** Find a skill's metadata by id across all providers. */
  async find(id: string): Promise<SkillMeta | undefined> {
    const { skills } = await this.load();
    return skills.find((s) => s.id === id);
  }

  /** Get the provider that owns a given skill (first one wins). */
  providerFor(id: string): SkillProvider | undefined {
    return this.providers.find((p) => p.id === id.split(":")[0]);
  }
}
