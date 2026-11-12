/**
 * POST /v1/inference: one raw model call for a caller that owns its own loop (the Toolery benchmark harness, for one).
 *
 * This is not the agent. It runs no tools and no planning, so the caller's measurements are of the model and not of
 * Nexum's prompt loop. The caller states a task class (which picks the lane), an idempotency key, and a required
 * output cap. The output cap sizes the cloud reservation and is sent to the provider as `num_predict`.
 *
 * Idempotency comes from the budget ledger. A repeated key is refused, never run again: 409 while the first attempt is
 * in flight or after it completed, 422 when the payload differs. A completed call's response is not stored, so a
 * repeat gets a 409, not a replay of the answer.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  BudgetRefusedError,
  OutcomeUnknownError,
  PaymentRequiredError,
  RateLimitError,
  TimeoutError,
} from "../models/errors.js";
import { UnpricedModelError, type PriceCatalog } from "../models/profiles/pricing-catalog.js";
import type { ChatMessage, ChatOptions, ChatResponse } from "../models/adapters/provider.js";
import type { InferenceDispatcher } from "../models/gateway/inference-dispatcher.js";
import { readUsage } from "../models/usage-reading.js";
import { priceReading } from "../economics/usage-cost.js";
import { writeJson } from "./http.js";

export const TASK_CLASSES = ["routine", "complex", "architecture", "debugging", "review"] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

/**
 * The task-class tier map (N-12). Routine work runs on the quick lane. Everything else runs on the primary lane. A
 * premium escalation is not configured here: no premium lane exists yet, so this map is the whole policy.
 */
export const LANE_FOR_TASK: Readonly<Record<TaskClass, "quick" | "primary">> = {
  routine: "quick",
  complex: "primary",
  architecture: "primary",
  debugging: "primary",
  review: "primary",
};

const MAX_BODY_BYTES = 256 * 1024;
const MAX_OUTPUT_TOKENS = 8192;

