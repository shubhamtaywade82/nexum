/**
 * Subagent service plugin — mounts the SubagentService as a host capability.
 */

import { defineCapabilityToken } from "../../../core/capabilities/index.js";
import { SubagentService, defaultSubagentProviders } from "../../../subagents/index.js";
import { definePlugin } from "../types.js";

/** Token for the shared SubagentService. */
export const SUBAGENT_SERVICE = defineCapabilityToken<SubagentService>("nexum:subagents:service");

export interface SubagentServicePluginOptions {
  /** Pass through to SubagentServiceOptions. */
  runtime?: unknown;
  agents?: unknown;
  maxConcurrent?: number;
  maxTotalPerSession?: number;
}

export function subagentServicePlugin(opts: SubagentServicePluginOptions = {}) {
  return definePlugin({
    manifest: {
      id: "subagent-service",
      name: "Subagent Service",
      version: "1.0.0",
      description: "Multi-provider subagent management (in-process, process, ACP, SDK, external).",
      provides: ["subagents"],
      requires: [],
    },
    setup(ctx) {
      const service = new SubagentService({
        maxConcurrent: opts.maxConcurrent,
        maxTotalPerSession: opts.maxTotalPerSession,
      });
      // In-process provider requires runtime + agents; if not provided, the
      // service starts with no providers and embedding app adds them later.
      if (opts.runtime && opts.agents) {
        for (const p of defaultSubagentProviders({
          runtime: opts.runtime as never,
          agents: opts.agents as never,
        })) {
          service.registerProvider(p);
        }
      }
      ctx.provide(SUBAGENT_SERVICE.id, service);
      ctx.declareCapability("subagents");
      ctx.log.debug("subagent service registered", {
        providers: service.listProviders().length,
      });
    },
    async stop() {
      // No shared handle to stop here; the embedding app owns the service.
    },
  });
}
