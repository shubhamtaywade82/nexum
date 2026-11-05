import { buildFragments } from "./fragments.js";
import {
  SECTION_PRIORITY,
  type ContextFragment,
  type ContextPackerOptions,
  type ContextSectionKind,
  type ExcludedFragment,
  type PackedContext,
  type PackedSection,
  type TaskContextInput,
} from "./types.js";

const DEFAULTS = {
  maxChars: 14_000,
  maxFragmentChars: 4_000,
  minRelevance: 0.15,
  maxCodeItems: 8,
  maxDocItems: 4,
  maxToolOutputs: 6,
  maxRawDumpChars: 80_000,
} as const;

function normalizeKey(frag: ContextFragment): string {
  const body = frag.text.replace(/\s+/g, " ").trim().slice(0, 400);
  return `${frag.kind}|${frag.path ?? ""}|${body}`;
}

function dedupeFragments(fragments: ContextFragment[], excluded: ExcludedFragment[]): ContextFragment[] {
  const seen = new Set<string>();
  const out: ContextFragment[] = [];
  for (const frag of fragments) {
    const key = normalizeKey(frag);
    if (seen.has(key)) {
      excluded.push({ id: frag.id, kind: frag.kind, reason: "duplicate content" });
      continue;
    }
    seen.add(key);
    out.push(frag);
  }
  return out;
}

function closingTag(kind: ContextSectionKind): string {
  if (kind === "code") return "</code>";
  if (kind === "git_diff") return "</git_diff>";
  if (kind === "tool_output") return "</tool_output>";
  if (kind === "docs") return "</doc>";
  if (kind === "step_state") return "</previous_step>";
  return "";
}

function formatFragmentBlock(frag: ContextFragment): string {
  if (frag.kind === "goal") return `<task_goal>\n${frag.text}\n</task_goal>`;
  if (frag.kind === "diagnostics") return frag.text;
  const close = frag.text.startsWith("<") ? `\n${closingTag(frag.kind)}` : "";
  return `${frag.text}${close}`;
}

function groupSections(frags: ContextFragment[]): PackedSection[] {
  const order: ContextSectionKind[] = ["goal", "diagnostics", "code", "git_diff", "tool_output", "docs", "step_state"];
  const byKind = new Map<ContextSectionKind, ContextFragment[]>();
  for (const f of frags) {
    const list = byKind.get(f.kind) ?? [];
    list.push(f);
    byKind.set(f.kind, list);
  }
  const sections: PackedSection[] = [];
  for (const kind of order) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    list.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const text =
      kind === "diagnostics"
        ? `<diagnostics>\n${list.map((f) => f.text).join("\n")}\n</diagnostics>`
        : list.map((f) => formatFragmentBlock(f)).join("\n\n");
    sections.push({ kind, text, fragmentIds: list.map((f) => f.id) });
  }
  sections.sort((a, b) => SECTION_PRIORITY[b.kind] - SECTION_PRIORITY[a.kind]);
  return sections;
}

export class ContextPacker {
  constructor(private readonly defaults: ContextPackerOptions = {}) {}

  pack(input: TaskContextInput, opts: ContextPackerOptions = {}): PackedContext {
    const merged = { ...DEFAULTS, ...this.defaults, ...opts };
    const { fragments, excluded } = buildFragments(input, merged);
    const deduped = dedupeFragments(fragments, excluded);

    deduped.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return a.id.localeCompare(b.id);
    });

    const included: ContextFragment[] = [];
    let totalChars = 0;
    let truncated = false;

    for (const frag of deduped) {
      const block = formatFragmentBlock(frag);
      const cost = block.length + (included.length ? 2 : 0);
      if (included.length > 0 && totalChars + cost > merged.maxChars) {
        truncated = true;
        excluded.push({ id: frag.id, kind: frag.kind, reason: "truncated: over maxChars budget" });
        continue;
      }
      if (included.length === 0 && cost > merged.maxChars) {
        const sliced = block.slice(0, Math.max(0, merged.maxChars - 32)) + "\n…[truncated]";
        included.push({ ...frag, text: sliced });
        totalChars = sliced.length;
        truncated = true;
        continue;
      }
      included.push(frag);
      totalChars += cost;
    }

    const sections = groupSections(included);
    const promptBlock = sections.map((s) => s.text).join("\n\n");

    return {
      goal: input.goal.trim(),
      sections,
      promptBlock,
      totalChars: promptBlock.length,
      truncated,
      excluded,
      includedIds: included.map((f) => f.id),
    };
  }
}
