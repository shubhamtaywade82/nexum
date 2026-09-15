/**
 * Compaction service plugin.
 */

import { defineCapabilityToken } from "../../../core/capabilities/index.js";
import { CompactionService } from "../../../compaction/index.js";
import { definePlugin } from "../types.js";

/** Token for the shared CompactionService. */
export const COMPACTION_SERVICE = defineCapabilityToken<CompactionService>("nexum:compaction:service");

export function compactionServicePlugin() {
  return definePlugin({
    manifest: {
      id: "compaction-service",
      name: "Compaction Service",
      version: "1.0.0",
      description: "Token-aware context compaction (estimator, policy, summary, reducer, rebuilder).",
      provides: ["compaction"],
      requires: [],
    },
    setup(ctx) {
      const service = new CompactionService();
      ctx.provide(COMPACTION_SERVICE.id, service);
      ctx.declareCapability("compaction");
      ctx.log.debug("compaction service registered");
    },
  });
}
