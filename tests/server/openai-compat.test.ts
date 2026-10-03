import OpenAI from "openai";
import { ServerHarness } from "../support/server-harness.js";
import type { SessionSummary } from "../../src/assistant/client/index.js";

interface OpenAiError {
  error: { message: string; type: string; param: string | null; code: string | null };
}

function useHarness(options: { token?: string } = {}) {
  const harness = new ServerHarness();
  beforeAll(async () => {
    await harness.start(options);
  });
  afterAll(async () => {
    await harness.stop();
  });
  beforeEach(async () => {
    harness.resetRunHandler();
    await harness.pg.cleanTables();
  });
  const complete = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { harness, complete };
}

const userMessage = (content: string) => ({ role: "user", content });

describe("OpenAI-compatible API", () => {
  const { harness, complete } = useHarness();

  describe("models", () => {
    it("should list the single nexum-agent model", async () => {
      const res = await fetch(`${harness.baseUrl}/v1/models`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        object: "list",
        data: [{ id: "nexum-agent", object: "model", created: expect.any(Number), owned_by: "nexum" }],
      });
    });

    it("should retrieve nexum-agent and report an unknown model in OpenAI's error shape", async () => {
      expect((await fetch(`${harness.baseUrl}/v1/models/nexum-agent`)).status).toBe(200);

      const res = await fetch(`${harness.baseUrl}/v1/models/gpt-4`);
      const body = (await res.json()) as OpenAiError;

      expect(res.status).toBe(404);
      expect(body.error).toMatchObject({ type: "not_found_error", code: "model_not_found" });
    });

    it("should answer an unknown /v1 route with a 404 in OpenAI's error shape", async () => {
      const res = await fetch(`${harness.baseUrl}/v1/embeddings`, { method: "POST" });

      expect(res.status).toBe(404);
      expect(((await res.json()) as OpenAiError).error.type).toBe("not_found_error");
    });
  });

  describe("chat completions", () => {
    it("should run the agent and return its answer as a chat completion", async () => {
      harness.setRunHandler(async (goal) => `You said: ${goal}`);

      const res = await complete({ model: "nexum-agent", messages: [userMessage("hello")] });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        id: expect.stringMatching(/^chatcmpl-/),
        object: "chat.completion",
        created: expect.any(Number),
        model: "nexum-agent",
        choices: [{ index: 0, message: { role: "assistant", content: "You said: hello" }, finish_reason: "stop" }],
      });
    });

    it("should never advertise a tool call, since Nexum runs its own tools", async () => {
      harness.setRunHandler(async (_goal, agent) => {
        agent.emit("onToolCall", "read_file", { path: "a" });
        agent.emit("onToolResult", "read_file", { content: "x" });
        return "done";
      });

      const body = (await (
        await complete({ model: "nexum-agent", messages: [userMessage("go")], tools: [{ type: "function" }] })
      ).json()) as { choices: Array<{ message: Record<string, unknown> }> };

      expect(body.choices[0].message).not.toHaveProperty("tool_calls");
    });

    it("should give the run the client's history and lead the goal with its system context", async () => {
      let seen: { goal: string; history: string[] } | undefined;
      harness.setRunHandler(async (goal, agent) => {
        seen = { goal, history: agent.conversation.getMessages().map((m) => `${m.role}: ${String(m.content)}`) };
        return "ok";
      });

      await complete({
        model: "nexum-agent",
        messages: [
          { role: "system", content: "Answer in French." },
          userMessage("first question"),
          { role: "assistant", content: "first answer" },
          userMessage("second question"),
        ],
      });

      expect(seen?.goal).toBe("Context from the client:\nAnswer in French.\n\nUser request:\nsecond question");
      expect(seen?.history).toEqual(expect.arrayContaining(["user: first question", "assistant: first answer"]));
    });

    it("should leave no session behind", async () => {
      harness.setRunHandler(async () => "ok");

      await complete({ model: "nexum-agent", messages: [userMessage("hi")] });

      const { body } = await harness.getJson<{ sessions: SessionSummary[] }>("/sessions");
      expect(body.sessions).toEqual([]);
    });

    it("should report a failed run as a server error carrying the reason", async () => {
      harness.setRunHandler(async () => {
        throw new Error("model exploded");
      });

      const res = await complete({ model: "nexum-agent", messages: [userMessage("hi")] });
      const body = (await res.json()) as OpenAiError;

      expect(res.status).toBe(500);
      expect(body.error).toMatchObject({ type: "server_error", message: "model exploded" });
    });

    it("should cancel the run when the client disconnects", async () => {
      let started: () => void = () => {};
      const runStarted = new Promise<void>((resolve) => (started = resolve));
      let sawAbort = false;
      harness.setRunHandler(async (_goal, agent) => {
        started();
        for (let i = 0; i < 100 && !agent.execution.signal?.aborted; i++) await new Promise((r) => setTimeout(r, 20));
        sawAbort = agent.execution.signal?.aborted ?? false;
        throw new Error("aborted");
      });

      const controller = new AbortController();
      const pending = fetch(`${harness.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nexum-agent", messages: [userMessage("long task")] }),
        signal: controller.signal,
      }).catch(() => undefined);
      await runStarted;
      controller.abort();
      await pending;

      for (let i = 0; i < 100 && !sawAbort; i++) await new Promise((r) => setTimeout(r, 20));
      expect(sawAbort).toBe(true);
    });

    describe("rejects what it cannot serve, in OpenAI's error shape", () => {
      it.each([
        ["an unknown model", { model: "gpt-4", messages: [userMessage("hi")] }, 404, "model_not_found"],
        [
          "streaming (not yet available)",
          { model: "nexum-agent", messages: [userMessage("hi")], stream: true },
          400,
          "stream_not_supported",
        ],
        ["an empty message list", { model: "nexum-agent", messages: [] }, 400, null],
        ["a missing model", { messages: [userMessage("hi")] }, 400, null],
        [
          "a last message that is not from the user",
          { model: "nexum-agent", messages: [{ role: "assistant", content: "x" }] },
          400,
          null,
        ],
        [
          "an image part",
          {
            model: "nexum-agent",
            messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }],
          },
          400,
          null,
        ],
      ])("%s", async (_name, body, status, code) => {
        const res = await complete(body);

        expect(res.status).toBe(status);
        expect(((await res.json()) as OpenAiError).error.code).toBe(code);
      });

      it("a body that is not JSON", async () => {
        const res = await complete("{nope");

        expect(res.status).toBe(400);
        expect(((await res.json()) as OpenAiError).error.type).toBe("invalid_request_error");
      });
    });
  });

  describe("official openai client", () => {
    const client = () => new OpenAI({ baseURL: `${harness.baseUrl}/v1`, apiKey: "unused" });

    it("should list models and complete a chat", async () => {
      harness.setRunHandler(async (goal) => `echo ${goal}`);
      const openai = client();

      const models = await openai.models.list();
      const reply = await openai.chat.completions.create({
        model: "nexum-agent",
        messages: [{ role: "user", content: "ping" }],
      });

      expect(models.data.map((m) => m.id)).toEqual(["nexum-agent"]);
      expect(reply.choices[0].message.content).toBe("echo ping");
      expect(reply.choices[0].finish_reason).toBe("stop");
    });

    it("should surface an unknown model as the client's NotFoundError", async () => {
      await expect(
        client().chat.completions.create({ model: "nope", messages: [{ role: "user", content: "x" }] }),
      ).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    });
  });
});

describe("OpenAI-compatible API authentication", () => {
  const { harness } = useHarness({ token: "secret-token" });

  it("should refuse a missing or wrong key in OpenAI's error shape", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
      const res = await fetch(`${harness.baseUrl}/v1/models`, { headers });

      expect(res.status).toBe(401);
      expect(((await res.json()) as OpenAiError).error).toMatchObject({
        type: "authentication_error",
        code: "invalid_api_key",
      });
    }
  });

  it("should accept the bearer token, including through the openai client", async () => {
    const openai = new OpenAI({ baseURL: `${harness.baseUrl}/v1`, apiKey: "secret-token" });

    const models = await openai.models.list();

    expect(models.data).toHaveLength(1);
  });
});
