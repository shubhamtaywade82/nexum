/**
 * `nexum cloud-check` — Ollama Cloud readiness smoke test (measurement day, step 1).
 *
 * Verifies, in order, each layer Nexum needs before any benchmark or evolution
 * run spends a credit:
 *
 *   1. credential present (env / config, never printed)
 *   2. account reachable — /api/usage and /api/balance answer per key
 *   3. model listing answers (OpenAI-compatible /v1/models)
 *   4. one minimal real chat call, metered through the InferenceDispatcher so
 *      it lands in the BudgetTracker AND the usage ledger
 *   5. the ledger actually recorded it (tokens known-or-unknown, cost
 *      known-or-unknown, latency, status) — proving "every model call is
 *      measurable" before any expensive loop starts
 *
 * Exit code 0 = all critical checks passed; 1 = anything critical failed.
 * Individual check failures are reported, not swallowed. The smoke chat call
 * costs a fraction of a cent at published rates (a few hundred tokens total).
 */

import { loadConfig } from "./config.js";
import { Provider } from "../models/adapters/provider.js";
import { InferenceDispatcher } from "../models/gateway/inference-dispatcher.js";
import { BudgetManager } from "../runtime/budget/budget-manager.js";
import { ModelUsageLedger } from "../models/observability/usage-ledger.js";
import { MonthlySpendGuard } from "../models/observability/monthly-spend-guard.js";
import { priceFor } from "../models/profiles/cloud-price-catalog.js";

export interface CloudCheckOptions {
  /** Model for the smoke chat call. Defaults to the configured model. */
  model?: string;
  /** Skip the billable chat call (checks 1-3 only). */
  noCall?: boolean;
  /** Budget ceiling for the smoke call itself (admission guard). Default $0.25. */
  maxCostUsd?: number;
}

export type CloudCheckResult = {
  ok: boolean;
  lines: string[];
};

function fmtUsd(n: number | undefined): string {
  return n === undefined ? "unknown" : `$${n.toFixed(4)}`;
}

