import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { InferenceService, LANE_FOR_TASK, handleInferenceHttp, type InferenceBody } from "../../src/host/inference.js";
import { InferenceDispatcher } from "../../src/models/gateway/inference-dispatcher.js";
import { ConcurrencyGate } from "../../src/core/concurrency/gate.js";
import { OutcomeUnknownError, RateLimitError } from "../../src/models/errors.js";
import { Provider, type ChatResponse } from "../../src/models/adapters/provider.js";
import { DEFAULT_PRICE_CATALOG } from "../../src/models/profiles/pricing-catalog.js";
import { BudgetLedger } from "../../src/economics/ledger/budget-ledger.js";
import { LedgerCloudAdmission } from "../../src/economics/cloud-admission.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const MODEL = "gpt-oss:120b-cloud";
const DOLLAR = 1_000_000;

let ledger: BudgetLedger | undefined;
afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

function body(over: Partial<InferenceBody> = {}): InferenceBody {
  return {
    taskId: "task-1",
    idempotencyKey: "idem-key-0001",
    taskClass: "complex",
    maxOutputTokens: 256,
    messages: [{ role: "user", content: "hello" }],
    ...over,
  };
}

function exact(prompt: number, cached: number, completion: number): ChatResponse {
  return {
    message: { role: "assistant", content: "ok" },
    done: true,
    prompt_eval_count: prompt,
    prompt_eval_cached_count: cached,
    eval_count: completion,
  } as ChatResponse;
}

function service(opts: { cloudModel?: string; capMicro?: number; withAdmission?: boolean } = {}) {
  const cloudModel = opts.cloudModel ?? MODEL;
  const withAdmission = opts.withAdmission ?? true;
  let admission: LedgerCloudAdmission | undefined;
  if (withAdmission) {
    ledger = new BudgetLedger({ path: ":memory:", clock: () => NOW });
    admission = new LedgerCloudAdmission({
      ledger,
      prices: DEFAULT_PRICE_CATALOG,
      accountId: "acct",
      monthlyCapMicro: opts.capMicro ?? 46 * DOLLAR,
      clock: () => NOW,
    });
  }
  const primary = new Provider({ tier: "cloud", model: cloudModel, apiKey: "k" });
  const quick = new Provider({ tier: "cloud", model: MODEL, apiKey: "k" });
  const dispatcher = new InferenceDispatcher({
    lanes: { primary, quick },
    ...(admission ? { admission } : {}),
    gates: { cloud: new ConcurrencyGate({ maxConcurrent: 10 }) },
  });
  return {
    service: new InferenceService({ dispatcher, prices: DEFAULT_PRICE_CATALOG, clock: () => NOW }),
    primary,
    quick,
  };
}

describe("task-class lane policy (N-12)", () => {
  it("routes routine work to the quick lane and everything else to the primary lane", () => {
    expect(LANE_FOR_TASK.routine).toBe("quick");
    expect(LANE_FOR_TASK.complex).toBe("primary");
    expect(LANE_FOR_TASK.architecture).toBe("primary");
    expect(LANE_FOR_TASK.debugging).toBe("primary");
    expect(LANE_FOR_TASK.review).toBe("primary");
  });
});

