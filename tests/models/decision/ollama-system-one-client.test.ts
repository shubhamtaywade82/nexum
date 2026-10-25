import type { OllamaClient } from "@nemesis-oss/ollama-sdk";

import { OllamaSystemOneClient } from "../../../src/models/decision/ollama-system-one-client.js";
import type { SystemOneClient } from "../../../src/models/decision/system-one-gateway.js";

// The adapter's only dependency is the SDK's public `OllamaClient.systemOne`.
// A stub records each call so the tests can assert the exact arguments.

interface SystemOneCall {
  request: unknown;
  options: unknown;
}

function makeStubClient(impl: (call: SystemOneCall) => unknown): { client: OllamaClient; calls: SystemOneCall[] } {
  const calls: SystemOneCall[] = [];
  const client = {
    systemOne(request: unknown, options?: unknown): Promise<unknown> {
      const call = { request, options };
      calls.push(call);
      // Mirror the SDK contract: a signal that is already aborted rejects with its reason.
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      if (signal?.aborted) return Promise.reject(signal.reason);
      return Promise.resolve(impl(call));
    },
  };
  return { client: client as unknown as OllamaClient, calls };
}

describe("OllamaSystemOneClient", () => {
  it("implements the SystemOneClient interface", () => {
    const { client } = makeStubClient(() => ({}));
    const adapter = new OllamaSystemOneClient(client);
    // Structural check: the adapter must be assignable to SystemOneClient.
    const typeCheck: SystemOneClient = adapter;
    expect(typeCheck).toBe(adapter);
  });

  it("calls the SDK's public systemOne with the request body", async () => {
    const { client, calls } = makeStubClient(() => ({ decisions: [] }));
    const adapter = new OllamaSystemOneClient(client);

    const request = { model: "tev1", mode: "noul", context: "x", questions: [] };
    const result = await adapter.systemOne(request);

    expect(calls).toHaveLength(1);
    expect(calls[0].request).toBe(request);
    expect(result).toEqual({ decisions: [] });
  });

  it("forwards the AbortSignal so the SDK can cancel the gate and the wire request", async () => {
    const { client, calls } = makeStubClient(() => ({ decisions: [] }));
    const adapter = new OllamaSystemOneClient(client);

    const ac = new AbortController();
    await adapter.systemOne({ model: "x" }, { signal: ac.signal });

    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({ signal: ac.signal });
  });

  it("passes no options when no signal is provided", async () => {
    const { client, calls } = makeStubClient(() => ({ decisions: [] }));
    const adapter = new OllamaSystemOneClient(client);

    await adapter.systemOne({ model: "x" });

    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({});
  });

  it("propagates transport errors from the SDK unchanged", async () => {
    const transportError = new Error("HTTP 503 unavailable");
    const { client } = makeStubClient(() => Promise.reject(transportError));
    const adapter = new OllamaSystemOneClient(client);

    await expect(adapter.systemOne({ model: "x" })).rejects.toBe(transportError);
  });

  it("rejects an already-aborted signal without a result", async () => {
    const { client } = makeStubClient(() => ({ decisions: [] }));
    const adapter = new OllamaSystemOneClient(client);

    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));
    await expect(adapter.systemOne({ model: "x" }, { signal: ac.signal })).rejects.toThrow("user cancelled");
  });
});
