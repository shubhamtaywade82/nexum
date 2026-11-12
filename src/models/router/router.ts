import {
  ChatMessage,
  ChatResponse,
  ChatOptions,
  ProviderError,
  PaymentRequiredError,
  TransportFailure,
  OutcomeUnknownError,
} from "../adapters/provider.js";
import { Capability, ModelCatalog } from "../catalog.js";
import type { ChatPort } from "../gateway/inference-dispatcher.js";

export interface RouterOptions {
  /** Lane ports: every candidate call goes through one, so it is dispatched and admitted. */
  local: ChatPort;
  cloud?: ChatPort;
  catalog: ModelCatalog;
  logger?: Pick<Console, "warn">;
}

/**
 * A cloud failure that may have run the request. A TypeError from a cloud provider counts too: it surfaces
 * after the request left, so it cannot prove the request did not execute. Local failures are never unknown.
 */
function asOutcomeUnknown(e: unknown, tier: "local" | "cloud"): OutcomeUnknownError | undefined {
  if (e instanceof OutcomeUnknownError) return e;
  if (tier === "cloud" && e instanceof TypeError) {
    return new OutcomeUnknownError(`cloud call failed after dispatch: ${e.message}`, e);
  }
  return undefined;
}

export class Router {
  private readonly local: ChatPort;
  private readonly cloud?: ChatPort;
  private readonly catalog: ModelCatalog;
  private readonly logger: Pick<Console, "warn">;

  constructor(opts: RouterOptions) {
    this.local = opts.local;
    this.cloud = opts.cloud;
    this.catalog = opts.catalog;
    this.logger = opts.logger ?? console;
  }

  async route(capability: Capability, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    let candidates = this.catalog.modelsFor(capability);

    // "quick" exists to route latency-sensitive turns to an always-resident local
    // model (e.g. a small finetune kept warm for intent classification/tool routing/
    // summarization). That's a local-latency optimization, not a capability cloud
    // models need to carry too — once nothing local can serve it (not installed,
    // Ollama unreachable), require the routed capability to also be tagged "quick"
    // on cloud candidates would just as easily leave zero candidates. Fall back to
    // any available cloud model instead, so a missing/unreachable local quick model
    // degrades to cloud rather than failing the turn.
    if (capability === "quick" && !candidates.some((c) => c.tier === "local") && this.cloud) {
      const cloudCandidates = this.catalog.all().filter((c) => c.tier === "cloud");
      if (cloudCandidates.length > 0) candidates = cloudCandidates;
    }

    // A candidate tagged for the routed capability (e.g. "quick" by size, or
    // "reasoning" by name) is not necessarily tool-capable — routing solely
    // on the content-classified capability while ignoring whether this turn
    // actually sends tool schemas sends real requests to models that reject
    // them outright (e.g. Ollama 400 "does not support tools"), with no
    // fallback to a model that does. Require "tools" too whenever this turn needs it.
    // Gated on candidates already being non-empty: if the capability itself has no
    // candidate at all (e.g. no vision model installed), don't invent a substitute
    // from an unrelated capability just because it happens to support tools — throw
    // below instead and let the caller's own fallback (e.g. the primary model) handle it.
    if (candidates.length > 0 && opts?.tools && opts.tools.length > 0) {
      const toolCapable = candidates.filter((c) => c.capabilities.includes("tools"));
      // If nothing tagged for the routed capability also supports tools,
      // widen to any tool-capable model in the catalog rather than handing
      // the request to a model guaranteed to reject it.
      candidates = toolCapable.length > 0 ? toolCapable : this.catalog.modelsFor("tools");
    }
    if (candidates.length === 0) {
      throw new Error(`no model available for capability "${capability}"`);
    }

    let lastError: unknown;
    // Set once a cloud request may have run. Every later cloud candidate would bill the same request again, so the
    // loop skips them. Local candidates bill nothing and stay eligible.
    let cloudOutcomeUnknown: OutcomeUnknownError | undefined;
    for (const candidate of candidates) {
      const port = candidate.tier === "local" ? this.local : this.cloud;
      if (!port) continue;
      if (candidate.tier === "cloud" && cloudOutcomeUnknown) continue;

      // Per-request model, not provider.setModel(): mutating shared instance
      // state before an await meant two concurrent routes (e.g. the
      // fire-and-forget summarization alongside the next turn, or parallel
      // plan steps) clobbered each other's model mid-flight, and the
      // routedModel stamped below named a model that never served the request.
      try {
        const response = await port.chat(messages, { ...opts, model: candidate.name });
        response.routedTier = candidate.tier;
        response.routedModel = candidate.name;
        return response;
      } catch (e) {
        lastError = e;
        const unknown = asOutcomeUnknown(e, candidate.tier);
        if (unknown) {
          cloudOutcomeUnknown = unknown;
          this.logger.warn(`[Router] cloud/${candidate.name} may have run — no further cloud candidates`);
          continue;
        }
        if (!this.isRecoverable(e)) throw e;
        this.logger.warn(
          `[Router] ${(e as Error).constructor.name} on ${candidate.tier}/${candidate.name} — trying next candidate`,
        );
      }
    }

    // Candidates ran out after a paid request may have executed: report that, not a later local failure.
    if (cloudOutcomeUnknown) throw cloudOutcomeUnknown;
    throw lastError ?? new Error(`no reachable provider for capability "${capability}"`);
  }

  private isRecoverable(e: unknown): boolean {
    // Covers RateLimitError and TimeoutError, and network-level failures (refused, reset, DNS)
    // that the SDK surfaces as OllamaNetworkError. A cloud timeout or reset never reaches here:
    // it is OutcomeUnknownError, handled in route() before this check.
    if (e instanceof TransportFailure) return true;
    if (e instanceof TypeError) return true;
    // Billing gate on this candidate (plan or credits), not on the account
    // as a whole — another candidate may be on-plan.
    if (e instanceof PaymentRequiredError) return true;
    // The catalog's capability filter should already exclude these, but if a
    // model still gets picked that rejects tool schemas outright, that's a
    // wrong-candidate problem, not a fatal one — try the next candidate.
    if (e instanceof ProviderError && /does not support tools/i.test(e.message)) return true;
    // Same reasoning for a candidate gated behind a paid subscription tier —
    // ModelAvailabilityChecker should ideally have filtered it out already,
    // but if it slips through, don't fail the whole turn over it.
    if (e instanceof ProviderError && /subscription/i.test(e.message)) return true;
    if (e instanceof ProviderError && /exceed.*context/i.test(e.message)) return true;
    return false;
  }
}
