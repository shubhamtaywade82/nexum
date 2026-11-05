import { AgentConversation } from "../../src/cli/agent-conversation.js";
import { capTools } from "../../src/cli/agent.js";
import { CompactionService } from "../../src/compaction/index.js";

describe("capTools", () => {
  const t = (name: string) => ({ name });
  it("keeps pinned tools and fills the rest in order", () => {
    const tools = [t("a"), t("b"), t("c"), t("escalate_task"), t("d")];
    expect(capTools(tools, 3, new Set(["escalate_task"])).map((x) => x.name)).toEqual(["a", "b", "escalate_task"]);
  });
  it("is a no-op under budget", () => {
    const tools = [t("a"), t("b")];
    expect(capTools(tools, 5, new Set())).toBe(tools);
  });
});

describe("AgentConversation.compactToBudget", () => {
  function longConversation(turns: number): AgentConversation {
    const c = new AgentConversation();
    c.loadMessages([{ role: "system", content: "SYSTEM PROMPT" }]);
    c.injectSkill({ id: "sk", name: "rails", body: "skill body", tags: [], version: "1" } as never);
    c.pushUserMessage("fix the auth bug");
    for (let i = 0; i < turns; i++) {
      c.pushAssistantMessage("", [{ function: { name: "read_file", arguments: { path: `f${i}.rb` } } }]);
      c.pushToolResult(`file ${i} `.repeat(200));
    }
    return c;
  }

  it("does nothing under budget", async () => {
    const c = longConversation(2);
    expect(await c.compactToBudget(100_000, new CompactionService())).toBe(0);
  });

  it("compacts to a small model's budget while keeping system prompt, skills, the request and tool adjacency", async () => {
    const c = longConversation(30);
    const before = c.getMessages().length;
    const removed = await c.compactToBudget(8_000, new CompactionService());
    const msgs = c.getMessages();
    expect(removed).toBeGreaterThan(0);
    expect(msgs.length).toBeLessThan(before);
    expect(msgs[0].content).toBe("SYSTEM PROMPT");
    expect(msgs.some((m) => m.content.startsWith("Skill: rails"))).toBe(true);
    expect(msgs.some((m) => m.content === "fix the auth bug")).toBe(true);
    expect(msgs.some((m) => m.content.startsWith("[Compacted History]"))).toBe(true);
    const firstTool = msgs.findIndex((m) => m.role === "tool");
    expect(msgs[firstTool - 1].role).toBe("assistant");
  });

  it("never compacts the live exchange when the system prompt alone exceeds the budget (regression)", async () => {
    const c = new AgentConversation();
    c.loadMessages([{ role: "system", content: "rules ".repeat(20_000) }]);
    c.pushUserMessage("show me the files");
    c.pushAssistantMessage("", [{ function: { name: "list_directory", arguments: { path: "." } } }]);
    c.pushToolResult("a.ts\nb.ts");
    expect(await c.compactToBudget(8_000, new CompactionService())).toBe(0);
    expect(c.getMessages()).toHaveLength(4);
  });
});
