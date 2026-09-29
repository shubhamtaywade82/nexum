/**
 * ModelStack service (review item 1) — the model plane composition the
 * Agent god class used to own inline.
 *
 * Owns: providers (primary/local/cloud/quick), the capability catalog
 * (TTL-cached refresh + kernel profile sync), the routing failover
 * (routeWithFallback), the hybrid local-cloud components (heuristic gate,
 * availability checker, key manager, local worker, verifier,
 * self-consistency), and model management operations (setModel/setTier/
 * listModels/validateModel/modelCapabilities/modelAvailability).
 *
 * The Agent composes this service; it no longer builds the stack itself.
 */

import { CliConfig, saveWorkspaceConfig } from "../config.js";
import { Provider, ChatMessage, ChatOptions, ChatResponse } from "../../models/adapters/provider.js";
import { ModelCatalog, Capability, inferCapabilities } from "../../models/catalog.js";
import { Router } from "../../models/router/router.js";
import { ModelAvailabilityChecker } from "../../models/router/availability.js";
import { KeyManager } from "../../models/router/key-manager.js";
import { HeuristicRouter } from "../../models/router/heuristic-router.js";
import { LocalWorker } from "../../models/local-worker.js";
import { Verifier } from "../../models/verification/verifier.js";
import { SelfConsistency } from "../../models/verification/self-consistency.js";
import { ModelCapabilityRegistry } from "../../models/profiles/model-capability-registry.js";

export type StatusEmitter = (message: string) => void;

export class ModelStack {
  readonly provider: Provider;
  readonly catalog: ModelCatalog;
  readonly router: Router;
  readonly modelProfiles = new ModelCapabilityRegistry();

  readonly heuristicRouter: HeuristicRouter | undefined;
  readonly localWorker: LocalWorker | undefined;
  readonly verifier: Verifier | undefined;
  readonly selfConsistency: SelfConsistency | undefined;
  readonly availabilityChecker: ModelAvailabilityChecker | undefined;
  readonly keyManager: KeyManager | undefined;

  private readonly cfg: CliConfig;
  private readonly emitStatus: StatusEmitter;
  private catalogRefreshed: Promise<void> | null = null;
  private catalogRefreshedAt = 0;
  private static readonly CATALOG_TTL_MS = 60_000;

  constructor(cfg: CliConfig, emitStatus: StatusEmitter) {
    this.cfg = cfg;
    this.emitStatus = emitStatus;

    // Hybrid local-cloud components first — the KeyManager feeds the cloud
    // Provider's per-request key selection below. Only worth attaching with a
    // real pool (2+ keys): with a single key there is nothing to bind or
    // queue and the selector only adds availability-probe latency. The
    // acquire timeout is tightened from the KeyManager's 30s default so a
    // fully-saturated pool degrades to the plain endpoint pool (and SDK
    // failover) instead of stalling an interactive turn for half a minute.
    this.availabilityChecker =
      cfg.enableAvailabilityCheck && cfg.apiKeys?.length
        ? new ModelAvailabilityChecker(cfg.apiKeys, { ttlMs: cfg.availabilityCheckTtlMs })
        : undefined;
    this.keyManager =
      this.availabilityChecker && cfg.apiKeys?.length
        ? new KeyManager(cfg.apiKeys, this.availabilityChecker, { acquireTimeoutMs: 5_000 })
        : undefined;
    const keySelector = cfg.apiKeys && cfg.apiKeys.length > 1 ? this.keyManager : undefined;

    this.provider = new Provider({
      tier: cfg.tier,
      model: cfg.model,
      host: cfg.host,
      apiKey: cfg.apiKey,
      apiKeys: cfg.apiKeys,
      keySelector,
      ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
    });

    // Separate provider pool for capability-routed delegation, kept
    // independent of the primary provider so the conversation's model/tier
    // is never mutated. Cloud provider is omitted without an API key.
    const localProvider = new Provider({
      tier: "local",
      model: cfg.model,
      host: cfg.tier === "local" ? cfg.host : undefined,
      apiKeys: cfg.apiKeys,
      ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
    });
    const cloudProvider = cfg.apiKey
      ? new Provider({
          tier: "cloud",
          model: cfg.model,
          host: cfg.tier === "cloud" ? cfg.host : undefined,
          apiKey: cfg.apiKey,
          apiKeys: cfg.apiKeys,
          keySelector,
          ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
        })
      : undefined;

    this.catalog = new ModelCatalog(localProvider, cloudProvider, cfg.quickModel);
    this.router = new Router({
      local: localProvider,
      cloud: cloudProvider,
      catalog: this.catalog,
      logger: { warn: (msg: string) => this.emitStatus(msg) },
    });

    this.heuristicRouter = cfg.enableHeuristicGate ? new HeuristicRouter() : undefined;

    const quickLocalProvider = cfg.quickModel
      ? new Provider({
          tier: "local",
          model: cfg.quickModel,
          host: cfg.tier === "local" ? cfg.host : undefined,
        })
      : localProvider;
    this.localWorker = cfg.enableLocalWorker ? new LocalWorker(quickLocalProvider) : undefined;
    this.verifier = cfg.enableVerifier && this.localWorker ? new Verifier(quickLocalProvider) : undefined;
    this.selfConsistency = cfg.enableSelfConsistency
      ? new SelfConsistency(quickLocalProvider, {
          n: cfg.selfConsistencyN,
          threshold: cfg.selfConsistencyThreshold,
        })
      : undefined;

    if (this.availabilityChecker) {
      this.availabilityChecker
        .refreshAll()
        .catch((e: Error) => this.emitStatus(`[Availability] refresh error: ${e.message}`));
    }
  }

