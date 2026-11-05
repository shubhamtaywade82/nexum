import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { SseStream } from "../../src/host/openai/sse.js";
import { projectEvent, type ProjectionState } from "../../src/host/openai/stream-projection.js";
import type { NexumRunEvent } from "../../src/protocol/types.js";

const ts = 1;
const project = (event: NexumRunEvent, state: ProjectionState = { activity: false }) => projectEvent(event, state);

describe("projectEvent", () => {
  it("should show a tool call as a blockquote line with its arguments", () => {
    const state = { activity: false };

    const line = projectEvent(
      { type: "tool.started", runId: "r", callId: "c", name: "read_file", args: { path: "a.txt" }, ts },
      state,
    );

    expect(line).toBe('> 🔧 **read_file** `{"path":"a.txt"}`\n');
    expect(state.activity).toBe(true);
  });

  it("should omit empty arguments, shorten long ones and keep backticks from breaking the inline code", () => {
    const empty = project({ type: "tool.started", runId: "r", callId: "c", name: "git_read", args: {}, ts });
    const long = project({
      type: "tool.started",
      runId: "r",
      callId: "c",
      name: "x",
      args: { a: "y".repeat(300) },
      ts,
    });
    const ticks = project({ type: "tool.started", runId: "r", callId: "c", name: "x", args: { a: "`rm`" }, ts });

    expect(empty).toBe("> 🔧 **git_read**\n");
    expect(long).toMatch(/…`\n$/);
    expect(long!.length).toBeLessThan(160);
    expect(ticks).not.toContain("`rm`");
  });

  it("should say nothing about a tool that succeeded and flag one that failed", () => {
    const base = { type: "tool.completed", runId: "r", callId: "c", name: "read_file", ts } as const;

    expect(project({ ...base, result: { content: "x" } })).toBeNull();
    expect(project({ ...base, result: { error: "PathEscapeError", message: "outside workspace" } })).toBe(
      "> ⚠️ **read_file** failed: PathEscapeError: outside workspace\n",
    );
  });

  it("should set the answer off from earlier tool lines, but not lead with a blank line when there were none", () => {
    const done: NexumRunEvent = {
      type: "run.completed",
      runId: "r",
      output: { format: "markdown", content: "Done." },
      ts,
    };

    expect(project(done, { activity: true })).toBe("\nDone.");
    expect(project(done, { activity: false })).toBe("Done.");
  });

  it.each([
    [{ type: "run.failed", runId: "r", error: "boom", ts } as NexumRunEvent, "⚠️ The run failed: boom"],
    [{ type: "run.cancelled", runId: "r", ts } as NexumRunEvent, "⚠️ The run was cancelled."],
    [
      { type: "run.interrupted", runId: "r", reason: "restart", ts } as NexumRunEvent,
      "⚠️ The run was interrupted: restart",
    ],
  ])("should end an unsuccessful run with a readable line (%#)", (event, expected) => {
    expect(project(event)).toBe(expected);
  });

  it("should ignore thoughts, plans and model notices", () => {
    expect(project({ type: "thought", runId: "r", text: "hmm", ts })).toBeNull();
    expect(project({ type: "model.used", runId: "r", tier: "fast", model: "m", ts })).toBeNull();
  });
});

describe("SseStream", () => {
  function fakeResponse() {
    const written: string[] = [];
    const emitter = new EventEmitter();
    const res = Object.assign(emitter, {
      destroyed: false,
      writableEnded: false,
      writeHead: jest.fn(),
      write: (data: string) => written.push(data),
      end() {
        res.writableEnded = true;
      },
    });
    return { res: res as unknown as ServerResponse, written, raw: res };
  }
  const payloads = (written: string[]) =>
    written
      .filter((w) => w.startsWith("data: {"))
      .map(
        (w) =>
          JSON.parse(w.slice(6)) as {
            id: string;
            object: string;
            choices: Array<{ delta: object; finish_reason: unknown }>;
          },
      );

  it("should open with an assistant role chunk, carry text, and close with stop and [DONE]", () => {
    const { res, written, raw } = fakeResponse();
    const stream = new SseStream(res, "nexum-agent");

    stream.open("chatcmpl-1");
    stream.text("Hello");
    stream.finish();

    expect(raw.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "text/event-stream" }));
    const chunks = payloads(written);
    expect(chunks.map((c) => c.choices[0].delta)).toEqual([
      { role: "assistant", content: "" },
      { content: "Hello" },
      {},
    ]);
    expect(chunks.map((c) => c.choices[0].finish_reason)).toEqual([null, null, "stop"]);
    expect(new Set(chunks.map((c) => c.id))).toEqual(new Set(["chatcmpl-1"]));
    expect(chunks[0].object).toBe("chat.completion.chunk");
    expect(written.at(-1)).toBe("data: [DONE]\n\n");
  });

  it("should write nothing before it is opened or after it has finished", () => {
    const { res, written } = fakeResponse();
    const stream = new SseStream(res, "nexum-agent");

    stream.text("early");
    stream.finish();
    expect(written).toEqual([]);

    stream.open("id");
    stream.finish();
    const count = written.length;
    stream.text("late");
    stream.finish();
    expect(written).toHaveLength(count);
    expect(stream.isFinished).toBe(true);
  });

  it("should keep an idle connection alive with SSE comments", async () => {
    const { res, written } = fakeResponse();
    const stream = new SseStream(res, "nexum-agent", 10);

    stream.open("id");
    await new Promise((r) => setTimeout(r, 45));
    stream.finish();

    expect(written.filter((w) => w === ": keep-alive\n\n").length).toBeGreaterThanOrEqual(2);
  });

  it("should not write to a connection the client already closed", () => {
    const { res, written, raw } = fakeResponse();
    const stream = new SseStream(res, "nexum-agent");
    stream.open("id");
    const before = written.length;

    raw.destroyed = true;
    stream.text("lost");

    expect(written).toHaveLength(before);
  });
});
