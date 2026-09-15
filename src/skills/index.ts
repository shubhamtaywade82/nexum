/**
 * Skills — formal skill system.
 *
 * A Skill is reusable expertise (SKILL.md + optional references/scripts/
 * templates), not a callable Tool. Skills are prompt-injected content that
 * helps the model apply domain-specific knowledge.
 *
 * The formal skill system (this barrel) provides:
 *   - SkillProvider (pluggable sources: filesystem, in-memory, ...)
 *   - SkillLoader (orchestrates providers, dedupes)
 *   - SkillCatalog (queryable materialized set)
 *   - SkillSelector (per-step selection, progressive disclosure)
 *   - SkillInjector (token-budgeted content injection)
 *   - SkillSystem facade (selectAndInject in one call)
 *
 * The legacy SkillsRegistry is preserved for backward compatibility.
 */

// Existing types and loader (backward-compatible).
export type { SkillScope, SkillMeta, SkillContent, SkillScore, SkillUsageStats } from "./types.js";
export { SkillsRegistry } from "./registry.js";
export { discoverSkills, loadSkillContent, type DiscoverOptions } from "./loader.js";
export { resolveSkills, type ResolveOptions } from "./resolver.js";

// Formal skill system (new).
export type {
  SkillProvider,
  SkillSelectionInput,
  SkillSelection,
  SkillScored,
  SkillInjection,
  SkillSystemOptions,
} from "./formal-types.js";
export { FilesystemSkillProvider, InMemorySkillProvider, type FilesystemSkillProviderOptions } from "./providers.js";
export { SkillLoader, type LoadResult } from "./skill-loader.js";
export { SkillCatalog } from "./skill-catalog.js";
export { SkillSelector, tokenizeForSkillSelection } from "./skill-selector.js";
export { SkillInjector } from "./skill-injector.js";
export { SkillSystem } from "./skill-system.js";