  // ── catalog lifecycle ──────────────────────────────────────────────────

  /** TTL-cached catalog refresh; concurrent callers share one refresh. */
  ensureCatalog(): Promise<void> {
    const usable = this.catalog.all().length > 0;
    const fresh = Date.now() - this.catalogRefreshedAt < ModelStack.CATALOG_TTL_MS;
    if (usable && fresh) return Promise.resolve();
    if (this.catalogRefreshed) return this.catalogRefreshed;

    this.catalogRefreshed = this.catalog
      .refresh()
      .then(() => {
        this.catalogRefreshedAt = Date.now();
        // keep the runtime's capability registry in lockstep with the catalog
        this.modelProfiles.syncFromLegacy(this.catalog.all());
      })
      .finally(() => {
        this.catalogRefreshed = null;
      });
    return this.catalogRefreshed;
  }

  /** Capability routing with primary-model fallback (never breaks a turn). */
  async routeWithFallback(capability: Capability, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    await this.ensureCatalog();
    try {
      return await this.router.route(capability, messages, opts);
    } catch {
      return this.provider.chat(messages, opts);
    }
  }

  // ── model management ───────────────────────────────────────────────────

  setModel(model: string): void {
    this.provider.setModel(model);
    saveWorkspaceConfig(this.cfg.workspaceRoot, { model });
  }

  setTier(tier: "local" | "cloud"): void {
    this.provider.setTier(tier);
    saveWorkspaceConfig(this.cfg.workspaceRoot, { tier });
  }

  setRuntimeHost(host: string): void {
    this.provider.setRuntimeHost(host);
  }

  get currentModel(): string {
    return this.provider.currentModel;
  }

  get currentTier(): string {
    return this.provider.currentTier;
  }

  async listModels(): Promise<string[]> {
    const data = await this.provider.availableModels();
    if (this.provider.currentTier === "cloud") {
      const cloud = data as { data?: Array<{ id: string }> };
      return (cloud.data ?? []).map((m) => m.id);
    }
    const local = data as { models?: Array<{ name: string }> };
    return (local.models ?? []).map((m) => m.name);
  }

  async validateModel(): Promise<true | string> {
    try {
      await this.provider.chat([{ role: "user", content: "respond with just a single dot" }], { stream: false });
      return true;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("403") && msg.includes("subscription")) {
        return "requires a subscription — upgrade at https://ollama.com/upgrade";
      }
      return `unreachable: ${msg}`;
    }
  }

  modelAvailability(models: string[]): Record<string, boolean> {
    if (!this.availabilityChecker) return {};
    const out: Record<string, boolean> = {};
    for (const m of models) {
      const status = this.availabilityChecker.cachedStatusAnyKey(m);
      if (status) out[m] = status.available;
    }
    return out;
  }

  async modelCapabilities(models: string[]): Promise<Record<string, Capability[]>> {
    await this.ensureCatalog();
    const byName = new Map(this.catalog.all().map((m) => [m.name, m.capabilities]));
    const out: Record<string, Capability[]> = {};
    for (const m of models) out[m] = byName.get(m) ?? inferCapabilities(m);
    return out;
  }
}
