import {
  OllamaClient,
  OllamaClientError,
  OllamaRateLimitError,
  OllamaTimeoutError,
  type Message as SdkMessage,
  type ChatResponse as SdkChatResponse,
  type VisionInput,
  type ResponsesCreateRequest,
  type ResponsesCreateResponse,
  type ResponsesStreamEvent,
  type ConversationSession,
  type CreateRequestOptions,
  type UsageRequestOptions,
  type UsageResponse,
  type BalanceRequestOptions,
  type BalanceResponse,
  type ProgressResponse,
} from "@nemesis-oss/ollama-sdk";
import {
  AgentRuntimeError,
  TransportFailure,
  RateLimitError,
  ProviderError,
  TimeoutError,
  InferenceQualityError,
  ToolFailure,
  BudgetExhaustedError,
  ConcurrencyDeniedError,
} from "../errors.js";

export {
  AgentRuntimeError,
  TransportFailure,
  RateLimitError,
  ProviderError,
  TimeoutError,
  InferenceQualityError,
  ToolFailure,
  BudgetExhaustedError,
  ConcurrencyDeniedError,
};

const MAX_ERROR_BODY_CHARS = 500;

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{6,}/g, "[REDACTED]")
    .slice(0, MAX_ERROR_BODY_CHARS);
}

export type Tier = "local" | "cloud";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  /** Vision payload for this message. The SDK resolves each entry (data URI,
   * http(s) URL, image file path) to base64 before it reaches the wire, so
   * callers can hand over the raw source instead of pre-encoding it. */
  images?: VisionInput[];
}

export interface OllamaToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResponse {
  message: { role: string; content: string; tool_calls?: unknown[]; thinking?: string };
  done: boolean;
  /** Which tier/model actually served this response — stamped by Router.route,
   * since its candidate list can silently widen past whatever capability was
   * requested (e.g. "quick" resolving to a cloud model when no local model
   * reports tool support). Absent for calls made directly via Provider.chat
   * with no Router involved. */
  routedTier?: Tier;
  routedModel?: string;
  [key: string]: unknown;
}

export interface ChatOptions {
  tools?: OllamaToolSchema[];
  stream?: boolean;
  onChunk?: (chunk: ChatResponse) => void;
  /** Model for this request only, leaving the provider's configured model
   * untouched. Router uses this to try candidates: it previously called
   * setModel() before awaiting chat(), so two concurrent routes through the
   * same Provider instance raced — the second overwrote the first's model
   * mid-flight, and both requests went to whichever model was set last while
   * `routedModel` reported the wrong one. */
  model?: string;
  options?: Record<string, unknown>;
  /** Effective context window for this request (`options.num_ctx`). Sized from
   * the model's context budget by the agent, so the window on the wire matches
   * the budget the transcript was pruned/compacted against — without it Ollama
   * silently truncates to its server default (2048–4096) with no error. Takes
   * precedence over `options.num_ctx`. */
  contextLength?: number;
}

/** A Responses request whose `model` defaults to the provider's configured one. */
export type ResponsesRequest = Omit<ResponsesCreateRequest, "model"> & { model?: string };

/** One pooled Ollama Cloud key's usage. Exactly one of `usage`/`error` is set. */
export interface AccountUsage {
  label: string;
  usage?: UsageResponse;
  error?: string;
}

/** One pooled Ollama Cloud key's credits. Exactly one of `balance`/`error`. */
export interface AccountBalance {
  label: string;
  balance?: BalanceResponse;
  error?: string;
}

/** Fallback row name when the config gave an account no label: identifies the
 * key by position and last 4 chars, enough to tell accounts apart by eye
 * without printing the secret. */
function maskedKeyLabel(apiKey: string, index: number): string {
  return `Key ${index + 1} (${apiKey.length > 4 ? "…" + apiKey.slice(-4) : "••••"})`;
}

