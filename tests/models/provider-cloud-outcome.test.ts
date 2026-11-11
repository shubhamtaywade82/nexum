import { Provider, OutcomeUnknownError, TimeoutError, TransportFailure } from "../../src/models/adapters/provider.js";

// Each test drives the SDK through a mocked globalThis.fetch, the same boundary the production client uses.
// The contract under test: a cloud request that may have run is never sent a second time, on any key.

const CHAT = [{ role: "user" as const, content: "hi" }];

const okBody = () =>
  new Response(JSON.stringify({ model: "m", message: { role: "assistant", content: "ok" }, done: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function socketError(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

/** A fetch that never answers until the SDK aborts it, which is how a timeout looks on the wire. */
function hangUntilAborted(): (url: unknown, init?: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
    });
}

describe("Provider cloud: a request that may have run is not sent again", () => {
  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  it("a timed-out cloud chat is sent once and reports OutcomeUnknownError, not a failover", async () => {
    const fakeFetch = jest.fn(hangUntilAborted());
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({
      tier: "cloud",
      model: "m",
      apiKeys: ["key_a", "key_b"],
      host: "https://x",
      timeoutMs: 50,
    });

    await expect(provider.chat(CHAT)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("a connection reset after the request left is OutcomeUnknownError and is not re-sent", async () => {
    const fakeFetch = jest.fn(async () => {
      throw socketError("ECONNRESET");
    });
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });

    await expect(provider.chat(CHAT)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("a 500 from the cloud is OutcomeUnknownError and is not re-sent on the next key", async () => {
    const fakeFetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: "internal failure" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });

    await expect(provider.chat(CHAT)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("a connection refused before the request left is a plain TransportFailure, retryable elsewhere", async () => {
    const fakeFetch = jest.fn(async () => {
      throw socketError("ECONNREFUSED");
    });
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });

    const error = await provider.chat(CHAT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportFailure);
    expect(error).not.toBeInstanceOf(OutcomeUnknownError);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("a rejected key (401) still fails over to the next key, because it never ran", async () => {
    const fakeFetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid api key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(okBody());
    (globalThis as any).fetch = fakeFetch;

    const provider = new Provider({ tier: "cloud", model: "m", apiKeys: ["key_a", "key_b"], host: "https://x" });

    const result = await provider.chat(CHAT);
    expect(result.message.content).toBe("ok");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("a local timeout is still a recoverable TimeoutError, since local calls bill nothing", async () => {
    (globalThis as any).fetch = jest.fn(hangUntilAborted());

    const provider = new Provider({ tier: "local", model: "m", host: "http://localhost:11434", timeoutMs: 50 });

    await expect(provider.chat(CHAT)).rejects.toBeInstanceOf(TimeoutError);
  });
});
