import {
  PaymentRequiredError,
  Provider,
  ProviderError,
  RateLimitError,
  TransportFailure,
} from "../../src/models/adapters/provider.js";

// The SDK's HttpClient reads globalThis.fetch, so each case drives the real
// transport and asserts on the error (or event stream) the caller observes.

const messages = [{ role: "user" as const, content: "hi" }];

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Provider — SDK 1.20 error taxonomy", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps HTTP 402 to PaymentRequiredError and keeps the redacted upstream text", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "requires a subscription (Bearer sk-live-abc123)" }, 402)) as never;

    const provider = new Provider({ tier: "cloud", model: "m", apiKey: "sk-live-abc123", host: "https://x" });
    const err = await provider.chat(messages).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PaymentRequiredError);
    // Still a ProviderError, so anything matching the provider hierarchy keeps working.
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/subscription/);
    expect((err as Error).message).not.toMatch(/sk-live-abc123/);
  });

  it("maps a connection-level failure to TransportFailure, not a generic ProviderError", async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed")) as never;

    const provider = new Provider({ tier: "local", model: "m", host: "http://127.0.0.1:1" });
    const err = await provider.chat(messages).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransportFailure);
    expect(err).not.toBeInstanceOf(ProviderError);
  });

  it("carries the server's Retry-After into RateLimitError.retryAfterMs", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "slow down" }, 429, { "retry-after": "7" })) as never;

    const provider = new Provider({ tier: "local", model: "m", host: "http://127.0.0.1:11434" });
    const err = await provider.chat(messages).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(7_000);
  });
});

describe("Provider — account probes (usage/balance)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("requests the per-model breakdown with group_by=model and a deadline-bounded signal", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}, 200));
    globalThis.fetch = fetchMock as never;

    const provider = new Provider({ tier: "cloud", model: "m", apiKey: "k1", host: "https://ollama.com" });
    await provider.usageAll({ range: "7d", groupBy: "model" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/usage");
    expect(parsed.searchParams.get("group_by")).toBe("model");
    expect(parsed.searchParams.get("range")).toBe("7d");
    // Set so a 429 Retry-After sleep can never outlive the probe.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("Provider — pullModel", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("streams registry frames through onProgress with percent and the raw status sequence", async () => {
    const frames = [
      { status: "pulling manifest" },
      { status: "downloading", digest: "sha256:aa", total: 200, completed: 100 },
      { status: "success" },
    ];
    const body = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
    globalThis.fetch = fetchMock as never;

    const provider = new Provider({ tier: "local", model: "m", host: "http://127.0.0.1:11434" });
    const events: Array<{ status: string; percent?: number }> = [];
    await provider.pullModel("qwen3:8b", (e) => events.push({ status: e.status, percent: e.percent }));

    expect(events.map((e) => e.status)).toEqual(["pulling manifest", "downloading", "success"]);
    expect(events[1].percent).toBe(50);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/pull");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "qwen3:8b", stream: true });
  });

  it("refuses the cloud tier before any request is made", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as never;

    const provider = new Provider({ tier: "cloud", model: "m", apiKey: "k", host: "https://ollama.com" });
    await expect(provider.pullModel("m", () => {})).rejects.toThrow(/local tier/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
