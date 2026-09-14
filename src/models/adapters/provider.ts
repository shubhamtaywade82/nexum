import {
  OllamaClient,
  OllamaClientError,
  OllamaRateLimitError,
  OllamaTimeoutError,
  type Message as SdkMessage,
  type ChatResponse as SdkChatResponse,
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
  timeoutMs?: number;
}

export const DEFAULT_CLOUD_HOST = "https://ollama.com";
export const DEFAULT_LOCAL_HOST = "http://localhost:11434";

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
  private readonly timeoutMs: number;
  // Cached per (tier, host): reused across calls so the SDK's endpoint
  // circuit breaker remembers which cloud key last failed instead of
  // re-trying the same rate-limited key on every call.
  private client: OllamaClient | null = null;
  private clientCacheKey = "";

  constructor(opts: ProviderOptions) {
    this.tier = opts.tier;
    this.model = opts.model;
    this.hostOverride = opts.host;
    this.apiKeys = opts.apiKeys && opts.apiKeys.length > 0 ? opts.apiKeys : opts.apiKey ? [opts.apiKey] : [];
    // Cloud has a 60s connect timeout; local has no timeout — never kill a running generation.
    this.timeoutMs = opts.timeoutMs ?? (opts.tier === "cloud" ? 60_000 : 0);
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
      });
    } else {
      this.client = new OllamaClient({ baseUrl: this.host, timeoutMs: this.timeoutMs, retries: 0 });
    }
    this.clientCacheKey = cacheKey;
    return this.client;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    if (this.tier === "cloud" && this.apiKeys.length === 0) {
      throw new ProviderError("missing apiKey for cloud chat");
    }

    const client = this.buildClient();
    const model = opts.model ?? this.model;
    const request = {
      model,
      messages: messages as unknown as SdkMessage[],
      tools: opts.tools as any,
      ...(this.tier === "local" || opts.options
        ? { options: { ...(this.tier === "local" ? { num_ctx: 16384 } : {}), ...(opts.options ?? {}) } }
        : {}),
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
}