export interface ProviderOptions {
  tier: Tier;
  model: string;
  host?: string;
  apiKey?: string;
  /** Pool of Ollama Cloud API keys (e.g. separate accounts). On a 429 the
   * SDK's endpoint failover rotates to the next key and retries before
   * giving up — this is for availability across your own accounts, not
   * multi-vendor routing. */
  apiKeys?: string[];
  /** apiKey → display name for /usage and /balance rows (from the config
   * file's structured `accounts`). Unlabelled keys fall back to a masked
   * suffix of the key. */
  accountLabels?: Record<string, string>;
  timeoutMs?: number;
  /** Chooses which cloud API key serves each request (e.g. KeyManager's
   * model→key binding that keeps each key's model warm in Ollama Cloud
   * VRAM). Structural interface — any `{ acquire, release }` works, no
   * import from the router layer needed. When unset (or when acquire
   * fails/times out), the plain priority-ordered endpoint pool is used.
   * The SDK's 429 failover across the remaining keys stays active either
   * way, as a last-resort safety net. */
  keySelector?: CloudKeySelector;
  /** Client-wide `num_ctx` applied to any request that omits one. Defaults to
   * DEFAULT_CONTEXT_LENGTH on the local tier (the value chat() used to hardcode)
   * and to nothing on cloud, where window sizing is left to the caller. */
  contextLength?: number;
  /** Pre-flight response to an estimated prompt that exceeds the window:
   * "warn" logs and sends anyway (SDK default), "throw" rejects client-side
   * with `code: 'context_overflow'` before anything hits the wire. */
  onContextOverflow?: "warn" | "throw";
}

/** See ProviderOptions.keySelector. `acquire` must resolve with the API key
 * to prefer for `model` (or throw); `release` is called exactly once per
 * successful acquire, after the request finishes (success or failure). */
export interface CloudKeySelector {
  acquire(model: string): Promise<string>;
  release(apiKey: string): void;
}

export const DEFAULT_CLOUD_HOST = "https://ollama.com";
export const DEFAULT_LOCAL_HOST = "http://localhost:11434";
/** Window used when neither the request nor ProviderOptions sizes one — the
 * value chat() previously hardcoded as `num_ctx` for local requests. */
export const DEFAULT_CONTEXT_LENGTH = 16_384;

/** The endpoint a tier talks to when nothing is explicitly configured.
 * OLLAMA_HOST is a local-Ollama convention, so it must never be picked up as
 * a cloud host — pointing Cloud traffic (with a Bearer token attached) at
 * someone's localhost is both broken and a credential leak. */
export function defaultHostForTier(tier: Tier): string {
  return tier === "cloud" ? DEFAULT_CLOUD_HOST : (process.env.OLLAMA_HOST ?? DEFAULT_LOCAL_HOST);
}

// Maps an SDK error onto this module's error hierarchy so existing
// `instanceof RateLimitError/TimeoutError/ProviderError` checks (e.g. in
// router.ts) keep working unchanged, and upstream body text (e.g.
// "does not support tools", "subscription") survives intact for those checks.
function mapSdkError(err: unknown, tier: Tier, model: string, cloudKeyCount: number): Error {
  if (err instanceof OllamaRateLimitError) {
    return tier === "cloud"
      ? new RateLimitError(`${model} (${tier}) rate limited on all ${cloudKeyCount} key(s)`)
      : new RateLimitError(`${model} (${tier}) rate limited: ${err.message}`);
  }
  if (err instanceof OllamaTimeoutError) {
    return new TimeoutError(err.message);
  }
  if (err instanceof OllamaClientError) {
    // The SDK's `.message` collapses a non-JSON (or non-`{error}`-shaped)
    // upstream body down to a generic "HTTP <status> <statusText>" string —
    // `.response.body` still has the raw text/JSON, which is what needs
    // redacting and surfacing to callers like router.ts.
    const body = err.response?.body;
    const bodyText = typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : err.message;
    return new ProviderError(`Ollama ${tier} ${err.status ?? ""}: ${redactSecrets(bodyText)}`);
  }
  return err instanceof Error ? err : new ProviderError(String(err));
}

// `finalResult.raw` is the last raw NDJSON chunk (carries eval_count/
// prompt_eval_count/eval_duration, which callers like agent.ts read off
// ChatResponse directly); `finalResult.message` is the SDK's own
// content/thinking/tool_calls accumulation across the whole stream.
function toChatResponse(final: { raw?: SdkChatResponse; message: SdkMessage; done: boolean }): ChatResponse {
  return {
    ...(final.raw as SdkChatResponse),
    message: {
      role: final.message.role,
      content: final.message.content,
      ...(final.message.tool_calls?.length ? { tool_calls: final.message.tool_calls } : {}),
      ...(final.message.thinking ? { thinking: final.message.thinking } : {}),
    },
    done: final.done,
  } as ChatResponse;
}

