import { ModelAvailabilityChecker } from "../../src/models/router/availability.js";

describe("ModelAvailabilityChecker", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetch(responses: Array<{ status: number; body?: unknown }>) {
    let call = 0;
    global.fetch = jest.fn(async () => {
      const r = responses[call++ % responses.length];
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
        text: async () => JSON.stringify(r.body),
      } as Response;
    }) as typeof fetch;
  }

  it("checkOne returns available:true on HTTP 200", async () => {
    mockFetch([{ status: 200, body: { modelfile: "" } }]);
    const checker = new ModelAvailabilityChecker(["key-a"]);
    const result = await checker.checkOne("key-a", "qwen3:8b");
    expect(result.available).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.model).toBe("qwen3:8b");
  });

  it("checkOne returns available:false, reason:subscription_required on HTTP 403", async () => {
    mockFetch([{ status: 403, body: { error: "subscription required" } }]);
    const checker = new ModelAvailabilityChecker(["key-a"]);
    const result = await checker.checkOne("key-a", "qwq:32b");
    expect(result.available).toBe(false);
    expect(result.reason).toBe("subscription_required");
  });

  it("checkOne hits the real /api/chat completion, not /api/show — regression for the false-Free bug", async () => {
    mockFetch([{ status: 403, body: { error: "subscription required" } }]);
    const checker = new ModelAvailabilityChecker(["key-a"]);
    await checker.checkOne("key-a", "kimi-k2.6");
    const [url, init] = (global.fetch as ReturnType<typeof jest.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ollama.com/api/chat");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "kimi-k2.6", stream: false });
  });

  it("checkOne returns available:false, reason:forbidden on a 403 that isn't subscription-worded", async () => {
    mockFetch([{ status: 403, body: { error: "invalid api key" } }]);
    const checker = new ModelAvailabilityChecker(["key-a"]);
    const result = await checker.checkOne("key-a", "some-model");
    expect(result.available).toBe(false);
    expect(result.reason).toBe("forbidden");
  });

  it("checkOne returns available:false, reason:payment_required on HTTP 402 (billing, not credentials)", async () => {
    mockFetch([{ status: 402, body: { error: "upgrade to use this model" } }]);
    const checker = new ModelAvailabilityChecker(["key-a"]);
    const result = await checker.checkOne("key-a", "qwen3-coder:480b");
    expect(result.available).toBe(false);
    expect(result.reason).toBe("payment_required");
  });

  it("checkOne returns available:false, reason:not_found on HTTP 404", async () => {
    mockFetch([{ status: 404, body: { error: "not found" } }]);
    const checker = new ModelAvailabilityChecker(["key-a"]);
    const result = await checker.checkOne("key-a", "nonexistent:latest");
    expect(result.available).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("isAvailable uses cache on second call (fetch called only once)", async () => {
    mockFetch([{ status: 200, body: {} }]);
    const checker = new ModelAvailabilityChecker(["key-a"]);
    const first = await checker.isAvailable("key-a", "qwen3:8b");
    const second = await checker.isAvailable("key-a", "qwen3:8b");
    expect(first).toBe(true);
    expect(second).toBe(true);
    // fetch called only once (second call hit cache)
    expect((global.fetch as ReturnType<typeof jest.fn>).mock.calls.length).toBe(1);
  });

  it("availableModels returns only available models", async () => {
    const checker = new ModelAvailabilityChecker(["key-a"]);
    // Manually populate cache via checkOne
    mockFetch([
      { status: 200, body: {} },
      { status: 403, body: {} },
      { status: 200, body: {} },
    ]);
    await checker.checkOne("key-a", "qwen3:8b");
    await checker.checkOne("key-a", "qwq:32b");
    await checker.checkOne("key-a", "granite4:7b");

    const available = checker.availableModels("key-a");
    expect(available).toContain("qwen3:8b");
    expect(available).toContain("granite4:7b");
    expect(available).not.toContain("qwq:32b");
  });

  it("stats returns correct counts", async () => {
    const checker = new ModelAvailabilityChecker(["key-a", "key-b"]);
    mockFetch([
      { status: 200, body: {} },
      { status: 403, body: {} },
    ]);
    await checker.checkOne("key-a", "model-1");
    await checker.checkOne("key-a", "model-2");

    const s = checker.stats();
    expect(s.keys).toBe(2);
    expect(s.total).toBe(2);
    expect(s.available).toBe(1);
    expect(s.unavailable).toBe(1);
  });

  it("checkOne handles network errors gracefully", async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const checker = new ModelAvailabilityChecker(["key-a"]);
    const result = await checker.checkOne("key-a", "some-model");
    expect(result.available).toBe(false);
    expect(result.reason).toBe("network_error");
  });

  describe("cachedStatus / cachedStatusAnyKey", () => {
    it("cachedStatus returns undefined before any check has run", () => {
      const checker = new ModelAvailabilityChecker(["key-a"]);
      expect(checker.cachedStatus("key-a", "qwen3:8b")).toBeUndefined();
    });

    it("cachedStatus peeks the cache without a live fetch", async () => {
      mockFetch([{ status: 403, body: { error: "subscription required" } }]);
      const checker = new ModelAvailabilityChecker(["key-a"]);
      await checker.checkOne("key-a", "minimax-m2.7");
      const fetchMock = global.fetch as ReturnType<typeof jest.fn>;
      fetchMock.mockClear();
      const status = checker.cachedStatus("key-a", "minimax-m2.7");
      expect(status).toMatchObject({ available: false, reason: "subscription_required" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("cachedStatusAnyKey prefers an available key over a gated one", async () => {
      mockFetch([{ status: 403, body: {} }]);
      const checker = new ModelAvailabilityChecker(["key-a", "key-b"]);
      await checker.checkOne("key-a", "shared-model");
      mockFetch([{ status: 200, body: {} }]);
      await checker.checkOne("key-b", "shared-model");
      expect(checker.cachedStatusAnyKey("shared-model")).toMatchObject({ available: true });
    });

    it("cachedStatusAnyKey returns undefined for a never-checked model", () => {
      const checker = new ModelAvailabilityChecker(["key-a"]);
      expect(checker.cachedStatusAnyKey("unknown-model")).toBeUndefined();
    });
  });
});
