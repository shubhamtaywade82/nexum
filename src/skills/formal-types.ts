/**
 * Formal Skill system types — the "DeepSeek Harness-style" skill capability.
 *
 * Nexum already has a SkillsRegistry (skills/registry.ts) that discovers
 * SKILL.md files from the filesystem and resolves them by keyword overlap.
 * This module formalizes the architecture into:
 *
 *   SkillProvider    ← pluggable source of skills (filesystem, in-memory, remote)
 *   SkillLoader      ← orchestrates providers, dedupes, applies scope precedence
 *   SkillCatalog     ← the materialized, queryable set of skills
 *   SkillSelector    ← picks which skills are visible for a given agent step
 *   SkillInjector    ← injects selected skill content into the model context
 *
 * The existing SkillsRegistry becomes one (default) SkillProvider. Other
 * providers can supply skills from MCP, HTTP, or in-memory for tests.
 *
 * The Selector is the key new piece: it controls exactly which skills are
 * visible to the model at any given step (DeepSeek dynamically rebuilds the
 * catalog around agent steps). This lets an agent load a skill on-demand
 * rather than carrying every skill description in its system prompt.
 */

import type { SkillContent, SkillMeta } from "./types.js";

/** A pluggable source of skill metadata. */
export interface SkillProvider {
  /** Unique provider id (e.g. "filesystem", "mcp", "in-memory"). */
  readonly id: string;
  /** List all skills this provider knows about (lazy: returns metadata only). */
  list(): SkillMeta[] | Promise<SkillMeta[]>;
  /** Load full content for a skill this provider reported via list(). */
  load(meta: SkillMeta): SkillContent | Promise<SkillContent>;
}

/** Selector input — everything the selector needs to pick relevant skills. */
export interface SkillSelectionInput {
  /** The user's current prompt or task description. */
  prompt: string;
  /** The agent's declared capabilities (filters skills by language/domain). */
  agentCapabilities?: string[];
  /** The project's primary language (e.g. "typescript", "ruby"). */
  projectLanguage?: string;
  /** Skills already injected in this session (avoid re-injecting). */
  alreadyInjected?: string[];
  /** Maximum number of skills to select (progressive disclosure). */
  maxSkills?: number;
}

/** Selector output — the ranked list of skills to inject. */
export interface SkillSelection {
  /** Ranked skills to inject (best first). */
  selected: SkillScored[];
  /** Why each skill was selected (for debugging / observability). */
  rationale: string;
}

export interface SkillScored {
  meta: SkillMeta;
  score: number;
  matchedTags: string[];
  matchedDescriptionTokens: string[];
}

/** Injector output — the context fragment to add to the model's input. */
export interface SkillInjection {
  /** Markdown-formatted skill content to inject. */
  content: string;
  /** Ids of skills that were injected. */
  injectedSkillIds: string[];
  /** Token estimate of the injected content. */
  estimatedTokens: number;
}

/** Configuration for the skill system. */
export interface SkillSystemOptions {
  /** Maximum skills to inject per turn (default 3). */
  maxSkillsPerTurn?: number;
  /** Maximum tokens of skill content to inject (default 2000). */
  maxTokensPerTurn?: number;
  /** Whether to dedupe across providers (default true). */
  dedupe?: boolean;
}
