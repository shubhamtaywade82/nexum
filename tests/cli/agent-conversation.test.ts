import { isolateModelSubsystems } from "../support/isolate-model-subsystems.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversation } from "../../src/cli/agent-conversation.js";
import { Agent } from "../../src/cli/agent.js";

isolateModelSubsystems();

describe("AgentConversation context pruning", () => {
  it("correctly prunes context once maxMessages limit is exceeded", () => {
    const convo = new AgentConversation();
    convo.init({ model: "test", workspaceRoot: ".", tier: "local" }, [], []);

    // Push 30 messages
    for (let i = 0; i < 30; i++) {
      convo.pushUserMessage(`Message ${i}`);
    }

    expect(convo.getMessages().length).toBe(31); // 1 system prompt + 30 user messages

    convo.pruneContext(25);

    const messages = convo.getMessages();
    // The last pushUserMessage ("Message 29") is both the tracked "current turn"
    // message AND already within the last-10 window, so nothing extra is preserved.
    expect(messages.length).toBe(12); // 1 system + 1 bypass notice + 10 recent
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("system");
    expect(messages[1].content).toContain("Bypassed 20 intermediate turns");
    expect(messages[2].content).toBe("Message 20");
    expect(messages[11].content).toBe("Message 29");
  });

  it("preserves the current turn's own request even after it ages out of the last-10 window", () => {
    const convo = new AgentConversation();
    convo.init({ model: "test", workspaceRoot: ".", tier: "local" }, [], []);

    // The task's own ask, then a long run of tool-turn chatter (assistant/tool
    // pairs) that pushes it well outside the last-10 messages.
    convo.pushUserMessage("implement the thing");
    for (let i = 0; i < 30; i++) {
      convo.pushAssistantMessage(`assistant step ${i}`);
      convo.pushToolResult(`tool result ${i}`);
    }

    convo.pruneContext(25);

    const messages = convo.getMessages();
    expect(messages.some((m) => m.role === "user" && m.content === "implement the thing")).toBe(true);
    // Preserved exactly once, not duplicated across repeated prunes.
    convo.pushAssistantMessage("more chatter");
    convo.pruneContext(25);
    const afterSecondPrune = convo.getMessages();
    expect(afterSecondPrune.filter((m) => m.role === "user" && m.content === "implement the thing")).toHaveLength(1);
  });

  it("does not duplicate the current turn's message when it's already within the recent window", () => {
    const convo = new AgentConversation();
    convo.init({ model: "test", workspaceRoot: ".", tier: "local" }, [], []);

    for (let i = 0; i < 20; i++) convo.pushUserMessage(`filler ${i}`);
    convo.pushUserMessage("the real ask");
    convo.pruneContext(25);

    const messages = convo.getMessages();
    expect(messages.filter((m) => m.role === "user" && m.content === "the real ask")).toHaveLength(1);
  });

  it("clears the tracked current-turn message on reset() and loadMessages(), without crashing a later prune", () => {
    const convo = new AgentConversation();
    convo.init({ model: "test", workspaceRoot: ".", tier: "local" }, [], []);
    convo.pushUserMessage("will be cleared");

    convo.reset();
    convo.loadMessages([
      { role: "system", content: "sys" },
      ...Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
    ]);

    expect(() => convo.pruneContext(25)).not.toThrow();
    expect(convo.getMessages().some((m) => m.content === "will be cleared")).toBe(false);
  });
});

describe("AgentConversation.loadMessages", () => {
  it("replaces the whole transcript", () => {
    const convo = new AgentConversation();
    convo.init({ model: "test", workspaceRoot: ".", tier: "local" }, [], []);
    convo.pushUserMessage("will be discarded");

    const restored = [
      { role: "system" as const, content: "old system prompt" },
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer" },
    ];
    convo.loadMessages(restored);

    expect(convo.getMessages()).toEqual(restored);
  });

  it("a stale loaded system prompt self-heals on the next refreshSystemPrompt call", () => {
    const convo = new AgentConversation();
    convo.loadMessages([
      { role: "system", content: "stale prompt" },
      { role: "user", content: "hi" },
    ]);

    convo.refreshSystemPrompt(
      { model: "test", workspaceRoot: ".", tier: "local", systemPrompt: "fresh prompt" },
      [],
      [],
    );

    expect(convo.getMessages()[0].content).toContain("fresh prompt");
    expect(convo.getMessages()[1]).toEqual({ role: "user", content: "hi" });
  });
});

