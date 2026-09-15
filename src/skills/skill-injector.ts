/**
 * SkillInjector — injects selected skill content into the model context.
 *
 * Takes a SkillSelection, loads the full content for each selected skill
 * (via the provider that owns it), formats it as a markdown fragment, and
 * returns it for inclusion in the model's system or user prompt.
 *
 * Token budgeting: the injector respects a per-turn token cap (default 2000)
 * and drops skills that would exceed it, lowest-score first.
 */

import type { SkillProvider } from "./formal-types.js";
import type { SkillSelection, SkillInjection } from "./formal-types.js";
import type { SkillContent } from "./types.js";

const DEFAULT_MAX_TOKENS = 2000;
const CHARS_PER_TOKEN = 4; // rough estimate

export class SkillInjector {
  constructor(private readonly providers: SkillProvider[] = []) {}

  addProvider(provider: SkillProvider): this {
    this.providers.push(provider);
    return this;
  }

  async inject(selection: SkillSelection, maxTokens: number = DEFAULT_MAX_TOKENS): Promise<SkillInjection> {
    const injectedSkillIds: string[] = [];
    const parts: string[] = [];
    let remainingTokens = maxTokens;
    let estimatedTokens = 0;

    for (const scored of selection.selected) {
      const provider = this.findProvider(scored.meta.id);
      if (!provider) continue;

      let content: SkillContent;
      try {
        content = await provider.load(scored.meta);
      } catch {
        continue; // skip skills that fail to load
      }

      const skillTokens = estimateTokens(content.body);
      if (skillTokens > remainingTokens) continue;

      parts.push(formatSkill(content));
      injectedSkillIds.push(content.id);
      remainingTokens -= skillTokens;
      estimatedTokens += skillTokens;
    }

    const content = parts.length === 0 ? "" : `## Relevant Skills\n\n${parts.join("\n\n---\n\n")}\n`;

    return { content, injectedSkillIds, estimatedTokens };
  }

  private findProvider(skillId: string): SkillProvider | undefined {
    // Try provider prefix first (e.g. "filesystem:crypto-futures-ta")
    const prefix = skillId.split(":")[0];
    const byPrefix = this.providers.find((p) => p.id === prefix);
    if (byPrefix) return byPrefix;
    // Fall back to first provider (most setups have a single provider)
    return this.providers[0];
  }
}

function formatSkill(content: SkillContent): string {
  const header = `### ${content.name}\n\n${content.description}`;
  const tags = content.tags.length > 0 ? `\n\n**Tags:** ${content.tags.join(", ")}` : "";
  return `${header}${tags}\n\n${content.body}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
