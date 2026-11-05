/**
 * ContextCompiler — turns Nexum's persistent world state into the minimum
 * sufficient context for ONE model call, sized to the selected model.
 *
 *   world state (task node, memory, artifacts, tool results, tools)
 *        │
 *        ▼
 *   budgetForProfile(profile)  ──►  contextChars + toolBudget
 *        │
 *        ▼
 *   1. tool pack       rank → cap to toolBudget → schema chars charged
 *   2. pinned          task goal, current step, constraints, success criteria
 *   3. evidence        ContextPacker (diagnostics, code, diff, tool output, docs)
 *   4. state           failures → decisions → facts → artifacts → steps
 *        │
 *        ▼
 *   CompiledContext (promptBlock + tool names + manifest of what was dropped)
 *
 * Invariants:
 *   - Pinned sections are never dropped; an oversized item is truncated.
 *   - Output is deterministic for a given input + budget (stable ordering,
 *     no clock, no randomness) so a replayed step sees identical context.
 *   - Every exclusion is recorded with a reason; nothing disappears silently.
 *   - Large artifacts travel as URI + summary (+ bounded excerpt), never in full.
 */

import { ContextPacker } from "./packer.js";
import { goalOverlap } from "./relevance.js";
import type { ContextPackerOptions, PackedContext, TaskContextInput } from "./types.js";
import { budgetForProfile, type ModelBudget, type ModelBudgetOverrides } from "../models/profiles/context-budget.js";
import type { ModelProfile } from "../models/profiles/model-profile.js";

export interface CompileStep {
  id: string;
  objective: string;
  inputs?: string[];
}

export interface CompileFact {
  id: string;
  text: string;
  source?: string;
  /** Facts confirmed by a deterministic check outrank unverified recall. */
  verified?: boolean;
}

export interface CompileArtifact {
  /** e.g. artifact://test-results/456 — the model can request more by URI. */
  uri: string;
  summary: string;
  excerpt?: string;
}

/** Anything with a name + description (a Tool instance satisfies this). */
export interface CompileTool {
  name: string;
  description: string;
  /** Full schema sent to the provider; its JSON size is charged to the budget. */
  schema?: unknown;
  /** Caller-supplied relevance (e.g. DynamicToolSelector score); else goal overlap. */
  score?: number;
}

export interface CompileInput {
  goal: string;
  step?: CompileStep;
  constraints?: string[];
  successCriteria?: string[];
  completedSteps?: string[];
  pendingSteps?: string[];
  facts?: CompileFact[];
  decisions?: string[];
  failures?: string[];
  artifacts?: CompileArtifact[];
  /** Code / diagnostics / diff / tool output / docs, packed by ContextPacker. */
  evidence?: Omit<TaskContextInput, "goal">;
  tools?: CompileTool[];
  /** Tool names always exposed regardless of rank (still counted in toolBudget). */
  pinnedTools?: string[];
}

export interface CompilerOptions {
  /** Share of the post-pinned budget offered to evidence first (0..1). Unused space flows to state. */
  evidenceShare?: number;
  /** Charge tool schema JSON against contextChars (default true — providers bill it as prompt). */
  chargeToolSchemas?: boolean;
  /** Per-item cap for pinned and state items before truncation. */
  maxItemChars?: number;
  /** Cap on an artifact excerpt. */
  maxExcerptChars?: number;
  packer?: ContextPackerOptions;
}

export type CompiledSectionName =
  | "task"
  | "step"
  | "constraints"
  | "success_criteria"
  | "evidence"
  | "failures"
  | "decisions"
  | "facts"
  | "artifacts"
  | "progress";

export interface CompiledSection {
  name: CompiledSectionName;
  text: string;
  itemIds: string[];
}

export interface CompileExclusion {
  section: CompiledSectionName | "tools";
  id: string;
  reason: string;
}

export interface CompiledContext {
  budget: ModelBudget;
  promptBlock: string;
  sections: CompiledSection[];
  /** Tool names to expose, in rank order. */
  tools: string[];
  toolSchemaChars: number;
  /** promptBlock length + charged tool schema chars. */
  usedChars: number;
  truncated: boolean;
  excluded: CompileExclusion[];
  evidence?: PackedContext;
}

const DEFAULTS = {
  evidenceShare: 0.6,
  chargeToolSchemas: true,
  maxItemChars: 1_200,
  maxExcerptChars: 800,
} as const;

const TRUNCATION_MARK = "…[truncated]";

/** Minimum chars kept for pinned content even when tool schemas eat the budget. */
const MIN_PINNED_CHARS = 512;

interface Item {
  id: string;
  text: string;
  rank: number;
}

function clip(text: string, max: number): { text: string; clipped: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= max) return { text: trimmed, clipped: false };
  return { text: trimmed.slice(0, Math.max(0, max - TRUNCATION_MARK.length)) + TRUNCATION_MARK, clipped: true };
}