describe("POST /v1/inference (service)", () => {
  it("returns the model's answer with the usage reported and the exact cost of the call", async () => {
    const { service: svc, primary } = service();
    const chat = jest.spyOn(primary, "chat").mockResolvedValue(exact(500, 500, 100));

    const out = await svc.infer(body());

    expect(out.httpStatus).toBe(200);
    expect(out.body).toMatchObject({
      status: "OK",
      tier: "cloud",
      model: MODEL,
      usage: { source: "PROVIDER", promptTokens: 500, cachedPromptTokens: 500, completionTokens: 100 },
      cost: { microUsd: 142, basis: "EXACT" },
    });
    expect(chat.mock.calls[0]?.[1]).toMatchObject({ options: { num_predict: 256 } });
  });

  it("answers routine work from the quick lane", async () => {
    const { service: svc, quick } = service();
    const chat = jest.spyOn(quick, "chat").mockResolvedValue(exact(10, 0, 10));
    const out = await svc.infer(body({ taskClass: "routine" }));
    expect(out.httpStatus).toBe(200);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("refuses a repeated key while the first attempt is in flight, and sends nothing more", async () => {
    const { service: svc, primary } = service();
    let finish: (r: ChatResponse) => void = () => undefined;
    const chat = jest.spyOn(primary, "chat").mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    const first = svc.infer(body());
    await new Promise((r) => setImmediate(r));
    const second = await svc.infer(body());

    expect(second).toMatchObject({ httpStatus: 409, body: { status: "IN_FLIGHT" } });
    expect(chat).toHaveBeenCalledTimes(1);
    finish(exact(1, 0, 1));
    await first;
  });

  it("refuses a repeat of a completed call, rather than replaying its answer", async () => {
    const { service: svc, primary } = service();
    const chat = jest.spyOn(primary, "chat").mockResolvedValue(exact(1, 0, 1));
    await svc.infer(body());
    const again = await svc.infer(body());
    expect(again).toMatchObject({ httpStatus: 409, body: { status: "ALREADY_COMPLETED" } });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("refuses a repeated key carrying a different payload", async () => {
    const { service: svc, primary } = service();
    jest.spyOn(primary, "chat").mockResolvedValue(exact(1, 0, 1));
    await svc.infer(body());
    const other = await svc.infer(body({ messages: [{ role: "user", content: "different" }] }));
    expect(other).toMatchObject({ httpStatus: 422, body: { status: "IDEMPOTENCY_PAYLOAD_MISMATCH" } });
  });

  it("refuses a call the budget cannot cover, with 402 and no send", async () => {
    const { service: svc, primary } = service({ capMicro: 1 });
    const chat = jest.spyOn(primary, "chat").mockResolvedValue(exact(1, 0, 1));
    const out = await svc.infer(body());
    expect(out).toMatchObject({ httpStatus: 402, body: { status: "BUDGET_EXCEEDED" } });
    expect(chat).not.toHaveBeenCalled();
  });

  it("refuses an unpriced cloud model with 422 and no send", async () => {
    const { service: svc, primary } = service({ cloudModel: "gemma4:31b" });
    const chat = jest.spyOn(primary, "chat").mockResolvedValue(exact(1, 0, 1));
    const out = await svc.infer(body());
    expect(out).toMatchObject({ httpStatus: 422, body: { status: "UNPRICED_MODEL" } });
    expect(chat).not.toHaveBeenCalled();
  });

  it("reports a cloud call whose outcome is unknown as PROVIDER_TIMEOUT_UNKNOWN and holds its reservation", async () => {
    const { service: svc, primary } = service();
    jest.spyOn(primary, "chat").mockRejectedValue(new OutcomeUnknownError("timed out after dispatch"));
    const out = await svc.infer(body());
    expect(out).toMatchObject({ httpStatus: 504, body: { status: "PROVIDER_TIMEOUT_UNKNOWN" } });
    expect(ledger!.reservationsOf("acct").map((r) => r.state)).toEqual(["UNKNOWN_USAGE"]);
  });

  it("reports a rejected request with 429 and releases the reservation", async () => {
    const { service: svc, primary } = service();
    jest.spyOn(primary, "chat").mockRejectedValue(new RateLimitError("busy", 1000));
    const out = await svc.infer(body());
    expect(out).toMatchObject({ httpStatus: 429, body: { status: "PROVIDER_RATE_LIMITED" } });
    expect(ledger!.reservationsOf("acct").map((r) => r.state)).toEqual(["RELEASED"]);
  });

  it("refuses a cloud call when no admission is configured: the route is never a way round the budget", async () => {
    const { service: svc, primary } = service({ withAdmission: false });
    const chat = jest.spyOn(primary, "chat").mockResolvedValue(exact(1, 0, 1));
    const out = await svc.infer(body());
    expect(out).toMatchObject({ httpStatus: 503, body: { status: "CLOUD_NOT_CONFIGURED" } });
    expect(chat).not.toHaveBeenCalled();
  });
});

function fakeRequest(method: string, payload?: string | Buffer): IncomingMessage {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(payload)]) as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  return req;
}

function fakeResponse(): { res: ServerResponse; result: () => { status: number; body: unknown } } {
  let status = 0;
  let text = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      text = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, body: text === "" ? undefined : JSON.parse(text) }) };
}

describe("POST /v1/inference (HTTP)", () => {
  it("rejects a method other than POST", async () => {
    const { res, result } = fakeResponse();
    await handleInferenceHttp(fakeRequest("GET"), res, service().service);
    expect(result().status).toBe(405);
  });

  it("rejects a body that is not JSON", async () => {
    const { res, result } = fakeResponse();
    await handleInferenceHttp(fakeRequest("POST", "{not json"), res, service().service);
    expect(result()).toMatchObject({ status: 400, body: { error: "invalid_json" } });
  });

  it("requires the output cap: a request without maxOutputTokens is refused before any call", async () => {
    const { res, result } = fakeResponse();
    const { service: svc, primary } = service();
    const chat = jest.spyOn(primary, "chat").mockResolvedValue(exact(1, 0, 1));
    const { maxOutputTokens: _omit, ...withoutCap } = body();
    await handleInferenceHttp(fakeRequest("POST", JSON.stringify(withoutCap)), res, svc);
    expect(result()).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(chat).not.toHaveBeenCalled();
  });

  it("refuses an output cap above the schema limit", async () => {
    const { res, result } = fakeResponse();
    await handleInferenceHttp(
      fakeRequest("POST", JSON.stringify(body({ maxOutputTokens: 100_000 }))),
      res,
      service().service,
    );
    expect(result().status).toBe(400);
  });

  it("refuses a body over the size limit with 413", async () => {
    const { res, result } = fakeResponse();
    const huge = JSON.stringify(body({ messages: [{ role: "user", content: "x".repeat(300 * 1024) }] }));
    await handleInferenceHttp(fakeRequest("POST", huge), res, service().service);
    expect(result().status).toBe(413);
  });

  it("answers a valid request with the service's outcome", async () => {
    const { res, result } = fakeResponse();
    const { service: svc, primary } = service();
    jest.spyOn(primary, "chat").mockResolvedValue(exact(1, 0, 1));
    await handleInferenceHttp(fakeRequest("POST", JSON.stringify(body())), res, svc);
    expect(result()).toMatchObject({ status: 200, body: { status: "OK" } });
  });
});
