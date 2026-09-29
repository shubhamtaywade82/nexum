import { ModelStack } from "../../src/cli/services/model-stack.js";
import type { CliConfig } from "../../src/cli/config.js";

// Documents how the KeyManager is wired into live cloud requests: with a
// pool of 2+ keys and availability checking on, every cloud chat acquires a
// key through the KeyManager (binding key→model to keep the model warm in
// Ollama Cloud VRAM) and sends the request with that key.

const okBody = (content = "ok") =>
  new Response(JSON.stringify({ model: "m", message: { role: "assistant", content }, done: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("ModelStack KeyManager wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  function mockCloud(mockFn: jest.Mock) {
    (globalThis as any).fetch = mockFn;
  }

  it("routes cloud chats through the KeyManager when a key pool is configured", async () => {
    const fakeFetch = jest.fn().mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      // Startup availability refresh: empty model list → no probes.
      if (url.pathname === "/v1/models") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return okBody();
    });
    mockCloud(fakeFetch);

    const stack = new ModelStack(
      {
        model: "m",
        workspaceRoot: "/tmp/nexum-model-stack-test",
        tier: "cloud",
        apiKey: "primary_key",
        apiKeys: ["primary_key", "second_key"],
        enableAvailabilityCheck: true,
      },
      () => {},
    );

    expect(stack.keyManager).toBeDefined();

    await stack.provider.chat([{ role: "user", content: "hello world" }]);

    // The KeyManager bound the model to a pool key while serving the request.
    expect(stack.keyManager!.boundModels()).toContain("m");

    // The actual chat request (not the availability probe) carried the key
    // the KeyManager acquired for the model.
    const chatCalls = fakeFetch.mock.calls.filter((c: unknown[]) => {
      const body = (c[1] as { body?: unknown } | undefined)?.body;
      return typeof body === "string" && body.includes("hello world");
    });
    expect(chatCalls).toHaveLength(1);
    const headers = new Headers((chatCalls[0][1] as { headers?: HeadersInit }).headers);
    expect(headers.get("authorization")).toBe("Bearer primary_key");
  });

  it("keeps the KeyManager out of the request path for a single-key setup", async () => {
    // Fresh Response per call — the SDK reads bodies more than once, and the
    // startup availability refresh consumes a fetch of its own.
    const fakeFetch = jest.fn().mockImplementation(async () => okBody());
    mockCloud(fakeFetch);

    const stack = new ModelStack(
      {
        model: "m",
        workspaceRoot: "/tmp/nexum-model-stack-test",
        tier: "cloud",
        apiKey: "solo_key",
        apiKeys: ["solo_key"],
        enableAvailabilityCheck: true,
      },
      () => {},
    );

    await stack.provider.chat([{ role: "user", content: "hello world" }]);

    // KeyManager exists for inspection, but nothing was ever acquired
    // through it — with one key there is nothing to bind or rotate.
    expect(stack.keyManager).toBeDefined();
    expect(stack.keyManager!.boundModels()).toEqual([]);

    // Exactly one chat request (plus the startup availability refresh, which
    // is not a chat and carries no "hello world" body).
    const chatCalls = fakeFetch.mock.calls.filter((c: unknown[]) => {
      const body = (c[1] as { body?: unknown } | undefined)?.body;
      return typeof body === "string" && body.includes("hello world");
    });
    expect(chatCalls).toHaveLength(1);
  });

  it("builds no KeyManager without a key pool", () => {
    const stack = new ModelStack(
      {
        model: "m",
        workspaceRoot: "/tmp/nexum-model-stack-test",
        tier: "cloud",
        apiKey: "solo_key",
        enableAvailabilityCheck: true,
      } satisfies CliConfig,
      () => {},
    );

    expect(stack.keyManager).toBeUndefined();
  });
});
