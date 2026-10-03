import { MessageRepository } from "../../src/persistence/repositories/message-repository.js";
import { FakeAgent } from "../support/fake-agent.js";
import { ServerHarness } from "../support/server-harness.js";
import type { SessionSummary } from "../../src/assistant/client/index.js";

const agents: FakeAgent[] = [];
const harness = new ServerHarness();

beforeAll(async () => {
  await harness.start({
    createAgent: () => {
      const agent = new FakeAgent();
      agents.push(agent);
      return agent;
    },
  });
});
afterAll(() => harness.stop());
beforeEach(async () => {
  harness.resetRunHandler();
  await harness.pg.cleanTables();
});

const chat = (content: string, headers: Record<string, string> = {}, extra: object = {}) =>
  fetch(`${harness.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "nexum-agent", messages: [{ role: "user", content }], ...extra }),
  });

// The discovery agent outlives each test, so count completions rather than clearing the list.
const plainCompletionCount = () => agents.reduce((sum, agent) => sum + agent.plainCompletions.length, 0);

const sessionCount = async () =>
  (await harness.getJson<{ sessions: SessionSummary[] }>("/sessions")).body.sessions.length;

describe("Open WebUI task requests", () => {
  it.each([
    ["the task header", { "X-OpenWebUI-Task": "title_generation" }, "name this chat"],
    ["the task prompt marker", {}, "### Task:\nGenerate a title"],
  ])("should answer with a plain model reply and no agent run when it carries %s", async (_name, headers, text) => {
    harness.setRunHandler(async () => "agent answer");
    const before = plainCompletionCount();

    const res = await chat(text, headers);

    expect((await res.json()).choices[0].message.content).toBe("plain reply");
    expect(plainCompletionCount() - before).toBe(1);
    expect(await sessionCount()).toBe(0);
  });

  it("should stream the plain reply as one chunk followed by [DONE]", async () => {
    const res = await chat("### Task:\nGenerate tags", {}, { stream: true });
    const body = await res.text();

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"content":"plain reply"');
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("keyed sessions", () => {
  it("should continue one persistent session for requests that share a chat id", async () => {
    const goals: string[] = [];
    harness.setRunHandler(async (goal) => (goals.push(goal), `answer ${goals.length}`));

    await chat("first", { "X-OpenWebUI-Chat-Id": "chat-a" });
    const second = await chat("second", { "X-OpenWebUI-Chat-Id": "chat-a" });

    expect((await second.json()).choices[0].message.content).toBe("answer 2");
    expect(goals).toEqual(["first", "second"]);
    expect(await sessionCount()).toBe(1);
  });

  it("should keep separate sessions for different chat ids", async () => {
    harness.setRunHandler(async () => "ok");

    await chat("hi", { "X-OpenWebUI-Chat-Id": "chat-a" });
    await chat("hi", { "X-OpenWebUI-Chat-Id": "chat-b" });

    expect(await sessionCount()).toBe(2);
  });

  it("should answer 409 conversation_busy while the chat's previous response is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    harness.setRunHandler(async () => (started(), await gate, "done"));

    const first = chat("long", { "X-OpenWebUI-Chat-Id": "chat-a" });
    await running;
    const second = await chat("again", { "X-OpenWebUI-Chat-Id": "chat-a" });
    release();

    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("conversation_busy");
    expect((await first).status).toBe(200);
  });

  it("should seed a new keyed session with the client's earlier turns only once", async () => {
    harness.setRunHandler(async () => "ok");
    const withHistory = (final: string) =>
      fetch(`${harness.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenWebUI-Chat-Id": "chat-h" },
        body: JSON.stringify({
          model: "nexum-agent",
          messages: [
            { role: "user", content: "earlier" },
            { role: "assistant", content: "reply" },
            { role: "user", content: final },
          ],
        }),
      });

    await withHistory("one");
    await withHistory("two");

    const { body } = await harness.getJson<{ sessions: SessionSummary[] }>("/sessions");
    const stored = await new MessageRepository(harness.db).listBySession(body.sessions[0].id);
    expect(stored.filter((message) => message.content === "earlier")).toHaveLength(1);
  });
});
