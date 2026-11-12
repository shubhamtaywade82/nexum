/**
 * Composition: builds the ledger-backed cloud admission from user-level budget settings. The composition roots
 * (the agent, the benchmark and evolution CLIs) call this once and pass the result to the dispatchers.
 */

import { DEFAULT_PRICE_CATALOG } from "../models/profiles/pricing-catalog.js";
import { LedgerCloudAdmission } from "./cloud-admission.js";
import { BudgetLedger } from "./ledger/budget-ledger.js";
import { MICRO_USD_PER_USD } from "./cost.js";
import { installDefaultCloudAdmission } from "../models/gateway/inference-dispatcher.js";

export interface CloudBudgetSettings {
  /** SQLite file of the shared ledger. Per user. */
  readonly ledgerPath: string;
  readonly accountId: string;
  /** null: no USD ceiling (a percentage-mode balance). */
  readonly monthlyCapUsd: number | null;
  readonly maxOutputTokens: number;
}

export function createCloudAdmission(settings: CloudBudgetSettings, clock?: () => Date): LedgerCloudAdmission {
  const ledger = new BudgetLedger({ path: settings.ledgerPath, ...(clock ? { clock } : {}) });
  const monthlyCapMicro =
    settings.monthlyCapUsd === null ? null : Math.round(settings.monthlyCapUsd * MICRO_USD_PER_USD);
  return new LedgerCloudAdmission({
    ledger,
    prices: DEFAULT_PRICE_CATALOG,
    accountId: settings.accountId,
    monthlyCapMicro,
    defaultMaxOutputTokens: settings.maxOutputTokens,
    ...(clock ? { clock } : {}),
  });
}

/** Whether this configuration can reach a cloud provider at all. */
export function cloudIsConfigured(cfg: { tier: string; apiKey?: string; apiKeys?: readonly string[] }): boolean {
  return cfg.tier === "cloud" || Boolean(cfg.apiKey) || (cfg.apiKeys?.length ?? 0) > 0;
}

/**
 * For a composition root that builds its own providers: when cloud is configured, opens the ledger and installs the
 * admission every dispatcher falls back to. Returns undefined, and opens nothing, when cloud is not configured.
 */
export function installCloudBudget(cfg: {
  tier: string;
  apiKey?: string;
  apiKeys?: readonly string[];
  budget: CloudBudgetSettings;
}): LedgerCloudAdmission | undefined {
  if (!cloudIsConfigured(cfg)) return undefined;
  const admission = createCloudAdmission(cfg.budget);
  installDefaultCloudAdmission(admission);
  return admission;
}
