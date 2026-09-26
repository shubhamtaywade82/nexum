import { Provider, ProviderError } from "../../src/models/adapters/provider.js";

// The SDK's internal HttpClient calls globalThis.fetch, so mocking
// globalThis.fetch gives us full control without needing to mock the
// ESM module boundary (which is fragile under ts-jest ESM mode).

describe("Provider cloud auth", () => {
  it("throws ProviderError before making a request when apiKey is missing", async () => {
    const provider = new Provider({ tier: "cloud", model: "test-model", host: "https://example.invalid" });

    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(ProviderError);
    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/missing apiKey/);
  });

  it("does not throw the apiKey error for local tier", async () => {
    const provider = new Provider({ tier: "local", model: "test-model", host: "http://127.0.0.1:1" });

    // Local will fail with a connection error (ProviderError from mapError), not "missing apiKey"
    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.not.toThrow(/missing apiKey/);
  });
});

describe("Provider error redaction", () => {
  it("redacts bearer tokens from upstream error bodies", async () => {
    // SDK's HttpClient reads error bodies via response.json() then falls
    // back to response.text() — the body is consumed after json() fails,
    // so we must give it valid JSON.  The SDK extracts the "error" field.
    const fakeFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "upstream failed, saw header Authorization: Bearer sk-secret-abc123" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKey: "sk-secret-abc123", host: "https://x" });

    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/\[REDACTED\]/);
    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.not.toThrow(/sk-secret-abc123/);
  });
});

