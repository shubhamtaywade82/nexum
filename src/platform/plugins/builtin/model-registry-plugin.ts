/**
 * Model registry plugin — exposes the kernel's ModelGateway / capability
 * registry as a host capability.
 *
 * Plugins that contribute model providers (Ollama, OpenAI, Anthropic, …)
 * lookup this capability and register their profiles / transports.
 */

import { defineCapabilityToken } from "../../../core/capabilities/index.js";
import type { ModelGateway } from "../../../models/gateway/model-gateway.js";
import { ModelCapabilityRegistry } from "../../../models/profiles/model-capability-registry.js";
import { definePlugin } from "../types.js";

/** Token for the shared ModelGateway. */
export const MODEL_GATEWAY = defineCapabilityToken<ModelGateway>("nexum:models:gateway");

/** Token for the shared ModelCapabilityRegistry. */
export const MODEL_CAPABILITY_REGISTRY = defineCapabilityToken<ModelCapabilityRegistry>(
  "nexum:models:capability-registry",
);

export function modelRegistryPlugin() {
  return definePlugin({
    manifest: {
      id: "model-registry",
      name: "Model Registry",
      version: "1.0.0",
      description: "Provides the shared ModelGateway and capability registry.",
      provides: ["models"],
    },
    setup(ctx) {
      // The actual ModelGateway is constructed by the embedding application
      // (it needs provider configuration, Ollama URL, API keys, etc.) and
      // provided to the host BEFORE plugins start. This plugin just ensures
      // the capability token is declared so other plugins can detect it.
      //
      // If the host already has a ModelGateway (provided by the embedding
      // app via `host.register` override or direct `provide()`), we don't
      // overwrite it.
      if (!ctx.host.provides(MODEL_CAPABILITY_REGISTRY.id)) {
        ctx.provide(MODEL_CAPABILITY_REGISTRY.id, new ModelCapabilityRegistry());
      }
      ctx.declareCapability("models");
      ctx.log.debug("model registry declared");
    },
  });
}
