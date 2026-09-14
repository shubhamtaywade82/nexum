import {
  Provider,
  ChatMessage,
  ChatResponse,
  ChatOptions,
  ProviderError,
  RateLimitError,
  TimeoutError,
} from "../adapters/provider.js";
import { Capability, ModelCatalog } from "../catalog.js";

export interface RouterOptions {
  local: Provider;
  cloud?: Provider;
  catalog: ModelCatalog;
  logger?: Pick<Console, "warn">;
}

export class Router {
  private readonly local: Provider;
  private readonly cloud?: Provider;
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
    for (const candidate of candidates) {
      const provider = candidate.tier === "local" ? this.local : this.cloud;
      if (!provider) continue;

      // Per-request model, not provider.setModel(): mutating shared instance
      // state before an await meant two concurrent routes (e.g. the
      // fire-and-forget summarization alongside the next turn, or parallel
      // plan steps) clobbered each other's model mid-flight, and the
      // routedModel stamped below named a model that never served the request.
      try {
        const response = await provider.chat(messages, { ...opts, model: candidate.name });
        response.routedTier = candidate.tier;
        response.routedModel = candidate.name;
        return response;
      } catch (e) {
        lastError = e;
        if (!this.isRecoverable(e)) throw e;
        this.logger.warn(
          `[Router] ${(e as Error).constructor.name} on ${candidate.tier}/${candidate.name} — trying next candidate`,
        );
      }
    }

    throw lastError ?? new Error(`no reachable provider for capability "${capability}"`);
  }

  private isRecoverable(e: unknown): boolean {
    if (e instanceof RateLimitError) return true;
    if (e instanceof TimeoutError) return true;
    if (e instanceof TypeError) return true;
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
