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
import {
  DecisionGateway,
  DecisionUnavailableError,
  SystemOneDecisionGateway,
  type SystemOneClient,
  type SystemOneEnvironment,
} from "../../models/decision/index.js";

export type StatusEmitter = (message: string) => void;

/** Optional ModelStack overrides — currently only the Decision Plane DI seam. */
export interface ModelStackOptions {
  /**
   * Inject a custom {@link DecisionGateway}. When supplied, this is used in
   * place of the auto-built System One gateway. The primary purpose is test
   * injection (FakeDecisionGateway) — production callers should let the
   * stack build its own gateway from the CliConfig.
   *
   * If `cfg.enableDecision` is false, this is ignored — the Decision Plane
   * stays fully disabled. If `cfg.tier` is `cloud`, the injected gateway is
   * honored (because the caller explicitly knows what they're doing — e.g.
   * an integration test against a local fake that ignores the cloud tier).
   */
  decisionGateway?: DecisionGateway;
}

/**
 * Stub {@link SystemOneClient} used by the auto-built gateway until the
 * upstream SDK re-exports `NativeApi.systemOne` (or `OllamaClient.systemOne`)
 * from its public entrypoint. Calling `systemOne` throws a typed
 * {@link DecisionUnavailableError} so the caller's policy can fall back to a
 * deterministic path — never to Provider.chat.
 *
 * Once the upstream export lands, this class is replaced by a one-line
 * adapter that calls `OllamaClient.systemOne(...)` directly. See the Wave 8
 * final report's "Upstream export gap" section.
 */
class PendingSystemOneClient implements SystemOneClient {
  systemOne(_request: Record<string, unknown>): Promise<unknown> {
    return Promise.reject(
      new DecisionUnavailableError(
        "System One SDK adapter is not yet wired — upstream export of NativeApi.systemOne / OllamaClient.systemOne is pending in @nemesis-oss/ollama-sdk. " +
          "Configure a real SystemOneClient via dependency injection or wait for the SDK export to land.",
      ),
    );
  }
}

/**
 * Local-tier environment for the auto-built System One gateway. Reads the
 * Ollama server version lazily via the local Provider (so the gateway
 * construction stays cheap — version probes happen on the first `decide()`
 * call, not at stack construction time).
 */
class LocalSystemOneEnvironment implements SystemOneEnvironment {
  readonly tier = "local" as const;
  private readonly provider: Provider;
  private cached: string | undefined | null = null;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  async getVersion(): Promise<string | undefined> {
    if (this.cached !== null) return this.cached === undefined ? undefined : this.cached;
    try {
      const raw = (await this.provider.availableModels()) as { version?: unknown };
      // Local Ollama's /api/tags does NOT include a version field today;
      // when that changes (or when the SDK exposes /api/version through
      // the Provider), this will start returning a value without code
      // changes here. Until then, "unknown" lets the gateway proceed.
      const v = (raw as { version?: unknown }).version;
      this.cached = typeof v === "string" ? v : undefined;
    } catch {
      // Local Ollama unreachable — let the gateway try anyway and surface
      // the real transport error if the user actually calls decide().
      this.cached = undefined;
    }
    return this.cached === undefined ? undefined : this.cached;
  }
}

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

  /**
   * The Decision Plane gateway, or undefined when the plane is disabled.
   * Disabled by default; enabled via `cfg.enableDecision=true`. Auto-
   * disabled when `cfg.tier === 'cloud'` (System One is local-only). Tests
   * inject a fake via {@link ModelStackOptions.decisionGateway}.
   */
  readonly decisionGateway: DecisionGateway | undefined;
  /**
   * The dedicated decision model, independent of the primary generation
   * `model`. Used by decision consumers (Wave 4+) when they build
   * DecisionRequests that target this model.
   */
  readonly decisionModel: string | undefined;

  private readonly cfg: CliConfig;
  private readonly emitStatus: StatusEmitter;
  private catalogRefreshed: Promise<void> | null = null;
  private catalogRefreshedAt = 0;
  private static readonly CATALOG_TTL_MS = 60_000;

  constructor(cfg: CliConfig, emitStatus: StatusEmitter, opts: ModelStackOptions = {}) {
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

    // ── Decision Plane (System One) ───────────────────────────────────────────
    //
    // System One is local-only by contract (see `contracts/overlays/systemone.yaml`
    // in the upstream SDK). When the runtime tier is `cloud` the stack never
    // builds a gateway — System One must NOT silently route to Provider.chat on
    // the cloud tier. The cloud-tier auto-disable also avoids constructing a
    // PendingSystemOneClient whose only role would be to refuse on first call.
    //
    // When enabled and local, the stack builds a SystemOneDecisionGateway
    // around a PendingSystemOneClient today. Once the upstream SDK re-exports
    // NativeApi.systemOne / OllamaClient.systemOne, the PendingSystemOneClient
    // is replaced with a one-line adapter (see the Wave 8 final report).
    this.decisionModel = cfg.decisionModel;
    if (cfg.enableDecision && cfg.tier === "local") {
      this.decisionGateway =
        opts.decisionGateway ??
        new SystemOneDecisionGateway({
          client: new PendingSystemOneClient(),
          environment: new LocalSystemOneEnvironment(localProvider),
        });
    } else {
      // Disabled by config OR auto-disabled in a cloud tier. An explicit
      // injection still wins ONLY when the plane is enabled — otherwise the
      // caller is asking for both "disabled" and "use this gateway", which is
      // a contradiction; the disabled flag wins and the gateway is dropped.
      this.decisionGateway = cfg.enableDecision ? opts.decisionGateway : undefined;
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