function nonEmpty(list: string[] | undefined): string[] {
  return (list ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

function wrap(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

function bullets(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

export class ContextCompiler {
  private readonly packer: ContextPacker;
  private readonly opts: Required<Omit<CompilerOptions, "packer">>;

  constructor(options: CompilerOptions = {}) {
    const share = options.evidenceShare ?? DEFAULTS.evidenceShare;
    if (!(share >= 0 && share <= 1)) throw new RangeError(`evidenceShare must be within 0..1 (got ${share})`);
    this.opts = {
      evidenceShare: share,
      chargeToolSchemas: options.chargeToolSchemas ?? DEFAULTS.chargeToolSchemas,
      maxItemChars: options.maxItemChars ?? DEFAULTS.maxItemChars,
      maxExcerptChars: options.maxExcerptChars ?? DEFAULTS.maxExcerptChars,
    };
    this.packer = new ContextPacker(options.packer);
  }

  /** Compile for a model profile; the budget is derived from it. */
  compileFor(profile: ModelProfile, input: CompileInput, overrides?: ModelBudgetOverrides): CompiledContext {
    return this.compile(input, budgetForProfile(profile, overrides));
  }

  compile(input: CompileInput, budget: ModelBudget): CompiledContext {
    const goal = input.goal.trim();
    if (!goal) throw new Error("ContextCompiler: goal is required");

    const excluded: CompileExclusion[] = [];
    let truncated = false;

    // ── 1. tool pack ────────────────────────────────────────────────────────
    const { tools, toolSchemaChars } = this.selectTools(input, goal, budget, excluded);
    let remaining = Math.max(MIN_PINNED_CHARS, budget.contextChars - toolSchemaChars);

    // ── 2. pinned — always present ──────────────────────────────────────────
    const sections: CompiledSection[] = [];
    const pinned = this.pinnedSections(input, goal);
    const pinnedChars = pinned.reduce((n, s) => n + s.text.length + 2, 0);
    if (pinnedChars > remaining) {
      // Over budget: shrink each pinned section proportionally, never drop.
      const ratio = remaining / pinnedChars;
      for (const s of pinned) {
        const { text, clipped } = clip(s.text, Math.max(64, Math.floor(s.text.length * ratio) - 2));
        if (clipped) truncated = true;
        sections.push({ ...s, text });
      }
    } else {
      sections.push(...pinned);
    }
    remaining -= sections.reduce((n, s) => n + s.text.length + 2, 0);

    // ── 3. evidence — packed with its share, surplus flows to state ─────────
    let evidence: PackedContext | undefined;
    if (input.evidence && remaining > 0) {
      const evidenceBudget = Math.floor(remaining * this.opts.evidenceShare);
      if (evidenceBudget > 0) {
        evidence = this.packer.pack({ goal, ...input.evidence }, { maxChars: evidenceBudget });
        // The packer always includes the goal fragment; it is already pinned, so strip it.
        const body = evidence.sections
          .filter((s) => s.kind !== "goal")
          .map((s) => s.text)
          .join("\n\n");
        for (const ex of evidence.excluded) excluded.push({ section: "evidence", id: ex.id, reason: ex.reason });
        if (evidence.truncated) truncated = true;
        if (body) {
          const ids = evidence.includedIds.filter((id) => id !== "goal");
          sections.push({ name: "evidence", text: wrap("evidence", body), itemIds: ids });
          remaining -= body.length + "<evidence>\n\n</evidence>".length + 2;
        }
      } else {
        excluded.push({ section: "evidence", id: "*", reason: "no budget left after pinned sections" });
      }
    }

    // ── 4. state — strict priority, items atomic ────────────────────────────
    for (const [name, tag, items] of this.stateGroups(input, goal)) {
      if (!items.length) continue;
      const kept: Item[] = [];
      const overhead = tag.length * 2 + 8;
      let used = overhead;
      for (const item of items) {
        const cost = item.text.length + 3; // "- " + newline
        if (used + cost > remaining) {
          excluded.push({ section: name, id: item.id, reason: "over context budget" });
          truncated = true;
          continue;
        }
        kept.push(item);
        used += cost;
      }
      if (!kept.length) continue;
      sections.push({ name, text: wrap(tag, bullets(kept.map((i) => i.text))), itemIds: kept.map((i) => i.id) });
      remaining -= used + 2;
    }

    const promptBlock = sections.map((s) => s.text).join("\n\n");
    return {
      budget,
      promptBlock,
      sections,
      tools,
      toolSchemaChars,
      usedChars: promptBlock.length + toolSchemaChars,
      truncated,
      excluded,
      ...(evidence ? { evidence } : {}),
    };
  }

  private selectTools(
    input: CompileInput,
    goal: string,
    budget: ModelBudget,
    excluded: CompileExclusion[],
  ): { tools: string[]; toolSchemaChars: number } {
    const all = input.tools ?? [];
    if (!all.length) return { tools: [], toolSchemaChars: 0 };

    const pinned = new Set(input.pinnedTools ?? []);
    const seen = new Set<string>();
    const ranked = all
      .filter((t) => {
        if (seen.has(t.name)) {
          excluded.push({ section: "tools", id: t.name, reason: "duplicate tool name" });
          return false;
        }
        seen.add(t.name);
        return true;
      })
      .map((t) => ({
        tool: t,
        pinned: pinned.has(t.name),
        score: t.score ?? goalOverlap(goal, t.name.replace(/_/g, " "), t.description),
      }))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return a.tool.name.localeCompare(b.tool.name);
      });

    const chosen: CompileTool[] = [];
    let schemaChars = 0;
    const schemaCap = Math.floor(budget.contextChars / 2); // tools may never take more than half the prompt
    for (const { tool, pinned: isPinned } of ranked) {
      if (chosen.length >= budget.toolBudget) {
        excluded.push({ section: "tools", id: tool.name, reason: `over tool budget (${budget.toolBudget})` });
        continue;
      }
      const cost = this.opts.chargeToolSchemas ? JSON.stringify(tool.schema ?? tool).length : 0;
      if (!isPinned && chosen.length > 0 && schemaChars + cost > schemaCap) {
        excluded.push({ section: "tools", id: tool.name, reason: "tool schemas over half the context budget" });
        continue;
      }
      chosen.push(tool);
      schemaChars += cost;
    }
    return { tools: chosen.map((t) => t.name), toolSchemaChars: schemaChars };
  }

  private pinnedSections(input: CompileInput, goal: string): CompiledSection[] {
    const max = this.opts.maxItemChars;
    const out: CompiledSection[] = [
      { name: "task", text: wrap("task_goal", clip(goal, max * 2).text), itemIds: ["goal"] },
    ];

    if (input.step) {
      const lines = [`id: ${input.step.id}`, `objective: ${clip(input.step.objective, max).text}`];
      const inputs = nonEmpty(input.step.inputs);
      if (inputs.length) lines.push("inputs:", bullets(inputs.map((i) => clip(i, max).text)));
      out.push({ name: "step", text: wrap("current_step", lines.join("\n")), itemIds: [input.step.id] });
    }

    const constraints = nonEmpty(input.constraints);
    if (constraints.length) {
      out.push({
        name: "constraints",
        text: wrap("constraints", bullets(constraints.map((c) => clip(c, max).text))),
        itemIds: constraints.map((_, i) => `constraint:${i}`),
      });
    }

    const criteria = nonEmpty(input.successCriteria);
    if (criteria.length) {
      out.push({
        name: "success_criteria",
        text: wrap("success_criteria", bullets(criteria.map((c) => clip(c, max).text))),
        itemIds: criteria.map((_, i) => `criterion:${i}`),
      });
    }
    return out;
  }

  /** State groups in strict priority order; items ranked within each group. */
  private stateGroups(input: CompileInput, goal: string): Array<[CompiledSectionName, string, Item[]]> {
    const max = this.opts.maxItemChars;
    const byRelevance = (items: Item[]) => [...items].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
    // Recent entries matter most for failures/decisions: later index → higher rank.
    const chronological = (list: string[], prefix: string): Item[] =>
      nonEmpty(list)
        .map((text, i) => ({ id: `${prefix}:${i}`, text: clip(text, max).text, rank: i }))
        .sort((a, b) => b.rank - a.rank);

    const facts = byRelevance(
      (input.facts ?? [])
        .filter((f) => f.text.trim())
        .map((f) => {
          const label = `${f.verified ? "[verified] " : ""}${f.text.trim()}${f.source ? ` (source: ${f.source})` : ""}`;
          return { id: f.id, text: clip(label, max).text, rank: (f.verified ? 1 : 0) + goalOverlap(goal, f.text) };
        }),
    );

    const artifacts = byRelevance(
      (input.artifacts ?? []).map((a) => {
        let text = `${a.uri} — ${a.summary.trim()}`;
        if (a.excerpt?.trim()) text += `\n  excerpt: ${clip(a.excerpt, this.opts.maxExcerptChars).text}`;
        return { id: a.uri, text: clip(text, max).text, rank: goalOverlap(goal, a.summary, a.excerpt ?? "") };
      }),
    );

    const progress: Item[] = [
      ...nonEmpty(input.pendingSteps).map((s, i) => ({
        id: `pending:${i}`,
        text: `[pending] ${clip(s, max).text}`,
        rank: 0,
      })),
      ...nonEmpty(input.completedSteps)
        .map((s, i) => ({ id: `done:${i}`, text: `[done] ${clip(s, max).text}`, rank: i }))
        .reverse(),
    ];

    return [
      ["failures", "previous_failures", chronological(input.failures ?? [], "failure")],
      ["decisions", "decisions", chronological(input.decisions ?? [], "decision")],
      ["facts", "relevant_facts", facts],
      ["artifacts", "artifacts", artifacts],
      ["progress", "task_progress", progress],
    ];
  }
}

export function compileContext(profile: ModelProfile, input: CompileInput, options?: CompilerOptions): CompiledContext {
  return new ContextCompiler(options).compileFor(profile, input);
}
