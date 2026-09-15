/**
 * Core services plugin — registers the ServiceRegistry and CapabilityRegistry
 * as host-level capabilities that other plugins can lookup.
 *
 * This plugin is the foundation: it provides the shared registries that all
 * subsequent plugins (tools, models, skills, jobs, subagents, …) populate.
 */

import { defineCapabilityToken } from "../../../core/capabilities/index.js";
import { ServiceRegistry } from "../../../core/services/index.js";
import { definePlugin } from "../types.js";

/** Token for the shared ServiceRegistry (the DI seam for long-lived services). */
export const SERVICE_REGISTRY = defineCapabilityToken<ServiceRegistry>("nexum:core:service-registry");

/** Token for the shared CapabilityRegistry (the DI seam for ad-hoc capabilities). */
// CapabilityRegistry is already exported from core/capabilities; re-export the token here.

export function coreServicesPlugin() {
  return definePlugin({
    manifest: {
      id: "core-services",
      name: "Core Services",
      version: "1.0.0",
      description: "Registers the shared ServiceRegistry used by all other plugins.",
      provides: ["services"],
    },
    setup(ctx) {
      const services = new ServiceRegistry();
      ctx.provide(SERVICE_REGISTRY.id, services);
      ctx.declareCapability("services");
      ctx.log.debug("service registry registered");
    },
    async start() {
      // ServiceRegistry.start() is called explicitly by the host application
      // after all plugins have been set up, so that service start order is
      // deterministic and not racing plugin start().
    },
  });
}