export async function runCloudCheck(opts: CloudCheckOptions = {}): Promise<CloudCheckResult> {
  const lines: string[] = [];
  let ok = true;
  const cfg = loadConfig();

  // 1. credentials ──────────────────────────────────────────────────────────
  const keys = cfg.apiKeys ?? (cfg.apiKey ? [cfg.apiKey] : []);
  if (keys.length === 0) {
    lines.push("credentials: MISSING — set OLLAMA_API_KEY (or apiKey/accounts in .nexum/config.json)");
    return { ok: false, lines };
  }
  lines.push(`credentials: ${keys.length} key(s) configured (values never printed)`);

  const cloud = new Provider({
    tier: "cloud",
    model: opts.model ?? cfg.model,
    apiKey: cfg.apiKey,
    apiKeys: cfg.apiKeys,
    accountLabels: cfg.accountLabels,
    // An explicit host in config for the cloud tier reaches the provider;
    // otherwise defaultHostForTier applies (incl. its OLLAMA_CLOUD_HOST
    // development override).
    ...(cfg.tier === "cloud" && cfg.host ? { host: cfg.host } : {}),
  });

  // 2. account endpoints ───────────────────────────────────────────────────
  try {
    const usage = await cloud.usageAll();
    for (const row of usage) {
      if (row.error) {
        lines.push(`usage[${row.label}]: ERROR — ${row.error}`);
        ok = false;
      } else {
        // SDK UsageResponse shape: totals is UsageMetrics (request_count, usage_usd, token counts)
        const u = row.usage as unknown as {
          totals?: { request_count?: number; usage_usd?: number; input_tokens?: number; output_tokens?: number };
        } & Record<string, unknown>;
        const t = u?.totals;
        lines.push(
          `usage[${row.label}]: ok (requests: ${t?.request_count ?? "n/a"}${
            t?.usage_usd !== undefined ? `, $${t.usage_usd.toFixed(4)}` : ""
          }${t?.input_tokens !== undefined ? `, ${t.input_tokens} in/${t.output_tokens ?? 0} out tok` : ""})`,
        );
      }
    }
  } catch (e) {
    lines.push(`usage: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    ok = false;
  }
  try {
    const balances = await cloud.balanceAll();
    for (const row of balances) {
      if (row.error) {
        lines.push(`balance[${row.label}]: ERROR — ${row.error}`);
        ok = false;
      } else {
        // SDK BalanceResponse: { included: { balance_usd, allowance_usd, period } | legacy %, purchased: { balance_usd } }
        const b = row.balance as unknown as {
          included?: { balance_usd?: number; allowance_usd?: number };
          purchased?: { balance_usd?: number };
        } & Record<string, unknown>;
        const inc = b?.included;
        if (inc?.balance_usd !== undefined) {
          lines.push(
            `balance[${row.label}]: included=$${inc.balance_usd.toFixed(4)} of $${(inc.allowance_usd ?? 0).toFixed(4)} allowance, purchased=$${(b?.purchased?.balance_usd ?? 0).toFixed(4)}`,
          );
        } else {
          // legacy session/weekly percentage shape — render generically
          const text = Object.entries(b ?? {})
            .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(4) : JSON.stringify(v).slice(0, 60)}`)
            .join(" ");
          lines.push(`balance[${row.label}]: ${text || "ok (no fields)"}`);
        }
      }
    }
  } catch (e) {
    lines.push(`balance: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    ok = false;
  }

  // 3. model listing ────────────────────────────────────────────────────────
  try {
    const listed = (await cloud.availableModels()) as { data?: Array<{ id?: string }> };
    const modelCount = listed.data?.length ?? 0;
    if (modelCount === 0) {
      lines.push("models: endpoint answered but listed 0 models");
      ok = false;
    } else {
      const ids = (listed.data ?? [])
        .map((m) => m.id)
        .filter(Boolean)
        .slice(0, 8);
      lines.push(`models: ${modelCount} available (e.g. ${ids.join(", ")}${modelCount > 8 ? ", …" : ""})`);
    }
  } catch (e) {
    lines.push(`models: ERROR — ${e instanceof Error ? e.message : String(e)}`);
    ok = false;
  }

  // 4. metered smoke chat call ──────────────────────────────────────────────
  // (monthly guardrail snapshot first: if the month is already blocked, the
  // smoke call would be refused at admission and the reason must be visible)
  const monthlyGuard = new MonthlySpendGuard({
    ledger: new ModelUsageLedger(),
    monthlyBudgetUsd: cfg.monthlyBudgetUsd,
    reserveUsd: cfg.reserveUsd,
  });
  const msnap = monthlyGuard.snapshot();
  lines.push(
    `monthly guard: ${msnap.blocked ? "BLOCKED" : "ok"} — ${msnap.calls} cloud calls, ${fmtUsd(msnap.spentUsd)} spent in ${msnap.month} (block at ${fmtUsd(msnap.blockAtUsd)}; budget ${fmtUsd(cfg.monthlyBudgetUsd ?? 48)} - reserve ${fmtUsd(cfg.reserveUsd ?? 12)})`,
  );
  if (msnap.blocked) {
    lines.push(
      "cloud-check: FAIL (monthly spend guard blocks new cloud calls — raise NEXUM_MONTHLY_BUDGET_USD or lower NEXUM_RESERVE_USD)",
    );
    return { ok: false, lines };
  }

  if (!opts.noCall) {
    const model = opts.model ?? cfg.model;
    const priced = priceFor(
      // dispatcher's default table; fine to re-load for the report
      (await import("../models/profiles/cloud-price-catalog.js")).loadPriceTable(),
      model,
    );
    lines.push(
      `price[${model}]: ${priced ? `$${priced.inputPerMillion}/M in, $${priced.outputPerMillion}/M out (catalog)` : "no catalog entry — cost will read unknown"}`,
    );

    const ledger = new ModelUsageLedger();
    const budget = new BudgetManager({
      runId: `cloud-check_${Date.now()}`,
      budget: { maxCostUsd: opts.maxCostUsd ?? 0.25 },
    });
    const dispatcher = new InferenceDispatcher({
      lanes: { cloud },
      budget,
      registry: undefined,
      ledger,
    });
    const started = Date.now();
    try {
      const response = await dispatcher.dispatch(
        { lane: "cloud", purpose: "cloud-check.smoke", model },
        [{ role: "user", content: "Reply with exactly: ok" }],
        { stream: false },
      );
      const latency = Date.now() - started;
      const content = (response.message?.content ?? "").trim();
      lines.push(
        `chat: ok — ${content.slice(0, 40).replace(/\n/g, " ")}${content.length > 40 ? "…" : ""} (${latency}ms, ${response.routedModel ?? model})`,
      );

      // 5. the ledger recorded it ──────────────────────────────────────────
      const recs = ledger.all();
      const rec = recs[recs.length - 1];
      if (!rec) {
        lines.push("ledger: MISSING — the smoke call was not recorded (dispatcher wiring broken)");
        ok = false;
      } else {
        lines.push(
          `ledger: 1 call — tokens ${rec.tokensUnknown ? "UNKNOWN (provider did not meter)" : `${rec.promptTokens ?? 0} in / ${rec.completionTokens ?? 0} out`}, cost ${rec.costUnknown ? "unknown" : fmtUsd(rec.costUsd)}, status ${rec.status}, ${rec.latencyMs}ms`,
        );
        const snap = budget.snapshot();
        lines.push(
          `budget: modelCalls=${snap.modelCalls}, unmetered=${snap.unmeteredModelCalls}, costUsd=${fmtUsd(snap.costUsd)} (ceiling $${(opts.maxCostUsd ?? 0.25).toFixed(2)})`,
        );
        if (rec.status !== "success") {
          ok = false;
        }
      }
    } catch (e) {
      lines.push(`chat: FAILED — ${e instanceof Error ? e.message : String(e)}`);
      const recs = ledger.all();
      if (recs.length > 0) {
        const rec = recs[recs.length - 1];
        lines.push(`ledger: call recorded anyway — status ${rec.status}${rec.error ? ` (${rec.error})` : ""}`);
      }
      ok = false;
    }
  }

  lines.push(ok ? "cloud-check: PASS" : "cloud-check: FAIL");
  return { ok, lines };
}

const isDirectRun = process.argv[1] && fileURLToPathEquals(process.argv[1]);
function fileURLToPathEquals(p: string): boolean {
  try {
    return import.meta.url === `file://${p}`;
  } catch {
    return false;
  }
}

if (isDirectRun) {
  const args = process.argv.slice(2);
  const noCall = args.includes("--no-call");
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
  const costIdx = args.indexOf("--max-cost");
  const maxCost = costIdx >= 0 ? Number(args[costIdx + 1]) : undefined;
  runCloudCheck({ noCall, model, maxCostUsd: maxCost })
    .then((r) => {
      for (const line of r.lines) console.log(line);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
