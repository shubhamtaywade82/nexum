/**
 * SkillCatalog — the materialized, queryable set of skills.
 *
 * Wraps a SkillLoader and exposes query methods:
 *   - list(): all skills
 *   - get(id): by id
 *   - byTag(tag): filter by tag
 *   - byLanguage(lang): filter by language
 *   - byScope(scope): filter by scope (workspace / global)
 *
 * The catalog is what the SkillSelector reads to decide which skills are
 * visible to the model at any given step. It is intentionally read-only;
 * mutation goes through the underlying SkillLoader / providers.
 */

import type { SkillMeta, SkillScope } from "./types.js";
import type { SkillLoader } from "./skill-loader.js";

export class SkillCatalog {
  constructor(private readonly loader: SkillLoader) {}

  async list(): Promise<SkillMeta[]> {
    const { skills } = await this.loader.load();
    return skills;
  }

  async get(id: string): Promise<SkillMeta | undefined> {
    return this.loader.find(id);
  }

  async byTag(tag: string): Promise<SkillMeta[]> {
    const skills = await this.list();
    return skills.filter((s) => s.tags.includes(tag));
  }

  async byLanguage(language: string): Promise<SkillMeta[]> {
    const skills = await this.list();
    return skills.filter((s) => s.language === language);
  }

  async byScope(scope: SkillScope): Promise<SkillMeta[]> {
    const skills = await this.list();
    return skills.filter((s) => s.scope === scope);
  }

  /** Count of skills (for diagnostics / `nexum skills list`). */
  async count(): Promise<number> {
    return (await this.list()).length;
  }
}
