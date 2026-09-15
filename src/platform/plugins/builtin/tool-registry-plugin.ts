/**
 * Tool registry plugin — exposes the kernel's ToolCatalog as a host capability.
 *
 * Plugins that contribute tools (filesystem, git, lsp, browser, trading, …)
 * lookup this capability in their `setup()` and call `catalog.register(...)`.
 *
 * This is the bridge between the plugin world and the existing ToolPack
 * mounting pattern: a plugin can either register individual tools or call
 * `mountToolPack(pack, catalog)`.
 */

import { defineCapabilityToken } from "../../../core/capabilities/index.js";
import { ToolCatalog } from "../../../tools/gateway/tool-catalog.js";
import { definePlugin } from "../types.js";

/** Token for the shared ToolCatalog. */
export const TOOL_CATALOG = defineCapabilityToken<ToolCatalog>("nexum:tools:catalog");

export function toolRegistryPlugin() {
  return definePlugin({
    manifest: {
      id: "tool-registry",
      name: "Tool Registry",
      version: "1.0.0",
      description: "Provides the shared ToolCatalog that tool-providing plugins populate.",
      provides: ["tools"],
    },
    setup(ctx) {
      const catalog = new ToolCatalog();
      ctx.provide(TOOL_CATALOG.id, catalog);
      ctx.declareCapability("tools");
      ctx.log.debug("tool catalog registered");
    },
  });
}
