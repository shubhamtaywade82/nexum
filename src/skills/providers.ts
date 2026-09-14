/**
 * FilesystemSkillProvider — the default skill source.
 *
 * Wraps the existing `discoverSkills()` + `loadSkillContent()` from
 * skills/loader.ts so that the formal skill system can use the filesystem
 * as one provider among many.
 */

import { discoverSkills, loadSkillContent, type DiscoverOptions } from "./loader.js";
import type { SkillProvider } from "./formal-types.js";
import type { SkillContent, SkillMeta } from "./types.js";

export interface FilesystemSkillProviderOptions extends DiscoverOptions {
  /** Project language for filtering (passed through to resolver). */
  projectLanguage?: string;
}

export class FilesystemSkillProvider implements SkillProvider {
  readonly id = "filesystem";

  constructor(private readonly opts: FilesystemSkillProviderOptions) {}

  async list(): Promise<SkillMeta[]> {
    return discoverSkills(this.opts);
  }

  async load(meta: SkillMeta): Promise<SkillContent> {
    return loadSkillContent(meta);
  }
}

/**
 * InMemorySkillProvider — for tests and programmatically-registered skills.
 */
export class InMemorySkillProvider implements SkillProvider {
  readonly id = "in-memory";
  private readonly skills = new Map<string, SkillContent>();

  constructor(skills: SkillContent[] = []) {
    for (const s of skills) this.skills.set(s.id, s);
  }

  add(skill: SkillContent): this {
    this.skills.set(skill.id, skill);
    return this;
  }

  async list(): Promise<SkillMeta[]> {
    return [...this.skills.values()].map(({ body: _body, references: _refs, scripts: _s, templates: _t, ...meta }) => meta);
  }

  async load(meta: SkillMeta): Promise<SkillContent> {
    const s = this.skills.get(meta.id);
    if (!s) throw new Error(`in-memory skill "${meta.id}" not found`);
    return s;
  }
}