describe("Provider apiKeys pool (Ollama Cloud only)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the single apiKey when no pool is given", async () => {
    const body = JSON.stringify({ model: "m", message: { role: "assistant", content: "ok" }, done: true });
    const fakeFetch = jest
      .fn()
      .mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKey: "solo_key", host: "https://x" });
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const reqUrl = new URL(fakeFetch.mock.calls[0][0] as string);
    expect(reqUrl.pathname).toBe("/api/chat");
  });

  it("uses the first key in the pool by default", async () => {
    const body = JSON.stringify({ model: "m", message: { role: "assistant", content: "ok" }, done: true });
    const fakeFetch = jest
      .fn()
      .mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("rotates to the next key and retries on a 429, succeeding without throwing", async () => {
    const fakeFetch = jest.fn().mockImplementation(async () => {
      // SDK may read the body multiple times (clone + read); create a factory
      // that returns a fresh Response each time it's called.
      if (fakeFetch.mock.calls.length === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ model: "m", message: { role: "assistant", content: "ok" }, done: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });
    const result = await provider.chat([{ role: "user", content: "hi" }]);

    expect(result.message.content).toBe("ok");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("throws RateLimitError once every key in the pool is rate-limited", async () => {
    const fakeFetch = jest.fn().mockImplementation(() => {
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });

    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/rate limited on all 2 key/);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps rotation state across calls — a later call starts from the last successful key", async () => {
    const fakeFetch = jest.fn().mockImplementation(async () => {
      const n = fakeFetch.mock.calls.length;
      if (n === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      if (n === 2) {
        return new Response(
          JSON.stringify({ model: "m", message: { role: "assistant", content: "first" }, done: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ model: "m", message: { role: "assistant", content: "second" }, done: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });
    await provider.chat([{ role: "user", content: "hi" }]);
    await provider.chat([{ role: "user", content: "hi again" }]);

    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });
});

describe("Provider keySelector (KeyManager wiring)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  const okBody = (content = "ok") =>
    new Response(JSON.stringify({ model: "m", message: { role: "assistant", content }, done: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  function authOf(call: unknown[]): string {
    const headers = (call[1] as { headers?: HeadersInit } | undefined)?.headers;
    return new Headers(headers ?? {}).get("authorization") ?? "";
  }

  it("sends the request with the key the selector acquired", async () => {
    const fakeFetch = jest.fn().mockResolvedValue(okBody());
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({
      tier: "cloud",
      model: "m",
      apiKeys: ["key_a", "key_b"],
      host: "https://x",
      keySelector: { acquire: async () => "key_b", release: jest.fn() },
    });
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(authOf(fakeFetch.mock.calls[0])).toBe("Bearer key_b");
  });

  it("releases the acquired key after success and after failure", async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue(okBody());
    const release = jest.fn();
    const provider = new Provider({
      tier: "cloud",
      model: "m",
      apiKeys: ["key_a", "key_b"],
      host: "https://x",
      keySelector: { acquire: async () => "key_b", release },
    });

    await provider.chat([{ role: "user", content: "hi" }]);
    expect(release).toHaveBeenCalledWith("key_b");
    expect(release).toHaveBeenCalledTimes(1);

    (globalThis as any).fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("falls back to the plain endpoint pool when acquire throws", async () => {
    const fakeFetch = jest.fn().mockResolvedValue(okBody());
    (globalThis as any).fetch = fakeFetch;
    const release = jest.fn();

    const provider = new Provider({
      tier: "cloud",
      model: "m",
      apiKeys: ["key_a", "key_b"],
      host: "https://x",
      keySelector: {
        acquire: async () => {
          throw new Error("all keys busy");
        },
        release,
      },
    });
    const res = await provider.chat([{ role: "user", content: "hi" }]);

    expect(res.message.content).toBe("ok");
    expect(authOf(fakeFetch.mock.calls[0])).toBe("Bearer key_a"); // first pool key by priority
    expect(release).not.toHaveBeenCalled(); // nothing was acquired, nothing to release
  });

  it("keeps SDK failover as a safety net below the preferred key", async () => {
    const fakeFetch = jest.fn().mockImplementation(async () => {
      if (fakeFetch.mock.calls.length === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return okBody();
    });
    (globalThis as any).fetch = fakeFetch;
    const release = jest.fn();

    const provider = new Provider({
      tier: "cloud",
      model: "m",
      apiKeys: ["key_a", "key_b"],
      host: "https://x",
      keySelector: { acquire: async () => "key_b", release },
    });
    const res = await provider.chat([{ role: "user", content: "hi" }]);

    expect(res.message.content).toBe("ok");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(authOf(fakeFetch.mock.calls[0])).toBe("Bearer key_b"); // preferred key tried first
    expect(authOf(fakeFetch.mock.calls[1])).toBe("Bearer key_a"); // failed over to the rest of the pool
    expect(release).toHaveBeenCalledWith("key_b");
  });

  it("re-uses the same preferred key for the same model across calls (warmth binding)", async () => {
    const fakeFetch = jest.fn().mockImplementation(async () => okBody());
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({
      tier: "cloud",
      model: "m",
      apiKeys: ["key_a", "key_b"],
      host: "https://x",
      keySelector: { acquire: async () => "key_b", release: jest.fn() },
    });
    await provider.chat([{ role: "user", content: "one" }]);
    await provider.chat([{ role: "user", content: "two" }]);

    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(authOf(fakeFetch.mock.calls[0])).toBe("Bearer key_b");
    expect(authOf(fakeFetch.mock.calls[1])).toBe("Bearer key_b");
  });
});

// Documents the answer to "are multiple API keys auto-switched in live
// sessions?": yes — a 429 (or timeout/auth/5xx) on the serving key rotates
// the session to the next key in the pool automatically, mid-conversation,
// with no manual switching. These tests pin the behavior by asserting which
// key actually served each request via the Authorization header.
describe("documented behavior: automatic key rotation in live sessions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  function authOf(call: unknown[]): string {
    const headers = (call[1] as { headers?: HeadersInit } | undefined)?.headers;
    return new Headers(headers ?? {}).get("authorization") ?? "";
  }

  it("a 429 on the serving key transparently rotates the session to the next key — no manual switch needed", async () => {
    const fakeFetch = jest.fn().mockImplementation(async () => {
      if (fakeFetch.mock.calls.length === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ model: "m", message: { role: "assistant", content: "ok" }, done: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });
    const res = await provider.chat([{ role: "user", content: "hi" }]);

    expect(res.message.content).toBe("ok");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(authOf(fakeFetch.mock.calls[0])).toBe("Bearer key_a");
    expect(authOf(fakeFetch.mock.calls[1])).toBe("Bearer key_b");
  });

  it("the next request starts from the last healthy key (rotation state persists across calls)", async () => {
    const fakeFetch = jest.fn().mockImplementation(async () => {
      const n = fakeFetch.mock.calls.length;
      if (n === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          model: "m",
          message: { role: "assistant", content: n === 2 ? "first" : "second" },
          done: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });
    await provider.chat([{ role: "user", content: "hi" }]);
    const res = await provider.chat([{ role: "user", content: "hi again" }]);

    expect(res.message.content).toBe("second");
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    // Third call (second chat) went straight to the key that recovered the
    // session — the rate-limited key was skipped by its circuit breaker.
    expect(authOf(fakeFetch.mock.calls[2])).toBe("Bearer key_b");
  });
});

describe("Provider streaming", () => {
  function streamOf(lines: string[]): Response {
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < lines.length) {
          controller.enqueue(encoder.encode(lines[i++]));
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }

  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  it("accumulates chunks and fires onChunk callback", async () => {
    (globalThis as any).fetch = jest
      .fn()
      .mockResolvedValue(
        streamOf([
          JSON.stringify({ message: { role: "assistant", content: "he" }, done: false }) + "\n",
          JSON.stringify({ message: { role: "assistant", content: "llo" }, done: true }) + "\n",
        ]),
      );
    const provider = new Provider({ tier: "local", model: "m", host: "http://127.0.0.1:1" });

    const chunks: string[] = [];
    const res = await provider.chat([{ role: "user", content: "hi" }], {
      stream: true,
      onChunk: (c) => {
        if (c.message?.content) chunks.push(c.message.content);
      },
    });

    expect(res.message.content).toBe("hello");
    expect(res.done).toBe(true);
    expect(chunks).toEqual(["he", "llo"]);
  });
});

// The host used to be resolved once in the constructor from the *construction*
// tier, so setTier("cloud") on a local-built Provider kept talking to
// localhost:11434 while attaching a cloud Bearer token to every request.
describe("Provider host resolution", () => {
  const savedEnv = process.env.OLLAMA_HOST;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = savedEnv;
  });

  it("defaults each tier to its own endpoint", () => {
    delete process.env.OLLAMA_HOST;
    expect(new Provider({ tier: "local", model: "m" }).currentHost).toBe("http://localhost:11434");
    expect(new Provider({ tier: "cloud", model: "m", apiKey: "k" }).currentHost).toBe("https://ollama.com");
  });

  it("re-derives the host when the tier changes", () => {
    delete process.env.OLLAMA_HOST;
    const provider = new Provider({ tier: "local", model: "m", apiKey: "k" });
    expect(provider.currentHost).toBe("http://localhost:11434");

    provider.setTier("cloud");

    expect(provider.currentHost).toBe("https://ollama.com");
  });

  it("never resolves OLLAMA_HOST as a cloud endpoint", () => {
    process.env.OLLAMA_HOST = "http://127.0.0.1:9999";
    expect(new Provider({ tier: "local", model: "m" }).currentHost).toBe("http://127.0.0.1:9999");
    expect(new Provider({ tier: "cloud", model: "m", apiKey: "k" }).currentHost).toBe("https://ollama.com");
  });

  it("keeps an explicitly configured host across a tier switch", () => {
    const provider = new Provider({ tier: "local", model: "m", host: "http://proxy.internal", apiKey: "k" });
    provider.setTier("cloud");
    expect(provider.currentHost).toBe("http://proxy.internal");
  });
});
