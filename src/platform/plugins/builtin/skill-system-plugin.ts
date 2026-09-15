/**
 * Skill system plugin — mounts the formal SkillSystem as a host capability.
 *
 * The existing SkillsRegistry (skills/registry.ts) is preserved as the
 * default filesystem provider. Plugins or embedding apps can add more
 * providers (MCP, HTTP, in-memory) via the SkillSystem API.
 */

import { defineCapabilityToken } from "../../../core/capabilities/index.js";
import { FilesystemSkillProvider } from "../../../skills/providers.js";
import { SkillSystem } from "../../../skills/skill-system.js";
import { definePlugin } from "../types.js";

/** Token for the shared SkillSystem. */
export const SKILL_SYSTEM = defineCapabilityToken<SkillSystem>("nexum:skills:system");

export interface SkillSystemPluginOptions {
  /** Workspace root for filesystem skill discovery. */
  workspaceRoot?: string;
  /** Home directory for global skill discovery. */
  homeDir?: string;
  /** Additional providers beyond the default filesystem one. */
  extraProviders?: Array<{ id: string; list(): unknown; load(m: unknown): unknown }>;
}

export function skillSystemPlugin(opts: SkillSystemPluginOptions = {}) {
  return definePlugin({
    manifest: {
      id: "skill-system",
      name: "Skill System",
      version: "1.0.0",
      description: "Formal skill registry, catalog, selector, and injector.",
      provides: ["skills"],
      requires: [],
    },
    setup(ctx) {
      const providers = [];
      if (opts.workspaceRoot) {
        providers.push(
          new FilesystemSkillProvider({
            workspaceRoot: opts.workspaceRoot,
            homeDir: opts.homeDir,
          }),
        );
      }
      const system = new SkillSystem(providers);
      ctx.provide(SKILL_SYSTEM.id, system);
      ctx.declareCapability("skills");
      ctx.log.debug("skill system registered", { providers: providers.length });
    },
  });
}
