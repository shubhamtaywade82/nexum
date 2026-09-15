/**
 * SkillSelector — picks which skills are visible for a given agent step.
 *
 * This is the key new piece over the existing SkillsRegistry.resolveForPrompt:
 * the selector is called per-step (not per-session) so the visible skill set
 * can change as the agent's task evolves. DeepSeek dynamically rebuilds the
 * catalog around agent steps; this is the Nexum equivalent.
 *
 * Selection algorithm (deterministic, no embeddings):
 *   1. Tokenize the prompt.
 *   2. Score each skill by tag overlap + description token overlap.
 *   3. Penalize language mismatch.
 *   4. Exclude already-injected skills.
 *   5. Take top N (default 3) above a minimum score threshold.
 *
 * The algorithm mirrors the existing resolver.ts but is wrapped in a class
 * so it can be substituted (e.g. an embedding-based selector in the future).
 */

import type { SkillCatalog } from "./skill-catalog.js";
import type { SkillScored, SkillSelection, SkillSelectionInput } from "./formal-types.js";
import type { SkillMeta } from "./types.js";

const TAG_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;
const LANGUAGE_MISMATCH_PENALTY = -10;
const MIN_SCORE_THRESHOLD = 1;
const DEFAULT_MAX_SKILLS = 3;
const STOPWORDS = new Set([
  "the","a","an","to","of","in","on","for","and","or","but","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","could","should","may","might","can","this","that",
  "these","those","i","you","he","she","it","we","they","what","which","who","when","where","why","how",
  "with","without","from","into","out","up","down","over","under","again","then","once","here","there",
  "all","any","both","each","few","more","most","other","some","such","no","nor","not","only","own","same",
  "so","than","too","very","just","now","my","your","our","their","its",
]);

export class SkillSelector {
  constructor(private readonly catalog: SkillCatalog) {}

  async select(input: SkillSelectionInput): Promise<SkillSelection> {
    const maxSkills = input.maxSkills ?? DEFAULT_MAX_SKILLS;
    const promptTokens = tokenize(input.prompt);
    const alreadyInjected = new Set(input.alreadyInjected ?? []);
    const skills = await this.catalog.list();

    const scored: SkillScored[] = [];
    for (const meta of skills) {
      if (alreadyInjected.has(meta.id)) continue;

      const matchedTags = meta.tags.filter((t) => promptTokens.has(t.toLowerCase()));
      const descTokens = tokenize(meta.description);
      const matchedDescriptionTokens = [...descTokens].filter((t) => promptTokens.has(t));

      let score = matchedTags.length * TAG_WEIGHT + matchedDescriptionTokens.length * DESCRIPTION_WEIGHT;

      // Language mismatch penalty
      if (meta.language && input.projectLanguage && meta.language !== input.projectLanguage) {
        score += LANGUAGE_MISMATCH_PENALTY;
      }

      // Agent capability filtering: if the agent declares capabilities,
      // boost skills whose tags include any of them.
      if (input.agentCapabilities) {
        const capMatch = meta.tags.some((t) => input.agentCapabilities!.includes(t));
        if (capMatch) score += 2;
      }

      if (score >= MIN_SCORE_THRESHOLD) {
        scored.push({ meta, score, matchedTags, matchedDescriptionTokens });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.meta.id.localeCompare(b.meta.id));
    const selected = scored.slice(0, maxSkills);

    const rationale =
      selected.length === 0
        ? "no skills matched the prompt above threshold"
        : selected
            .map((s) => `${s.meta.id} (score=${s.score}, tags=[${s.matchedTags.join(",")}])`)
            .join("; ");

    return { selected, rationale };
  }
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Re-export for tests that want to verify tokenization. */
export { tokenize as tokenizeForSkillSelection };