export class Provider {
  private tier: Tier;
  private model: string;
  /** Explicitly configured host, or undefined to track the tier default. */
  private hostOverride: string | undefined;
  private readonly apiKeys: string[];
  private readonly accountLabels: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly keySelector: CloudKeySelector | undefined;
  private readonly contextLength: number | undefined;
  private readonly onContextOverflow: "warn" | "throw" | undefined;
  // Cached per (tier, host): reused across calls so the SDK's endpoint
  // circuit breaker remembers which cloud key last failed instead of
  // re-trying the same rate-limited key on every call.
  private client: OllamaClient | null = null;
  private clientCacheKey = "";
  // Same caching rationale as `client`, but one client per preferred key
  // (see buildKeyedClient): the preferred key is pinned as the highest-
  // priority endpoint so its circuit-breaker state persists across calls.
  private readonly keyedClients = new Map<string, OllamaClient>();
  private keyedClientsCacheKey = "";

  constructor(opts: ProviderOptions) {
    this.tier = opts.tier;
    this.model = opts.model;
    this.hostOverride = opts.host;
    this.apiKeys = opts.apiKeys && opts.apiKeys.length > 0 ? opts.apiKeys : opts.apiKey ? [opts.apiKey] : [];
    this.accountLabels = opts.accountLabels ?? {};
    // Cloud has a 60s connect timeout; local has no timeout — never kill a running generation.
    this.timeoutMs = opts.timeoutMs ?? (opts.tier === "cloud" ? 60_000 : 0);
    this.keySelector = opts.keySelector;
    this.contextLength = opts.contextLength;
    this.onContextOverflow = opts.onContextOverflow;
  }

  /** Context-safety config merged into every client this provider builds.
   * `defaultContextLength` is what makes the window explicit on the wire AND
   * what the SDK's pre-flight estimate is checked against, so both go together. */
  private get contextConfig(): { defaultContextLength?: number; onContextOverflow?: "warn" | "throw" } {
    const length = this.contextLength ?? (this.tier === "local" ? DEFAULT_CONTEXT_LENGTH : undefined);
    return {
      ...(length !== undefined ? { defaultContextLength: length } : {}),
      ...(this.onContextOverflow !== undefined ? { onContextOverflow: this.onContextOverflow } : {}),
    };
  }

  private get host(): string {
    return this.hostOverride ?? defaultHostForTier(this.tier);
  }

  get currentModel(): string {
    return this.model;
  }

  get currentTier(): Tier {
    return this.tier;
  }

  setModel(model: string): void {
    this.model = model;
  }

  /** Switching tier re-derives the host unless one was explicitly configured.
   * The host used to be resolved once in the constructor, so setTier("cloud")
   * on a local-built Provider kept talking to localhost:11434 while attaching
   * a cloud Bearer token to every request. */
  setTier(tier: Tier): void {
    this.tier = tier;
  }

  setRuntimeHost(host: string): void {
    this.hostOverride = host;
  }

  get currentHost(): string {
    return this.host;
  }

  private buildClient(): OllamaClient {
    const cacheKey = `${this.tier}|${this.host}`;
    if (this.client && this.clientCacheKey === cacheKey) return this.client;

    if (this.tier === "cloud") {
      if (this.apiKeys.length === 0) throw new ProviderError("missing apiKey for cloud chat");
      // One endpoint per key, same host, descending priority — the SDK fails
      // over to the next key on a 429 (rate_limited is in its default
      // failover code list) instead of the old manual round-robin.
      // failureThreshold: 1 so a single 429 immediately knocks a key out of
      // rotation for the cooldown window, rather than the default-3-strikes
      // circuit breaker still preferring it on the next call.
      this.client = new OllamaClient({
        endpoints: this.apiKeys.map((apiKey, i) => ({
          name: `cloud-${i}`,
          baseUrl: this.host,
          apiKey,
          priority: this.apiKeys.length - i,
        })),
        endpointHealth: { failureThreshold: 1 },
        // No same-endpoint retry — a failed key should fail over to the next
        // one immediately, not retry itself a few times first (old behavior
        // had no retry loop either).
        retries: 0,
        timeoutMs: this.timeoutMs,
        ...this.contextConfig,
      });
    } else {
      this.client = new OllamaClient({
        baseUrl: this.host,
        timeoutMs: this.timeoutMs,
        retries: 0,
        ...this.contextConfig,
      });
    }
    this.clientCacheKey = cacheKey;
    return this.client;
  }

