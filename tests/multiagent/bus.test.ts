/**
 * Tests for the agent message bus and coordination protocol.
 */
import { describe, it, expect } from "@jest/globals";
import { AgentMessageBus } from "../../src/multiagent/bus/message-bus.js";
import {
  assignTask,
  taskResult,
  isCoordinationMessage,
  ConversationTracker,
  COORD_MESSAGE_TYPES,
} from "../../src/multiagent/bus/coordination-protocol.js";

describe("AgentMessageBus", () => {
  it("delivers direct messages into registered inboxes", () => {
    const bus = new AgentMessageBus();
    const alice = bus.register("alice");
    bus.register("bob");

    const receipts = bus.send({ from: "bob", to: "alice", type: "chat", payload: "hi" });
    expect(receipts).toEqual([{ messageId: expect.any(String), to: "alice", delivered: true }]);
    expect(alice.size).toBe(1);
    expect(alice.pending()[0].payload).toBe("hi");
    expect(alice.pending()[0].from).toBe("bob");
    expect(alice.pending()[0].id).toMatch(/^msg_/);
  });

  it("rejects duplicate inbox registration and lists agents", () => {
    const bus = new AgentMessageBus();
    bus.register("alice");
    expect(() => bus.register("alice")).toThrow("already registered");
    expect(bus.agents()).toEqual(["alice"]);
    expect(bus.unregister("alice")).toBe(true);
    expect(bus.agents()).toEqual([]);
  });

  it("dead-letters messages to unregistered agents", () => {
    const bus = new AgentMessageBus();
    bus.register("alice");
    const receipts = bus.send({ from: "alice", to: "ghost", type: "chat", payload: {} });
    expect(receipts[0].delivered).toBe(false);
    expect(receipts[0].reason).toBe("no inbox registered");
  });

  it("broadcasts to everyone except the sender", () => {
    const bus = new AgentMessageBus();
    const alice = bus.register("alice");
    const bob = bus.register("bob");
    const carol = bus.register("carol");

    const receipts = bus.send({ from: "alice", to: "*", type: "announce", payload: { round: 2 } });
    expect(receipts).toHaveLength(2);
    expect(alice.size).toBe(0);
    expect(bob.size).toBe(1);
    expect(carol.size).toBe(1);
  });

  it("delivers topics to subscribers and reports empty topics", () => {
    const bus = new AgentMessageBus();
    const researcher = bus.register("researcher");
    const seen: string[] = [];
    bus.subscribeTopic("topic:research", { agentId: "researcher" });
    const unsubscribe = bus.subscribeTopic("topic:research", { listener: (m) => seen.push(m.type) });

    const receipts = bus.send({ from: "writer", to: "topic:research", type: "coord.question", payload: {} });
    expect(receipts[0].delivered).toBe(true);
    expect(researcher.size).toBe(1);
    expect(seen).toEqual(["coord.question"]);

    unsubscribe();
    expect(bus.send({ from: "writer", to: "topic:research", type: "x", payload: {} })[0].delivered).toBe(true); // inbox still subscribed

    expect(() => bus.subscribeTopic("research", { agentId: "researcher" })).toThrow("topic:");
  });

  it("supports async next() with waiters woken on delivery", async () => {
    const bus = new AgentMessageBus();
    const alice = bus.register("alice");
    const pending = alice.next(500);
    bus.send({ from: "bob", to: "alice", type: "wake", payload: 1 });
    const message = await pending;
    expect(message?.payload).toBe(1);

    const timedOut = await alice.next(20);
    expect(timedOut).toBeUndefined();
  });

  it("correlates request/response without polluting the inbox", async () => {
    const bus = new AgentMessageBus();
    const supervisor = bus.register("supervisor");
    const worker = bus.register("worker");
    worker.onMessage((message) => {
      if (message.type === "coord.task.assign") {
        bus.reply(message, "coord.task.result", { taskId: "t1", status: "done", output: "finished" });
      }
    });

    const reply = await bus.request(
      "supervisor",
      "worker",
      "coord.task.assign",
      {
        taskId: "t1",
        goal: "analyze the graph",
      },
      { timeoutMs: 1000 },
    );

    expect(reply.type).toBe("coord.task.result");
    expect((reply.payload as { output: string }).output).toBe("finished");
    expect(reply.inReplyTo).toBeDefined();
    expect(reply.correlationId).toBeDefined();
    // The reply was intercepted — the supervisor's queue stays empty.
    expect(supervisor.size).toBe(0);
  });

  it("request() rejects on delivery failure and timeout", async () => {
    const bus = new AgentMessageBus();
    bus.register("alive");
    await expect(bus.request("alive", "nobody", "x", {}, { timeoutMs: 10 })).rejects.toThrow("not delivered");

    bus.register("silent");
    await expect(bus.request("alive", "silent", "coord.question", {}, { timeoutMs: 20 })).rejects.toThrow("timed out");
  });

  it("keeps a bounded filterable history", () => {
    const bus = new AgentMessageBus({ historyLimit: 3 });
    bus.register("alice");
    bus.register("bob");
    for (let i = 0; i < 5; i++) {
      bus.send({ from: "bob", to: "alice", type: i % 2 === 0 ? "a" : "b", payload: i, conversationId: "task:t1" });
    }
    expect(bus.history().length).toBe(3); // bounded
    expect(bus.history({ type: "a" }).every((m) => m.type === "a")).toBe(true);
    expect(bus.history({ conversationId: "task:t1" })).toHaveLength(3);
    expect(bus.history({ from: "alice" })).toHaveLength(0);
  });
});

describe("coordination protocol", () => {
  it("builders produce typed envelopes with conversation threading", () => {
    const assign = assignTask("supervisor", "worker", { taskId: "t1", goal: "research the topic" });
    expect(assign.type).toBe("coord.task.assign");
    expect(assign.conversationId).toBe("task:t1");
    expect(isCoordinationMessage({ ...assign, id: "m", ts: 0 })).toBe(true);

    const result = taskResult("worker", "supervisor", {
      taskId: "t1",
      status: "done",
      output: "summary",
      artifacts: [{ artifactId: "art_1", version: 2 }],
    });
    expect(result.conversationId).toBe("task:t1");
    expect(isCoordinationMessage({ ...result, id: "m", ts: 0 })).toBe(true);
    expect(COORD_MESSAGE_TYPES).toContain("coord.decision");
  });

  it("ConversationTracker groups threads by conversationId", () => {
    const bus = new AgentMessageBus();
    const tracker = new ConversationTracker();
    bus.register("a");
    bus.register("b");

    bus.send({ from: "a", to: "b", type: "coord.task.assign", payload: {}, conversationId: "task:t1" });
    bus.send({ from: "b", to: "a", type: "coord.task.status", payload: {}, conversationId: "task:t1" });
    bus.send({ from: "a", to: "b", type: "chat", payload: {} }); // no conversation
    for (const message of bus.history()) tracker.append(message);

    expect(tracker.conversationIds()).toEqual(["task:t1"]);
    expect(tracker.thread("task:t1")).toHaveLength(2);
  });
});
