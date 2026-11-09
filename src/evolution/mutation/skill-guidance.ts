/**
 * Process guidance for the self-mutation agent, read from the repository's own
 * skill files. The loop used to carry a hardcoded paraphrase of four skills; this
 * reads the skills themselves, so an edit to a SKILL.md changes what the agent is told.
 *
 * Skills are instructions the model follows, so the caller decides whether the
 * repository's skills may load (the workspace trust gate). Skills marked
 * `disable-model-invocation` are user-invoked by their own contract, so they are not
 * injected here either.
 */

import { discoverSkills, loadSkillContent } from "../../skills/loader.js";

/** The skills that steer the mutation agent, by directory name. Order is the order they appear in the prompt. */
export const MUTATION_GUIDANCE_SKILLS = ["diagnosing-bugs", "codebase-design", "tdd", "code-review"] as const;

/** Total characters of skill text the mutation prompt may carry. */
export const MUTATION_GUIDANCE_BUDGET_CHARS = 12_000;

export interface MutationGuidance {
  /** The prompt section, or "" when nothing was loaded. */
  text: string;
  loaded: string[];
  /** Named skills that were not loaded, and why. */
  skipped: Array<{ id: string; reason: "missing" | "user-invoked" }>;
}

export function loadMutationSkillGuidance(
  workspaceRoot: string,
  opts: { workspaceTrusted: boolean; homeDir?: string; budgetChars?: number },
): MutationGuidance {
  const budget = opts.budgetChars ?? MUTATION_GUIDANCE_BUDGET_CHARS;
  const metas = discoverSkills({ workspaceRoot, homeDir: opts.homeDir, workspaceTrusted: opts.workspaceTrusted });
  const loaded: string[] = [];
  const skipped: MutationGuidance["skipped"] = [];
  const sections: string[] = [];

  const candidates = MUTATION_GUIDANCE_SKILLS.map((id) => ({ id, meta: metas.find((m) => m.id === id) }));
  const perSkill = Math.floor(budget / MUTATION_GUIDANCE_SKILLS.length);
  for (const { id, meta } of candidates) {
    if (!meta) {
      skipped.push({ id, reason: "missing" });
      continue;
    }
    if (meta.disableModelInvocation) {
      skipped.push({ id, reason: "user-invoked" });
      continue;
    }
    const content = loadSkillContent(meta);
    const body = content.body.length > perSkill ? `${content.body.slice(0, perSkill)}\n[truncated]` : content.body;
    sections.push(`### ${content.name}\n\n${body}`);
    loaded.push(id);
  }

  if (sections.length === 0) return { text: "", loaded, skipped };
  const text = [
    "Engineering process (the repository's own skill files; follow them when they apply):",
    "",
    sections.join("\n\n"),
  ].join("\n");
  return { text, loaded, skipped };
}
