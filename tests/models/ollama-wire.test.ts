import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  Provider,
  PaymentRequiredError,
  RateLimitError,
  TransportFailure,
} from "../../src/models/adapters/provider.js";
import { ModelCatalog } from "../../src/models/catalog.js";
import { OllamaEmbedder } from "../../src/memory/semantic/embedding.js";
import { Router } from "../../src/models/router/router.js";
import { budgetForProfile } from "../../src/models/profiles/context-budget.js";
import { profileFromLegacy } from "../../src/models/profiles/model-profile.js";

// These tests run the SDK's real HTTP transport (fetch over a socket) against a
// local server that speaks the documented Ollama endpoints. Mocked fetch proves
// the mapping; this proves the bytes on the wire, the status codes, the headers
// and the NDJSON framing all survive the trip.

type Handler = (req: IncomingMessage, body: unknown, res: ServerResponse) => void | Promise<void>;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function startServer(handler: Handler): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    try {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      await handler(req, body, res);
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** A port nothing listens on: bind, learn the number, close. */
async function closedPortUrl(): Promise<string> {
  const { server, baseUrl } = await startServer((_req, _body, res) => sendJson(res, 200, {}));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return baseUrl;
}

const chatReply = (model: string) => ({
  model,
  message: { role: "assistant", content: "ok" },
  done: true,
});

describe("Ollama wire contract over a real socket", () => {
  let server: Server;
  let baseUrl: string;
  const embedBatches: number[] = [];

  beforeAll(async () => {
    ({ server, baseUrl } = await startServer(async (req, body, res) => {
      const path = req.url ?? "";
      if (path === "/api/version") return sendJson(res, 200, { version: "0.41.0" });
      if (path === "/api/tags") {
        return sendJson(res, 200, { models: [{ name: "qwen3:8b", model: "qwen3:8b" }] });
      }
      if (path === "/api/show") {
        return sendJson(res, 200, {
          capabilities: ["completion", "tools"],
          model_info: { "qwen3.context_length": 8192 },
          parameters: "num_ctx 4096",
        });
      }
      if (path === "/api/chat") {
        const model = (body as { model: string }).model;
        if (model === "premium:cloud") {
          return sendJson(res, 402, { error: "this model requires a subscription" });
        }
        if (model === "busy") {
          return sendJson(res, 429, { error: "slow down" }, { "retry-after": "7" });
        }
        return sendJson(res, 200, chatReply(model));
      }
      if (path === "/api/embed") {
        const input = (body as { input: string[] }).input;
        embedBatches.push(input.length);
        return sendJson(res, 200, { embeddings: input.map((text) => [Number(text), 1]) });
      }
      if (path === "/api/pull") {
        // NDJSON framing with real gaps between frames, so the SDK's speed tracker
        // has elapsed time to measure.
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const frames = [
          { status: "pulling manifest" },
          { status: "downloading", digest: "sha256:aa", total: 1_000_000, completed: 0 },
          { status: "downloading", digest: "sha256:aa", total: 1_000_000, completed: 500_000 },
          { status: "downloading", digest: "sha256:aa", total: 1_000_000, completed: 1_000_000 },
          { status: "success" },
        ];
        for (const frame of frames) {
          res.write(`${JSON.stringify(frame)}\n`);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        res.end();
        return;
      }
      sendJson(res, 404, { error: `no route ${path}` });
    }));
  });

  afterAll(async () => {
    // Drop keep-alive sockets first, or the client's pool keeps the worker alive.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const messages = [{ role: "user" as const, content: "hi" }];

  it("maps an HTTP 402 response to PaymentRequiredError with the upstream text intact", async () => {
    const provider = new Provider({ tier: "local", model: "premium:cloud", host: baseUrl });

    const err = await provider.chat(messages).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect((err as Error).message).toMatch(/subscription/);
  });

  it("carries a real Retry-After header into RateLimitError.retryAfterMs", async () => {
    const provider = new Provider({ tier: "local", model: "busy", host: baseUrl });

    const err = await provider.chat(messages).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(7_000);
  });

  it("reports a refused connection as TransportFailure, the class the router fails over on", async () => {
    const provider = new Provider({ tier: "local", model: "qwen3:8b", host: await closedPortUrl() });

    const err = await provider.chat(messages).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransportFailure);
  });

  it("fails over from an unreachable local daemon to the cloud candidate", async () => {
    const local = new Provider({ tier: "local", model: "qwen3:8b", host: await closedPortUrl() });
    // The cloud tier is served by the same stub here: it answers chat for any model.
    const cloud = new Provider({ tier: "cloud", model: "qwen3-coder:480b", apiKey: "k", host: baseUrl });
    const catalog = new ModelCatalog(local, cloud);
    jest.spyOn(local, "availableModels").mockResolvedValue({ models: [{ name: "qwen3:8b" }] });
    jest.spyOn(cloud, "availableModels").mockResolvedValue({ data: [{ id: "qwen3-coder:480b" }] });
    await catalog.refresh();
    const router = new Router({ local, cloud, catalog, logger: { warn: jest.fn() } });

    const result = await router.route("coding", messages);

    expect(result.routedTier).toBe("cloud");
    expect(result.message.content).toBe("ok");
  });

  it("discovers each local model's native context window from /api/show and bounds its budget by it", async () => {
    const local = new Provider({ tier: "local", model: "qwen3:8b", host: baseUrl });
    const catalog = new ModelCatalog(local);

    const infos = await catalog.refresh();
    const info = infos.find((i) => i.name === "qwen3:8b");

    expect(info?.contextLength).toBe(8_192);
    const profile = profileFromLegacy(info!);
    expect(profile.constraints.contextWindow).toBe(8_192);
    expect(budgetForProfile(profile).contextTokens).toBeLessThanOrEqual(8_192);
  });

  it("streams a registry pull with percent and measured transfer speed", async () => {
    const provider = new Provider({ tier: "local", model: "qwen3:8b", host: baseUrl });
    const events: Array<{ status: string; percent?: number; bytesPerSecond?: number }> = [];

    await provider.pullModel("qwen3:8b", (e) =>
      events.push({ status: e.status, percent: e.percent, bytesPerSecond: e.bytesPerSecond }),
    );

    expect(events.map((e) => e.status)).toEqual([
      "pulling manifest",
      "downloading",
      "downloading",
      "downloading",
      "success",
    ]);
    expect(events.filter((e) => e.status === "downloading").map((e) => e.percent)).toEqual([0, 50, 100]);
    // Speed needs two byte-bearing frames of the same layer; the third has both.
    expect(events[3].bytesPerSecond).toBeGreaterThan(0);
  });

  it("sends a large corpus to /api/embed in 32-input batches and keeps input order", async () => {
    embedBatches.length = 0;
    const embedder = new OllamaEmbedder({ model: "nomic-embed-text", baseUrl });
    const texts = Array.from({ length: 40 }, (_, i) => String(i + 1));

    const vectors = await embedder.embedBatch(texts);

    expect([...embedBatches].sort((a, b) => a - b)).toEqual([8, 32]);
    expect(vectors).toHaveLength(40);
    // The server echoes [n, 1]; after L2 normalisation the first component is n / sqrt(n² + 1),
    // so each vector is checked against its own input, which proves order is preserved.
    expect(vectors[0][0]).toBeCloseTo(1 / Math.sqrt(2));
    expect(vectors[39][0]).toBeCloseTo(40 / Math.sqrt(40 * 40 + 1));
  });
});
