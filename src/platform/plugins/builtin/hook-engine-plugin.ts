/**
 * Hook engine plugin — exposes the embedding agent's HookEngine to
 * in-process plugins (prompt-submit / pre-tool / post-tool hooks).
 */

import { defineCapabilityToken } from "../../../core/capabilities/index.js";
import type { HookEngine } from "../../../hooks/engine.js";
import { definePlugin } from "../types.js";

/** Token for the agent's HookEngine. */
export const HOOK_ENGINE = defineCapabilityToken<HookEngine>("nexum:hooks:engine");

export function hookEnginePlugin(engine: HookEngine) {
  return definePlugin({
    manifest: {
      id: "hook-engine",
      name: "Hook Engine",
      version: "1.0.0",
      description: "Agent lifecycle hooks: user prompt submit, pre/post tool use.",
      provides: ["hooks"],
      requires: [],
    },
    setup(ctx) {
      ctx.provide(HOOK_ENGINE.id, engine);
      ctx.declareCapability("hooks");
    },
  });
}
