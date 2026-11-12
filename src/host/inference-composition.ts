/**
 * Builds the host's raw inference service from the user's config: the same providers the agent uses (primary and
 * quick lanes), the shared budget ledger for cloud admission, and the catalogue prices.
 */

import type { CliConfig } from "../cli/config.js";
import { cloudIsConfigured, createCloudAdmission } from "../economics/composition.js";
import { Provider } from "../models/adapters/provider.js";
import { InferenceDispatcher } from "../models/gateway/inference-dispatcher.js";
import { DEFAULT_PRICE_CATALOG } from "../models/profiles/pricing-catalog.js";
import { InferenceService } from "./inference.js";

export function createInferenceService(cfg: CliConfig): InferenceService {
  const providerOpts = {
    tier: cfg.tier,
    host: cfg.host,
    apiKey: cfg.apiKey,
    apiKeys: cfg.apiKeys,
    ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
  };
  const primary = new Provider({ ...providerOpts, model: cfg.model });
  const quick = cfg.quickModel ? new Provider({ ...providerOpts, model: cfg.quickModel }) : primary;
  const admission = cloudIsConfigured(cfg) ? createCloudAdmission(cfg.budget) : undefined;
  const dispatcher = new InferenceDispatcher({ lanes: { primary, quick }, admission });
  // Holds left by an earlier process are resolved against the provider's balance. Silent when there are none.
  if (admission) void admission.reconcile(primary).catch(() => undefined);
  return new InferenceService({ dispatcher, prices: DEFAULT_PRICE_CATALOG });
}
