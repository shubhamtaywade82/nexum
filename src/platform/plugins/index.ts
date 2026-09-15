/**
 * Plugin system — public barrel.
 *
 * The plugin layer sits ABOVE the Nexum kernel and BELOW the embedding
 * application (CLI / TUI / RPC server). It lets a product compose its
 * capabilities (tools, models, skills, agents, jobs, subagents, compaction,
 * webhooks, …) as independent plugins with explicit dependencies and
 * lifecycle, instead of hard-wiring them in a composition root.
 *
 * Embedding applications should:
 *   1. construct a `DefaultPluginHost({ workspaceRoot })`
 *   2. `host.registerAll(profile.plugins)` (see `./profiles.ts`)
 *   3. `await host.start()`
 *   4. fetch shared capabilities via `host.lookup<Token>(token)`
 *   5. `await host.stop()` on shutdown
 */

export type {
  PluginId,
  PluginVersion,
  PluginManifest,
  PluginContext,
  PluginLogger,
  PluginState,
  PluginRecord,
  PluginHost,
  PluginHostEvent,
  PluginHostEventHandler,
  NexumPlugin,
} from "./types.js";
export { definePlugin, pluginFromRegistration, PLUGIN_EVENT_SINK_TOKEN } from "./types.js";
export { PluginRegistry, validateManifest } from "./registry.js";
export { DefaultPluginHost, type PluginHostOptions } from "./host.js";
export { resolvePluginOrder, type ResolveResult } from "./dependency-resolver.js";

// Built-in plugins (mountable as-is or via profiles).
export { coreServicesPlugin } from "./builtin/core-services-plugin.js";
export { toolRegistryPlugin } from "./builtin/tool-registry-plugin.js";
export { modelRegistryPlugin } from "./builtin/model-registry-plugin.js";
export { skillSystemPlugin } from "./builtin/skill-system-plugin.js";
export { subagentServicePlugin } from "./builtin/subagent-service-plugin.js";
export { jobServicePlugin } from "./builtin/job-service-plugin.js";
export { compactionServicePlugin } from "./builtin/compaction-service-plugin.js";
export { sessionQueryServicePlugin } from "./builtin/session-query-service-plugin.js";
export { type PluginProfile, minimalProfile, standardProfile, fullProfile } from "./profiles.js";