  /**
   * Public accessor for the cached {@link OllamaClient}. Used by the Decision
   * Plane adapter ({@link OllamaSystemOneClient}) to reach the SDK's public
   * `runtime.invoke` for the System One operation, and by
   * {@link LocalSystemOneEnvironment} to probe the local Ollama server's
   * version via the SDK's `version` operation. The returned client is the
   * same instance used by {@link chat} — its endpoint circuit-breaker state
   * persists across calls. Returns a fresh client (and re-caches it) if the
   * tier/host has changed since the last call.
   */
  getOllamaClient(): OllamaClient {
    return this.buildClient();
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    if (this.tier === "cloud" && this.apiKeys.length === 0) {
      throw new ProviderError("missing apiKey for cloud chat");
    }

    const model = opts.model ?? this.model;
    // Best-effort key selection: acquire may wait for a busy bound key or
    // probe availability, and may legitimately fail (all keys busy, probe
    // timeouts). Any failure falls back to the plain endpoint pool — key
    // preference is an optimization (VRAM warmth), never a correctness
    // requirement, and the SDK's cross-key failover applies either way.
    const preferredKey = this.tier === "cloud" ? await this.acquirePreferredKey(model) : undefined;
    try {
      const client = preferredKey ? this.buildKeyedClient(preferredKey) : this.buildClient();
      // Window precedence: this call's `contextLength` > `options.num_ctx` >
      // the client-wide default. A request with no `options` at all still gets
      // a window — the SDK injects `defaultContextLength` itself.
      const options = {
        ...(opts.options ?? {}),
        ...(opts.contextLength !== undefined ? { num_ctx: opts.contextLength } : {}),
      };
      const request = {
        model,
        messages: messages as unknown as SdkMessage[],
        tools: opts.tools as any,
        ...(Object.keys(options).length > 0 ? { options } : {}),
      };

      try {
        if (opts.stream) {
          const stream = await client.chat({ ...request, stream: true });
          stream.on("message", (e) => opts.onChunk?.(e.data.chunk as unknown as ChatResponse));
          return toChatResponse(await stream.finalResult);
        }
        const resp = await client.chat({ ...request, stream: false });
        return resp as unknown as ChatResponse;
      } catch (err) {
        throw mapSdkError(err, this.tier, model, this.apiKeys.length);
      }
    } finally {
      if (preferredKey) this.keySelector?.release(preferredKey);
    }
  }

  /** Resolves the preferred key for `model`, or undefined when no selector is
   * configured or it fails. Never lets a selection failure break a request. */
  private async acquirePreferredKey(model: string): Promise<string | undefined> {
    if (!this.keySelector) return undefined;
    try {
      return await this.keySelector.acquire(model);
    } catch {
      return undefined;
    }
  }

  /** Like buildClient, but with `preferredKey` pinned as the highest-priority
   * endpoint — the other pool keys remain as failover endpoints below it, so
   * the KeyManager's model→key warmth binding and the SDK's 429 rotation
   * compose instead of replacing each other. */
  private buildKeyedClient(preferredKey: string): OllamaClient {
    const cacheKey = `${this.tier}|${this.host}`;
    if (this.keyedClientsCacheKey !== cacheKey) {
      this.keyedClients.clear();
      this.keyedClientsCacheKey = cacheKey;
    }
    const cached = this.keyedClients.get(preferredKey);
    if (cached) return cached;

    const rest = this.apiKeys.filter((k) => k !== preferredKey);
    const client = new OllamaClient({
      endpoints: [
        { name: "cloud-preferred", baseUrl: this.host, apiKey: preferredKey, priority: this.apiKeys.length + 1 },
        ...rest.map((apiKey, i) => ({
          name: `cloud-${i}`,
          baseUrl: this.host,
          apiKey,
          priority: rest.length - i,
        })),
      ],
      endpointHealth: { failureThreshold: 1 },
      retries: 0,
      timeoutMs: this.timeoutMs,
      ...this.contextConfig,
    });
    this.keyedClients.set(preferredKey, client);
    return client;
  }

  async availableModels(): Promise<unknown> {
    const client = this.buildClient();
    try {
      // Local: raw /api/tags shape is `{ models: [...] }`; cloud: OpenAI-style
      // `{ data: [...] }` from /v1/models — callers (catalog.ts) expect these
      // exact envelopes.
      if (this.tier === "cloud") {
        if (this.apiKeys.length === 0) throw new ProviderError("missing apiKey for cloud availableModels");
        return await client.openai.listModels();
      }
      return { models: await client.listModels() };
    } catch (err) {
      throw mapSdkError(err, this.tier, this.model, this.apiKeys.length);
    }
  }

  /** Queries local /api/show for accurate capabilities missed by /api/tags. */
  async showModel(model: string): Promise<{ capabilities?: string[] } | null> {
    if (this.tier !== "local") return null;
    const client = this.buildClient();
    try {
      const info = await client.modelsClient.show({ model });
      return { capabilities: info.capabilities as string[] | undefined };
    } catch {
      return null;
    }
  }

