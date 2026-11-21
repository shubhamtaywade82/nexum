/**
 * ModelUsageLedger — the per-call usage ledger (measurement-infrastructure item 2).
 *
 * BudgetTracker answers "has this run crossed a ceiling?" but nothing keeps
 * the individual call records: which run, why (purpose lane), which model,
 * how many tokens (provider-reported or unknown), what it cost (estimate or
 * unknown), how long it took, whether it retried, and whether it succeeded.
 * The runtime store's `usage.changed` event only accumulates two session
 * totals, and the evolution metrics were flagged as possibly synthetic in
 * docs/PRODUCTION_AUDIT.md precisely because no request-level trail exists.
 *
 * Every record is append-only JSONL under <home>/.nexum/usage/ledger.jsonl
 * (one line per call, including failed calls — a failed cloud call whose
 * outcome is unknown may still have billed). Latency and status come from
 * the dispatcher, the one place a chat request leaves Nexum.
 *
 * Unknown ≠ zero: tokensUnknown / costUnknown mirror usage-reading.ts's
 * contract. A call the provider did not meter is recorded as unknown, not
 * free, so "100% of model calls have usage records" can be audited.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export type UsageStatus = "success" | "error" | "unknown_outcome";

/** One model call, as recorded by the dispatcher. */
export interface ModelUsageRecord {
  /** Ledger line id (distinct from runId — one run has many calls). */
  id: string;
  runId: string;
  /** Purpose lane the dispatcher dispatched on ("chat.primary", "benchmark", ...). */
  purpose: string;
  lane: string;
  tier: "local" | "cloud";
  model: string;
  /** Prompt tokens the provider reported; undefined = not reported. */
  promptTokens?: number;
  /** Cached prompt tokens (KV cache hits), when reported. */
  cachedPromptTokens?: number;
  /** Completion tokens the provider reported; undefined = not reported. */
  completionTokens?: number;
  /** True when either token count is missing (provider did not meter). */
  tokensUnknown: boolean;
  /** USD estimate from the price catalog; undefined when the model has no price. */
  costUsd?: number;
  /** True when costUsd is absent (no price entry / no token counts). */
  costUnknown: boolean;
  latencyMs: number;
  /** Retry attempts before this record's call (the SDK is configured retries:0; router failover counts). */
  retryCount: number;
  status: UsageStatus;
  /** Error class name for failed calls; absent on success. */
  error?: string;
  at: string; // ISO timestamp
}

export interface UsageLedgerOptions {
  /** Directory for ledger.jsonl. Defaults to ~/.nexum/usage. */
  dir?: string;
  /** Disable persistence (tests); records stay in memory. */
  persist?: boolean;
  /** Clock injection for tests. */
  now?: () => Date;
}

/** Aggregated view used by the report command. */
export interface UsageAggregate {
  records: number;
  success: number;
  errors: number;
  unknownOutcomes: number;
  tokensUnknown: number;
  costUnknown: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  byModel: Array<{
    model: string;
    tier: "local" | "cloud";
    calls: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    tokensUnknown: number;
    costUnknown: number;
  }>;
}

export class ModelUsageLedger {
  private readonly dir: string;
  private readonly persist: boolean;
  private readonly now: () => Date;
  private readonly records: ModelUsageRecord[] = [];
  /** Guards against an unwritable ledger dir turning every call into an error. */
  private writeBroken = false;

  constructor(opts: UsageLedgerOptions = {}) {
    this.dir = opts.dir ?? join(homedir(), ".nexum", "usage");
    this.persist = opts.persist ?? true;
    this.now = opts.now ?? (() => new Date());
    if (this.persist) {
      try {
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      } catch {
        this.writeBroken = true;
      }
    }
  }

  get filePath(): string {
    return join(this.dir, "ledger.jsonl");
  }

  /** Append one call record. Never throws: a ledger failure must not fail the call it records. */
  record(rec: Omit<ModelUsageRecord, "id" | "at"> & { id?: string; at?: string }): ModelUsageRecord {
    const full: ModelUsageRecord = {
      id: rec.id ?? `usage_${randomUUID()}`,
      at: rec.at ?? this.now().toISOString(),
      runId: rec.runId,
      purpose: rec.purpose,
      lane: rec.lane,
      tier: rec.tier,
      model: rec.model,
      promptTokens: rec.promptTokens,
      cachedPromptTokens: rec.cachedPromptTokens,
      completionTokens: rec.completionTokens,
      tokensUnknown: rec.tokensUnknown,
      costUsd: rec.costUsd,
      costUnknown: rec.costUnknown,
      latencyMs: rec.latencyMs,
      retryCount: rec.retryCount,
      status: rec.status,
      ...(rec.error !== undefined ? { error: rec.error } : {}),
    };
    this.records.push(full);
    if (this.persist && !this.writeBroken) {
      try {
        appendFileSync(this.filePath, JSON.stringify(full) + "\n", "utf8");
      } catch {
        this.writeBroken = true;
      }
    }
    return full;
  }

  /** In-memory records (this process). */
  all(): readonly ModelUsageRecord[] {
    return this.records;
  }

  /** All persisted records from disk plus this process's. Best-effort: a corrupt/missing file yields the memory set. */
  loadAll(): ModelUsageRecord[] {
    if (!this.persist) return [...this.records];
    try {
      const text = readFileSync(this.filePath, "utf8");
      const fromDisk = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as ModelUsageRecord);
      const seen = new Set(fromDisk.map((r) => r.id));
      return [...fromDisk, ...this.records.filter((r) => !seen.has(r.id))];
    } catch {
      return [...this.records];
    }
  }

  /** Aggregate over records, with per-model breakdown. */
  aggregate(records: readonly ModelUsageRecord[] = this.records): UsageAggregate {
    const byModel = new Map<string, UsageAggregate["byModel"][number]>();
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCost = 0;
    let success = 0;
    let errors = 0;
    let unknownOutcomes = 0;
    let tokensUnknown = 0;
    let costUnknown = 0;
    const latencies: number[] = [];

    for (const r of records) {
      totalPrompt += r.promptTokens ?? 0;
      totalCompletion += r.completionTokens ?? 0;
      totalCost += r.costUsd ?? 0;
      if (r.status === "success") success += 1;
      else if (r.status === "error") errors += 1;
      else unknownOutcomes += 1;
      if (r.tokensUnknown) tokensUnknown += 1;
      if (r.costUnknown) costUnknown += 1;
      latencies.push(r.latencyMs);

      const key = `${r.tier}/${r.model}`;
      const row = byModel.get(key) ?? {
        model: r.model,
        tier: r.tier,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        tokensUnknown: 0,
        costUnknown: 0,
      };
      row.calls += 1;
      row.promptTokens += r.promptTokens ?? 0;
      row.completionTokens += r.completionTokens ?? 0;
      row.costUsd += r.costUsd ?? 0;
      row.tokensUnknown += r.tokensUnknown ? 1 : 0;
      row.costUnknown += r.costUnknown ? 1 : 0;
      byModel.set(key, row);
    }

    latencies.sort((a, b) => a - b);
    const p95 =
      latencies.length > 0 ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : 0;
    const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

    return {
      records: records.length,
      success,
      errors,
      unknownOutcomes,
      tokensUnknown,
      costUnknown,
      totalPromptTokens: totalPrompt,
      totalCompletionTokens: totalCompletion,
      totalCostUsd: Math.round(totalCost * 1e6) / 1e6,
      avgLatencyMs: Math.round(avg),
      p95LatencyMs: p95,
      byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
    };
  }
}
