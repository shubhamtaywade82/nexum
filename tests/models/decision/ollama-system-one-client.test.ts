import { systemOne as systemOneOperation, NativeApi } from "@nemesis-oss/ollama-sdk/generated/api";
import type { OllamaClient } from "@nemesis-oss/ollama-sdk";

import { OllamaSystemOneClient } from "../../../src/models/decision/ollama-system-one-client.js";
import type { SystemOneClient } from "../../../src/models/decision/system-one-gateway.js";

// ── Stub OllamaClient with a controllable runtime.invoke ───────────────────
// The adapter only depends on `client.runtime.invoke` (the SDK's public
// OllamaRuntime method, since NativeApi.systemOne is a one-line wrapper around
// it). We stub the runtime to capture the call shape and return canned
// responses; the real NativeApi class is used so the test verifies that the
// adapter actually constructs it correctly.

interface InvokeCall {
  operation: { operationId: string };
  body: unknown;
  signal?: AbortSignal;
}

function makeStubClient(invokeImpl: (call: InvokeCall) => unknown): OllamaClient {
  const calls: InvokeCall[] = [];
  const runtime = {
    invoke<T = unknown>(req: unknown): Promise<T> {
      const call = req as InvokeCall;
      calls.push(call);
      // Mirror the real OllamaRuntime.invoke abort contract: an already-
      // aborted signal rejects with the abort reason. This lets the adapter
      // rely on the SDK's native abort handling — no external Promise.race.
      if (call.signal?.aborted) {
        return Promise.reject(call.signal.reason ?? new Error("aborted"));
      }
      const ret = invokeImpl(call);
      if (ret instanceof Promise) return ret as Promise<T>;
      return Promise.resolve(ret as T);
    },
  };
  // The OllamaClient shape we depend on is just `{ runtime: { invoke } }`. We
  // cast to OllamaClient for the type system; the adapter never touches other
  // fields.
  return { runtime } as unknown as OllamaClient;
}

describe("OllamaSystemOneClient", () => {
  it("implements the SystemOneClient interface", () => {
    const client = makeStubClient(() => ({}));
    const adapter = new OllamaSystemOneClient(client);
    // Structural check: the adapter must be assignable to SystemOneClient.
    const _typeCheck: SystemOneClient = adapter;
    expect(_typeCheck).toBe(adapter);
    expect(typeof adapter.systemOne).toBe("function");
  });

  it("calls runtime.invoke with the systemOne operation and the request body", async () => {
    const received: InvokeCall[] = [];
    const client = makeStubClient((call) => {
      received.push(call);
      return { decisions: [] };
    });
    const adapter = new OllamaSystemOneClient(client);

    const request = { model: "mpuig/system-one-minicpm5-2b-q8", mode: "noul", context: "x", questions: [] };
    const result = await adapter.systemOne(request);

    expect(received).toHaveLength(1);
    expect(received[0].operation.operationId).toBe("systemOne");
    // Reference equality — the adapter must pass the SDK's exported
    // systemOneOp constant, not a copy. This proves we are not deep-importing
    // private internals; we are using the public `./generated/api` subpath.
    expect(received[0].operation).toBe(systemOneOperation);
    expect(received[0].body).toBe(request);
    expect(result).toEqual({ decisions: [] });
  });

  it("forwards the AbortSignal to runtime.invoke so the SDK can cancel the HTTP request natively", async () => {
    const received: InvokeCall[] = [];
    const client = makeStubClient((call) => {
      received.push(call);
      return { decisions: [] };
    });
    const adapter = new OllamaSystemOneClient(client);

    const ac = new AbortController();
    await adapter.systemOne({ model: "x" }, { signal: ac.signal });

    expect(received).toHaveLength(1);
    expect(received[0].signal).toBe(ac.signal);
  });

  it("omits the signal field entirely when no signal is provided (clean wire shape)", async () => {
    const received: InvokeCall[] = [];
    const client = makeStubClient((call) => {
      received.push(call);
      return { decisions: [] };
    });
    const adapter = new OllamaSystemOneClient(client);

    await adapter.systemOne({ model: "x" });

    expect(received).toHaveLength(1);
    expect(received[0].signal).toBeUndefined();
    // The invoke call must have exactly the keys { operation, body }.
    expect(Object.keys(received[0]).sort()).toEqual(["body", "operation"]);
  });

  it("propagates transport errors from runtime.invoke unchanged", async () => {
    const transportError = new Error("HTTP 503 unavailable");
    const client = makeStubClient(() => Promise.reject(transportError));
    const adapter = new OllamaSystemOneClient(client);

    await expect(adapter.systemOne({ model: "x" })).rejects.toBe(transportError);
  });

  it("propagates an already-aborted signal as the SDK's abort rejection", async () => {
    const client = makeStubClient(() => {
      // Should not be reached because the SDK's runtime.invoke is expected
      // to throw synchronously when given an already-aborted signal.
      return { decisions: [] };
    });
    const adapter = new OllamaSystemOneClient(client);

    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));
    // We do not assert on the exact error type — the SDK may throw
    // OllamaAbortError or a DOMException — only that the call rejects.
    await expect(adapter.systemOne({ model: "x" }, { signal: ac.signal })).rejects.toBeInstanceOf(Error);
  });

  it("uses the SDK's real NativeApi class to build the call (regression guard)", () => {
    // The adapter must not duplicate NativeApi.systemOne's logic. We verify
    // by ensuring that the operation that reaches runtime.invoke is the same
    // one the SDK's NativeApi.systemOne would have used. Construct a NativeApi
    // directly with the same runtime and call systemOne; the operation it
    // passes to invoke must match what our adapter passes.
    let capturedFromNativeApi: unknown;
    let capturedFromAdapter: unknown;
    const runtimeForNativeApi = {
      invoke(req: unknown) {
        capturedFromNativeApi = req;
        return Promise.resolve({});
      },
    };
    const runtimeForAdapter = {
      invoke(req: unknown) {
        capturedFromAdapter = req;
        return Promise.resolve({});
      },
    };

    const nativeApi = new NativeApi(runtimeForNativeApi as never);
    void nativeApi.systemOne({ model: "x" });

    const adapter = new OllamaSystemOneClient({ runtime: runtimeForAdapter } as unknown as OllamaClient);
    void adapter.systemOne({ model: "x" });

    expect((capturedFromAdapter as InvokeCall).operation).toBe((capturedFromNativeApi as InvokeCall).operation);
  });
});
