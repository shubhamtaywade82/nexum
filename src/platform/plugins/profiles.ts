/**
 * Plugin profiles — curated bundles of plugins for common product shapes.
 *
 * A profile is just a function returning a list of `NexumPlugin` instances.
 * The embedding application picks a profile (or composes its own) and hands
 * the result to `host.registerAll(profile())`.
 *
 * Profiles mirror DeepSeek Harness's SDK profile concept: different products
 * reuse different bundles and omit or include capabilities such as settings,
 * credentials, telemetry, web tools, and the default tool roster.
 */

import type { NexumPlugin } from "./types.js";
import { coreServicesPlugin } from "./builtin/core-services-plugin.js";
import { toolRegistryPlugin } from "./builtin/tool-registry-plugin.js";
import { modelRegistryPlugin } from "./builtin/model-registry-plugin.js";
import { skillSystemPlugin } from "./builtin/skill-system-plugin.js";
import { subagentServicePlugin } from "./builtin/subagent-service-plugin.js";
import { jobServicePlugin } from "./builtin/job-service-plugin.js";
import { compactionServicePlugin } from "./builtin/compaction-service-plugin.js";
import { sessionQueryServicePlugin } from "./builtin/session-query-service-plugin.js";

export interface PluginProfile {
  id: string;
  description: string;
  plugins: () => NexumPlugin[];
}

/**
 * Minimal profile — just the kernel services and a tool registry.
 * Suitable for embedding Nexum as a library in another product.
 */
export const minimalProfile: PluginProfile = {
  id: "minimal",
  description: "Kernel services + tool registry only. No skills, no subagents, no jobs.",
  plugins: () => [coreServicesPlugin(), toolRegistryPlugin()],
};

/**
 * Standard profile — the typical CLI/TUI agent: tools, models, skills,
 * subagents, jobs, compaction, session query. This is what `nexum` the CLI
 * would mount by default.
 */
export const standardProfile: PluginProfile = {
  id: "standard",
  description: "Tools, models, skills, subagents, jobs, compaction, session query.",
  plugins: () => [
    coreServicesPlugin(),
    toolRegistryPlugin(),
    modelRegistryPlugin(),
    skillSystemPlugin(),
    subagentServicePlugin(),
    jobServicePlugin(),
    compactionServicePlugin(),
    sessionQueryServicePlugin(),
  ],
};

/**
 * Full profile — every built-in plugin. Suitable for a server-grade Nexum
 * host (RPC server, automation worker) that wants all capabilities mounted.
 */
export const fullProfile: PluginProfile = {
  id: "full",
  description: "All built-in plugins. Use for server / RPC / automation hosts.",
  plugins: () => [
    coreServicesPlugin(),
    toolRegistryPlugin(),
    modelRegistryPlugin(),
    skillSystemPlugin(),
    subagentServicePlugin(),
    jobServicePlugin(),
    compactionServicePlugin(),
    sessionQueryServicePlugin(),
  ],
};
