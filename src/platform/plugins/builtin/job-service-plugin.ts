/**
 * Job service plugin — mounts the JobService as a host capability.
 */

import { defineCapabilityToken } from "../../../core/capabilities/index.js";
import { JobService } from "../../../jobs/index.js";
import { definePlugin } from "../types.js";

/** Token for the shared JobService. */
export const JOB_SERVICE = defineCapabilityToken<JobService>("nexum:jobs:service");

export interface JobServicePluginOptions {
  maxConcurrent?: number;
  defaultMaxOutputLines?: number;
}

export function jobServicePlugin(opts: JobServicePluginOptions = {}) {
  return definePlugin({
    manifest: {
      id: "job-service",
      name: "Job Service",
      version: "1.0.0",
      description: "Generic background job management with submit/status/output/cancel/kill/list.",
      provides: ["jobs"],
      requires: [],
    },
    setup(ctx) {
      const service = new JobService({
        maxConcurrent: opts.maxConcurrent,
        defaultMaxOutputLines: opts.defaultMaxOutputLines,
      });
      ctx.provide(JOB_SERVICE.id, service);
      ctx.declareCapability("jobs");
      ctx.log.debug("job service registered");
    },
    async stop() {
      // The embedding app should call service.stopAll() on shutdown.
      // We don't have a handle here because the service is owned by the host.
    },
  });
}