  // ── non-chat Ollama surfaces (ollama-sdk 1.9) ────────────────────────────
  //
  // Each one runs through mapSdkError so callers keep seeing nexum's
  // RateLimitError/TimeoutError/ProviderError instead of raw SDK classes.

  /** OpenAI Responses bridge: prefers `POST /v1/responses` and transparently
   * re-issues through `/api/chat` when the server answers 404 (pre-0.13.3). */
  async responses(req: ResponsesRequest): Promise<ResponsesCreateResponse> {
    const model = req.model ?? this.model;
    return this.mapErrors(() => this.buildClient().responses.create({ ...req, model }), model);
  }

  /** {@link responses} reduced to its `output_text`. */
  async responsesText(req: ResponsesRequest): Promise<string> {
    const model = req.model ?? this.model;
    return this.mapErrors(() => this.buildClient().responses.createText({ ...req, model }), model);
  }

  /** Lazy async generator of `{ text_delta | thinking_delta | done }` events.
   * Falls back to the `/api/chat` token stream only on establishment failure —
   * never mid-stream, which would duplicate already-consumed deltas. */
  async *responsesStream(req: ResponsesRequest): AsyncGenerator<ResponsesStreamEvent, void, void> {
    const model = req.model ?? this.model;
    const stream = this.buildClient().responses.stream({ ...req, model });
    try {
      yield* stream;
    } catch (err) {
      throw mapSdkError(err, this.tier, model, this.apiKeys.length);
    }
  }

  /** KV-cache-preserving multi-turn session: append-only history with the
   * system prompt pinned at construction (mutating the prefix is what throws
   * away Ollama's prompt-prefix cache). Defaults to the configured model. */
  session(model?: string, systemPrompt?: string): ConversationSession {
    return this.buildClient().session(model ?? this.model, systemPrompt);
  }

  /** Publishes local GGUF shards as an Ollama model: blobs are uploaded first
   * (skipped when already present), then `POST /api/create` references them. */
  async importGguf(
    model: string,
    gguf: string | readonly string[],
    opts?: Omit<CreateRequestOptions, "model" | "files" | "from" | "stream">,
  ): Promise<ProgressResponse> {
    if (this.tier !== "local") throw new ProviderError("importGguf requires the local tier");
    return this.mapErrors(() => this.buildClient().modelsClient.createModelFromGguf(model, gguf, opts), model);
  }

  /** Ollama Cloud request counts/spend (`GET ollama.com/api/usage`) for **every**
   * key in the pool — one row per account, so several accounts for availability
   * each get their own numbers. Always a cloud-host call regardless of this
   * provider's host, so each key needs its own client: an endpoint-pool client
   * carries its key under `endpoints[]`, which the SDK's fixed-cloud-host
   * pipeline does not read. Never rejects — a dead account reports its error
   * inline rather than hiding the healthy ones. */
  usageAll(req?: UsageRequestOptions): Promise<AccountUsage[]> {
    return Promise.all(
      this.accountKeys().map(async (apiKey, index) => {
        const label = this.accountLabels[apiKey] ?? maskedKeyLabel(apiKey, index);
        try {
          return { label, usage: await this.accountClient(apiKey).usage(req) };
        } catch (err) {
          return { label, error: this.accountError(err) };
        }
      }),
    );
  }

  /** Ollama Cloud remaining credits (`GET ollama.com/api/balance`) per key. */
  balanceAll(req?: BalanceRequestOptions): Promise<AccountBalance[]> {
    return Promise.all(
      this.accountKeys().map(async (apiKey, index) => {
        const label = this.accountLabels[apiKey] ?? maskedKeyLabel(apiKey, index);
        try {
          return { label, balance: await this.accountClient(apiKey).balance(req) };
        } catch (err) {
          return { label, error: this.accountError(err) };
        }
      }),
    );
  }

  /** Deduped key pool: the same key twice is one account, not two. */
  private accountKeys(): string[] {
    return [...new Set(this.apiKeys)];
  }

  private accountClient(apiKey: string): OllamaClient {
    return new OllamaClient({
      baseUrl: DEFAULT_CLOUD_HOST,
      apiKey,
      timeoutMs: this.timeoutMs || 30_000,
      retries: 1,
    });
  }

  /** Routes an account failure through the shared mapper so its message is
   * redacted (these bodies carry the Authorization header we just sent). */
  private accountError(err: unknown): string {
    return mapSdkError(err, this.tier, this.model, this.apiKeys.length).message;
  }

  private async mapErrors<T>(fn: () => Promise<T>, model: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapSdkError(err, this.tier, model, this.apiKeys.length);
    }
  }
}