// Priority no longer gates routing (see tests/cli/agent-capability-routing.test.ts —
// every turn attempts "quick" first regardless of content/priority); these two
// cases just confirm the first-candidate-in-catalog-order pick still works.
describe("Agent quick-model delegation picks the first catalog candidate", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-test-"));
    const encoder = new TextEncoder();
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/tags") || urlStr.includes("/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [{ name: "hermes3:latest" }, { name: "opencode:latest" }],
          }),
        };
      }

      const line = JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }) + "\n";
      let delivered = false;
      const reader = {
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: encoder.encode(line) };
        },
        releaseLock: () => {},
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { role: "assistant", content: "ok" }, done: true }),
        body: { getReader: () => reader },
      };
    });
  });

  it("delegates to the first quick candidate in catalog order", async () => {
    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "original-model" },
    });

    expect(agent.currentModel).toBe("original-model");

    await agent.runUserMessage("Write a README file");

    expect(agent.currentModel).toBe("original-model");
    // Verify it was switched to hermes during execution by checking the mock fetch history
    const calls = (globalThis.fetch as jest.Mock).mock.calls;
    const postCall = calls.find((c) => c[1] && c[1].body);
    expect(postCall).toBeDefined();
    const firstCallBody = JSON.parse(postCall![1].body);
    expect(firstCallBody.model).toBe("hermes3:latest");
  });

  it("delegates to the first quick candidate when catalog order differs", async () => {
    const encoder = new TextEncoder();
    (globalThis as any).fetch = jest.fn().mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/tags") || urlStr.includes("/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [{ name: "opencode:latest" }, { name: "hermes3:latest" }],
          }),
        };
      }

      const line = JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }) + "\n";
      let delivered = false;
      const reader = {
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: encoder.encode(line) };
        },
        releaseLock: () => {},
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ message: { role: "assistant", content: "ok" }, done: true }),
        body: { getReader: () => reader },
      };
    });

    const agent = new Agent({
      config: { workspaceRoot: tempDir, tier: "local", model: "original-model" },
    });

    expect(agent.currentModel).toBe("original-model");

    await agent.runUserMessage("Run unit tests");

    expect(agent.currentModel).toBe("original-model");
    const calls = (globalThis.fetch as jest.Mock).mock.calls;
    const postCall = calls.find((c) => c[1] && c[1].body);
    expect(postCall).toBeDefined();
    const firstCallBody = JSON.parse(postCall![1].body);
    expect(firstCallBody.model).toBe("opencode:latest");
  });
});

// Vision/reasoning escalation-target routing moved to
// tests/cli/agent-capability-routing.test.ts (turn 1 is always "quick" now;
// vision/reasoning only apply as the escalate_task handoff target).

describe("AgentConversation.buildSystemPrompt delegation addendum", () => {
  it("includes the local-delegation addendum for cloud-tier sessions with local delegation enabled", () => {
    const convo = new AgentConversation();
    const prompt = convo.buildSystemPrompt({ model: "gemma4:31b", workspaceRoot: ".", tier: "cloud" }, [], []);

    expect(prompt).toContain("delegate_to_local");
  });

  it("omits the addendum for local-tier sessions (escalation-triggered injection covers it there instead)", () => {
    const convo = new AgentConversation();
    const prompt = convo.buildSystemPrompt({ model: "qwen3.5:4b", workspaceRoot: ".", tier: "local" }, [], []);

    expect(prompt).not.toContain("delegate_to_local");
  });

  it("omits the addendum for cloud-tier sessions with local delegation explicitly disabled", () => {
    const convo = new AgentConversation();
    const prompt = convo.buildSystemPrompt(
      { model: "gemma4:31b", workspaceRoot: ".", tier: "cloud", enableLocalWorker: false },
      [],
      [],
    );

    expect(prompt).not.toContain("delegate_to_local");
  });
});

describe("AgentConversation skill injection", () => {
  const skill = { id: "s1", name: "Ruby style", body: "Always use frozen_string_literal." } as any;
  const cfg = { model: "test", workspaceRoot: ".", tier: "local" as const };

  // injectSkill is called for every activated skill on every runUserMessage,
  // so a skill active across ten turns used to append its full body ten times.
  it("injects a skill body once no matter how many turns activate it", () => {
    const convo = new AgentConversation();
    convo.init(cfg, [], []);

    for (let turn = 0; turn < 5; turn++) {
      convo.injectSkill(skill);
      convo.pushUserMessage(`turn ${turn}`);
    }

    const skillMessages = convo.getMessages().filter((m) => m.content.startsWith("Skill: Ruby style"));
    expect(skillMessages).toHaveLength(1);
  });

  it("re-injects after a reset, which clears the transcript", () => {
    const convo = new AgentConversation();
    convo.init(cfg, [], []);
    convo.injectSkill(skill);
    convo.reset();
    convo.init(cfg, [], []);
    convo.injectSkill(skill);

    expect(convo.getMessages().filter((m) => m.content.startsWith("Skill: "))).toHaveLength(1);
  });

  it("keeps skill bodies across a prune, since they are standing instructions", () => {
    const convo = new AgentConversation();
    convo.init(cfg, [], []);
    convo.injectSkill(skill);
    for (let i = 0; i < 40; i++) convo.pushUserMessage(`msg ${i}`);

    convo.pruneContext();

    expect(convo.getMessages().some((m) => m.content.startsWith("Skill: Ruby style"))).toBe(true);
  });
});

describe("AgentConversation pruning keeps tool results attached to their call", () => {
  // A role:"tool" message only makes sense directly after the assistant
  // message whose tool_calls produced it. Cutting on a fixed message count
  // could leave an orphaned tool result at the head of the window.
  it("never starts the retained window with an orphaned tool result", () => {
    const convo = new AgentConversation();
    convo.init({ model: "test", workspaceRoot: ".", tier: "local" }, [], []);

    convo.pushUserMessage("go");
    for (let i = 0; i < 15; i++) {
      convo.pushAssistantMessage("", [{ function: { name: "read_file", arguments: {} } }]);
      convo.pushToolResult(`result ${i}`);
    }

    convo.pruneContext();

    const messages = convo.getMessages();
    const firstConversational = messages.findIndex((m) => m.role !== "system");
    expect(messages[firstConversational].role).not.toBe("tool");
    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        expect(messages[i - 1].role).toBe("assistant");
      }
    }
  });
});
