/**
 * SkillSystem — the formal skill capability facade.
 *
 * Ties together SkillLoader + SkillCatalog + SkillSelector + SkillInjector
 * into a single service that an agent can call per-step:
 *
 *   const injection = await skillSystem.selectAndInject({
 *     prompt: userMessage,
 *     projectLanguage: "typescript",
 *     alreadyInjected: session.injectedSkillIds,
 *   });
 *   if (injection.content) {
 *     await model.chat([...existingMessages, { role: "system", content: injection.content }]);
 *     session.injectedSkillIds.push(...injection.injectedSkillIds);
 *   }
 *
 * This is the DeepSeek-Harness-style "skill tool + agent.inject()" pattern,
 * implemented as a direct service rather than a tool (since skills inject
 * context, not call functions).
 */

import type {
  SkillInjection,
  SkillProvider,
  SkillSelectionInput,
  SkillSystemOptions,
} from "./formal-types.js";
import { SkillLoader } from "./skill-loader.js";
import { SkillCatalog } from "./skill-catalog.js";
import { SkillSelector } from "./skill-selector.js";
import { SkillInjector } from "./skill-injector.js";

export class SkillSystem {
  readonly loader: SkillLoader;
  readonly catalog: SkillCatalog;
  readonly selector: SkillSelector;
  readonly injector: SkillInjector;
  private readonly maxSkillsPerTurn: number;
  private readonly maxTokensPerTurn: number;

  constructor(providers: SkillProvider[] = [], opts: SkillSystemOptions = {}) {
    this.loader = new SkillLoader(providers);
    this.catalog = new SkillCatalog(this.loader);
    this.selector = new SkillSelector(this.catalog);
    this.injector = new SkillInjector(providers);
    this.maxSkillsPerTurn = opts.maxSkillsPerTurn ?? 3;
    this.maxTokensPerTurn = opts.maxTokensPerTurn ?? 2000;
  }

  addProvider(provider: SkillProvider): this {
    this.loader.addProvider(provider);
    this.injector.addProvider(provider);
    return this;
  }

  /** Refresh the catalog (call when skills may have changed on disk). */
  refresh(): void {
    this.loader.invalidate();
  }

  /** Select + inject in one call (the common path for agents). */
  async selectAndInject(input: SkillSelectionInput): Promise<SkillInjection> {
    const selection = await this.selector.select({
      ...input,
      maxSkills: input.maxSkills ?? this.maxSkillsPerTurn,
    });
    return this.injector.inject(selection, this.maxTokensPerTurn);
  }
}
