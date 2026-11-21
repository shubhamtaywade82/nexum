import { Tool } from "../../src/tools/tool.js";
import { DynamicToolSelector } from "../../src/tools/discovery.js";
import { Provider } from "../../src/models/adapters/provider.js";

class MockTool extends Tool {
  constructor(
    private readonly _name: string,
    private readonly _desc: string,
    private readonly _caps: string[] = [],
    private readonly _tags: string[] = [],
  ) {
    super();
  }

  get name() {
    return this._name;
  }

  get description() {
    return this._desc;
  }

  override get capabilities() {
    return this._caps;
  }

  override get tags() {
    return this._tags;
  }

  async call() {
    return {};
  }
}

describe("DynamicToolSelector", () => {
  const fileTool = new MockTool("read_file", "Read a file", ["File System"], ["read", "open"]);
  const shellTool = new MockTool("run_shell", "Run terminal command", ["Terminal"], ["sh", "execute"]);
  const gitTool = new MockTool("git", "Run git operations", ["Git"], ["commit", "status"]);
  const tools = [fileTool, shellTool, gitTool];

  describe("Heuristic Selection", () => {
    it("matches tools by name tokens", async () => {
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("read something from a file", [], tools);

      expect(selected.map((t) => t.name)).toContain("read_file");
    });

    it("matches tools by tags", async () => {
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("check the status of the repository", [], tools);

      expect(selected.map((t) => t.name)).toContain("git");
    });

    it("matches tools by capabilities", async () => {
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("open terminal and run a script", [], tools);

      expect(selected.map((t) => t.name)).toContain("run_shell");
    });

    it("does not surface read_file/run_shell when nothing in the message matches anything", async () => {
      // Regression test: the baseline boost for these tools used to apply
      // unconditionally, so even a bare greeting with zero real signal would
      // still surface them as "active tools" and an eager model would use
      // one just because it was offered.
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("hi", [], tools);

      expect(selected.map((t) => t.name)).not.toContain("read_file");
      expect(selected.map((t) => t.name)).not.toContain("run_shell");
    });

    it("still boosts read_file/run_shell above the floor once they have some real signal", async () => {
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("read something from a file", [], tools);

      expect(selected.map((t) => t.name)).toContain("read_file");
    });

    it("does not accumulate score for a description word repeated multiple times", async () => {
      // Regression test: pre-fix, each raw occurrence of a matching word in
      // the description added +0.5 uncapped, so a description repeating one
      // shared word 3x scored 1.5 (clears the >0.5 filter) purely from
      // repetition, not topical relevance. Deduped, it's one +0.5 hit — 0.5,
      // which does not clear the filter.
      const repeats = new MockTool("noisy_tool", "process data data data quickly", [], []);
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("data", [], [repeats]);

      expect(selected.map((t) => t.name)).not.toContain("noisy_tool");
    });

    it("does not select a tool on stopword overlap alone, even with several matching filler words", async () => {
      // Regression test for the real bug this fix targets: this tool shares
      // zero real content words with the query, only "the"/"and"/"this" —
      // pre-fix this scored 2.0 (three uncapped filler-word hits) and was a
      // false-positive "active tool" for a completely unrelated question.
      const unrelated = new MockTool("some_tool", "Handles the request and the response for this task", [], []);
      const selector = new DynamicToolSelector({ mode: "heuristic" });
      const selected = await selector.selectTools("what is the difference between this and that", [], [unrelated]);

      expect(selected.map((t) => t.name)).not.toContain("some_tool");
    });

    it("passes a small closed tool environment through even when nothing scores", async () => {
      // Regression test for the agent-driven benchmark bug: a case replaces
      // every tool with its own 1-3 scripted tools (lookup_user etc.), whose
      // names/descriptions score 0 against keyword heuristics — pre-fix the
      // selector returned [] and the model never saw the case's tools, so
      // every agentic case failed with "never called <tool>". With
      // closedEnvironment the pool itself is the selection.
      const lookup = new MockTool("lookup_user", "Look up an internal user by name", [], []);
      const balance = new MockTool("get_balance", "Get the account balance for an id", [], []);
      const selector = new DynamicToolSelector({ mode: "heuristic", closedEnvironment: true });
      const selected = await selector.selectTools(
        "What is the account balance for user 'jdoe'?",
        [],
        [lookup, balance],
      );

      expect(selected.map((t) => t.name).sort()).toEqual(["get_balance", "lookup_user"]);
    });

    it("a closed environment with a single tool passes it through regardless of scoring", async () => {
      const escalate = new MockTool("escalate_task", "Escalate the current task to a larger model", [], []);
      const selector = new DynamicToolSelector({ mode: "llm", closedEnvironment: true }); // even without a provider (falls back)
      const selected = await selector.selectTools("hello", [], [escalate]);

      expect(selected.map((t) => t.name)).toEqual(["escalate_task"]);
    });

    it("closedEnvironment does NOT passthrough larger pools (score-based selection retained)", async () => {
      const noisy = new MockTool("zzz_irrelevant", "Totally unrelated thing", [], []);
      const pool = [fileTool, shellTool, gitTool, noisy];
      const selector = new DynamicToolSelector({ mode: "heuristic", closedEnvironment: true });
      const selected = await selector.selectTools("nothing at all matches any tool here", [], pool);

      expect(selected.map((t) => t.name)).toEqual([]);
    });
  });

  describe("LLM Selection", () => {
    it("calls provider.chat and returns parsed tools", async () => {
      const mockProvider = {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: '["read_file"]',
          },
        }),
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "llm", provider: mockProvider });
      const selected = await selector.selectTools("open file", [], tools);

      expect(mockProvider.chat).toHaveBeenCalled();
      expect(selected.length).toBe(1);
      expect(selected[0].name).toBe("read_file");
    });

    it("strips markdown json blocks from provider response", async () => {
      const mockProvider = {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: '```json\n["run_shell"]\n```',
          },
        }),
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "llm", provider: mockProvider });
      const selected = await selector.selectTools("run cmd", [], tools);

      expect(selected.length).toBe(1);
      expect(selected[0].name).toBe("run_shell");
    });

    it("falls back to heuristic if provider chat throws", async () => {
      const mockProvider = {
        chat: jest.fn().mockRejectedValue(new Error("Ollama down")),
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "llm", provider: mockProvider });
      const selected = await selector.selectTools("status of git", [], tools);

      expect(selected.map((t) => t.name)).toContain("git");
    });

    it("uses the chat override instead of provider.chat when given", async () => {
      const mockProvider = { chat: jest.fn() } as unknown as Provider;
      const chatOverride = jest.fn().mockResolvedValue({ message: { content: '["read_file"]' } });

      const selector = new DynamicToolSelector({ mode: "llm", provider: mockProvider, chat: chatOverride });
      const selected = await selector.selectTools("open file", [], tools);

      expect(chatOverride).toHaveBeenCalled();
      expect(mockProvider.chat).not.toHaveBeenCalled();
      expect(selected.map((t) => t.name)).toContain("read_file");
    });

    it("works with only a chat override and no provider at all", async () => {
      const chatOverride = jest.fn().mockResolvedValue({ message: { content: '["git"]' } });

      const selector = new DynamicToolSelector({ mode: "llm", chat: chatOverride });
      const selected = await selector.selectTools("status of git", [], tools);

      expect(selected.map((t) => t.name)).toContain("git");
    });

    it("falls back to heuristic if the chat override throws", async () => {
      const chatOverride = jest.fn().mockRejectedValue(new Error("quick model unreachable"));

      const selector = new DynamicToolSelector({ mode: "llm", chat: chatOverride });
      const selected = await selector.selectTools("status of git", [], tools);

      expect(selected.map((t) => t.name)).toContain("git");
    });
  });

  describe("Hybrid Selection", () => {
    it("skips LLM call if heuristic scores are high enough", async () => {
      const mockProvider = {
        chat: jest.fn(),
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "hybrid", provider: mockProvider });
      const selected = await selector.selectTools("read_file the config", [], tools);

      expect(mockProvider.chat).not.toHaveBeenCalled();
      expect(selected.map((t) => t.name)).toContain("read_file");
    });

    it("calls LLM if heuristic scores are low or ambiguous", async () => {
      const mockProvider = {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: '["git"]',
          },
        }),
      } as unknown as Provider;

      const selector = new DynamicToolSelector({ mode: "hybrid", provider: mockProvider });
      // "do something" is very ambiguous and won't hit high scores for file/shell
      const selected = await selector.selectTools("do something complex", [], tools);

      expect(mockProvider.chat).toHaveBeenCalled();
      expect(selected.map((t) => t.name)).toContain("git");
    });
  });
});
