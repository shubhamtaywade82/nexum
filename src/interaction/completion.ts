/**
 * Completion engine: ghost text and autocomplete candidates.
 *
 * Ghost text is the gray continuation shown after the caret — Tab accepts
 * all of it, Right Arrow accepts one word, Esc dismisses.
 */

import { SlashCommandRegistry } from "./slash-commands.js";
import { BUILTIN_TEMPLATES, PromptTemplate, templateCompletions } from "./templates.js";

/**
 * Ghost suffix for the current input, from the newest history entry that
 * starts with it. Returns "" when there is nothing to suggest.
 */
export function ghostSuffix(input: string, history: string[]): string {
  if (!input) return "";
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.length > input.length && entry.startsWith(input)) {
      return entry.slice(input.length);
    }
  }
  return "";
}

/** Accept a single word (plus leading space) from a ghost suffix. */
export function acceptWord(suffix: string): { accepted: string; rest: string } {
  const match = suffix.match(/^\s*\S+/);
  if (!match) return { accepted: suffix, rest: "" };
  return { accepted: match[0], rest: suffix.slice(match[0].length) };
}

export interface CompletionItem {
  label: string;
  detail: string;
  insert: string;
  /** Completion kind for icon/grouping in future versions. */
  kind?: "command" | "argument" | "template" | "history" | "prompt";
  /** Optional category/group label shown in the right column. */
  group?: string;
}

/**
 * True when accepting `item` would leave the prompt effectively unchanged —
 * i.e. the user has already typed the whole command and the only "completion"
 * on offer is that same command (registry.complete matches exact names, so
 * "/resume" always completes to "/resume "). Trailing whitespace doesn't
 * count as a change: parseSlashInput trims, so "/resume" and "/resume " run
 * the identical command.
 *
 * Callers use this to keep Enter meaning "submit" once there is nothing left
 * to complete, instead of silently re-inserting what is already there.
 */
export function isNoOpCompletion(input: string, item: CompletionItem): boolean {
  return item.insert.trim() === input.trim();
}

/**
 * Autocomplete candidates for the prompt: slash commands when the input
 * starts with "/", prompt templates when it starts with "@", or historical
 * prompts and template matches for natural language queries (2+ chars).
 */
export function completions(
  input: string,
  registry: SlashCommandRegistry,
  templates: PromptTemplate[] = BUILTIN_TEMPLATES,
  history: string[] = [],
): CompletionItem[] {
  if (input.startsWith("@")) return templateCompletions(input, templates);
  if (!input.startsWith("/")) {
    const trimmed = input.trim().toLowerCase();
    if (trimmed.length < 2) return [];

    const items: CompletionItem[] = [];
    const seen = new Set<string>();

    // 1. Check history matches (match all typed words)
    const words = trimmed.split(/\s+/).filter(Boolean);
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i]!;
      if (!h || h.startsWith("/")) continue;
      const hLow = h.toLowerCase();
      if (hLow !== trimmed && words.every((w) => hLow.includes(w)) && !seen.has(hLow)) {
        seen.add(hLow);
        items.push({
          label: h.length > 28 ? h.slice(0, 25) + "..." : h,
          detail: h,
          insert: h,
          kind: "history",
          group: "History",
        });
        if (items.length >= 4) break;
      }
    }

    // 2. Check template matches if room
    if (items.length < 5) {
      for (const t of templates) {
        const tLow = t.name.toLowerCase();
        const dLow = t.description.toLowerCase();
        if (words.some((w) => tLow.includes(w) || dLow.includes(w)) && !seen.has(tLow)) {
          seen.add(tLow);
          items.push({
            label: `@${t.name}`,
            detail: t.description,
            insert: t.insert,
            kind: "template",
            group: "Template",
          });
          if (items.length >= 6) break;
        }
      }
    }

    return items;
  }

  const spaceIdx = input.indexOf(" ");
  if (spaceIdx === -1) {
    const prefix = input.slice(1);
    return registry.complete(prefix).map((c) => ({
      label: `/${c.name}`,
      detail: c.description,
      insert: `/${c.name} `,
      kind: "command" as const,
      group: c.category,
    }));
  }

  // Subcommand/argument completion, e.g. "/mode a" -> "ask". Only the first
  // argument token is completed — commands take one value, not a tree.
  const argText = input.slice(spaceIdx + 1);
  if (argText.includes(" ")) return [];
  const name = input.slice(1, spaceIdx);
  const command = registry.find(name);
  if (!command?.argValues) return [];
  const argPrefix = argText.toLowerCase();
  return command.argValues
    .filter((v) => v.startsWith(argPrefix))
    .map((v) => ({ label: v, detail: command.description, insert: `/${name} ${v}`, kind: "argument" as const }));
}