export const InferenceBodySchema = z.object({
  taskId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(8).max(200),
  taskClass: z.enum(TASK_CLASSES),
  maxOutputTokens: z.number().int().positive().max(MAX_OUTPUT_TOKENS),
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string() }).passthrough())
    .min(1),
  tools: z.array(z.unknown()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
export type InferenceBody = z.infer<typeof InferenceBodySchema>;

export interface InferenceOutcome {
  readonly httpStatus: number;
  readonly body: Record<string, unknown>;
}

export interface InferenceServiceOptions {
  dispatcher: InferenceDispatcher;
  prices: PriceCatalog;
  clock?: () => Date;
}

/** Maps an admission refusal's code onto an HTTP status and a status name the caller can act on. */
const REFUSAL_STATUS: Readonly<Record<string, { httpStatus: number; status: string }>> = {
  IN_FLIGHT: { httpStatus: 409, status: "IN_FLIGHT" },
  ALREADY_COMPLETED: { httpStatus: 409, status: "ALREADY_COMPLETED" },
  PAYLOAD_MISMATCH: { httpStatus: 422, status: "IDEMPOTENCY_PAYLOAD_MISMATCH" },
  BUDGET_EXCEEDED: { httpStatus: 402, status: "BUDGET_EXCEEDED" },
  CYCLE_OVEREXPOSED: { httpStatus: 402, status: "BUDGET_EXCEEDED" },
  CLOUD_CONCURRENCY: { httpStatus: 429, status: "CLOUD_CAPACITY_BUSY" },
  OUTPUT_CAP_EXCEEDED: { httpStatus: 400, status: "INVALID_REQUEST" },
  INVALID_OUTPUT_CAP: { httpStatus: 400, status: "INVALID_REQUEST" },
  NO_ADMISSION: { httpStatus: 503, status: "CLOUD_NOT_CONFIGURED" },
  CYCLE_NOT_OPEN: { httpStatus: 503, status: "BUDGET_UNAVAILABLE" },
};

export class InferenceService {
  private readonly dispatcher: InferenceDispatcher;
  private readonly prices: PriceCatalog;
  private readonly clock: () => Date;

  constructor(opts: InferenceServiceOptions) {
    this.dispatcher = opts.dispatcher;
    this.prices = opts.prices;
    this.clock = opts.clock ?? (() => new Date());
  }

  async infer(body: InferenceBody): Promise<InferenceOutcome> {
    const lane = LANE_FOR_TASK[body.taskClass];
    const messages = body.messages as ChatMessage[];
    const base = { taskId: body.taskId, idempotencyKey: body.idempotencyKey, taskClass: body.taskClass, lane };
    let response: ChatResponse;
    try {
      response = await this.dispatcher.dispatch(
        {
          lane,
          purpose: `inference.${body.taskClass}`,
          taskId: body.taskId,
          idempotencyKey: body.idempotencyKey,
        },
        messages,
        {
          ...(body.tools !== undefined ? { tools: body.tools as ChatOptions["tools"] } : {}),
          options: { ...(body.options ?? {}), num_predict: body.maxOutputTokens },
        },
      );
    } catch (err) {
      return this.failure(base, err);
    }

    const tier = response.routedTier ?? "local";
    const model = response.routedModel ?? "";
    const reading = readUsage(response);
    const version = tier === "cloud" ? this.prices.priceAt(model, this.clock()) : undefined;
    const priced = version ? priceReading(reading, version) : undefined;
    return {
      httpStatus: 200,
      body: {
        ...base,
        status: "OK",
        model,
        tier,
        message: response.message,
        usage: {
          source: reading.source,
          promptTokens: reading.promptTokens ?? null,
          cachedPromptTokens: reading.cachedPromptTokens ?? null,
          completionTokens: reading.completionTokens ?? null,
        },
        cost: priced ? { microUsd: priced.costMicroUsd, basis: priced.basis } : null,
      },
    };
  }

  private failure(base: Record<string, unknown>, err: unknown): InferenceOutcome {
    if (err instanceof BudgetRefusedError) {
      const mapped = REFUSAL_STATUS[err.reason] ?? { httpStatus: 503, status: "REFUSED" };
      return {
        httpStatus: mapped.httpStatus,
        body: { ...base, status: mapped.status, reason: err.reason, message: err.message },
      };
    }
    if (err instanceof UnpricedModelError) {
      return { httpStatus: 422, body: { ...base, status: "UNPRICED_MODEL", message: err.message } };
    }
    // The admission held the reservation: a cloud call that may have run. The caller must not retry under a new key.
    if (err instanceof OutcomeUnknownError || err instanceof TimeoutError) {
      return {
        httpStatus: 504,
        body: { ...base, status: "PROVIDER_TIMEOUT_UNKNOWN", message: "the provider outcome is unknown" },
      };
    }
    if (err instanceof RateLimitError) {
      return {
        httpStatus: 429,
        body: { ...base, status: "PROVIDER_RATE_LIMITED", message: "the provider rejected the request" },
      };
    }
    if (err instanceof PaymentRequiredError) {
      return {
        httpStatus: 402,
        body: { ...base, status: "PROVIDER_PAYMENT_REQUIRED", message: "the provider requires payment" },
      };
    }
    const message = err instanceof Error ? err.message.slice(0, 200) : "unknown error";
    return { httpStatus: 502, body: { ...base, status: "PROVIDER_ERROR", message } };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** HTTP surface: method, body size, JSON, schema. Everything after that is the service's decision. */
export async function handleInferenceHttp(
  req: IncomingMessage,
  res: ServerResponse,
  service: InferenceService,
): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method_not_allowed", message: "POST /v1/inference" });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    writeJson(res, 413, { error: "payload_too_large", message: `body exceeds ${MAX_BODY_BYTES} bytes` });
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    writeJson(res, 400, { error: "invalid_json", message: "body is not valid JSON" });
    return;
  }
  const parsed = InferenceBodySchema.safeParse(json);
  if (!parsed.success) {
    writeJson(res, 400, {
      error: "invalid_request",
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
    return;
  }
  const outcome = await service.infer(parsed.data);
  writeJson(res, outcome.httpStatus, outcome.body);
}
