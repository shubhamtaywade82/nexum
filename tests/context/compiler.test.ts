import { ContextCompiler, compileContext, type CompileInput, type CompileTool } from "../../src/context/compiler.js";
import { budgetForProfile, type ModelBudget } from "../../src/models/profiles/context-budget.js";
import { defaultConstraints, type ModelProfile } from "../../src/models/profiles/model-profile.js";

const small: ModelProfile = {
  id: "minicpm5:2b",
  provider: "ollama",
  tier: "local",
  capabilities: { reasoning: 0, coding: 0, vision: 0, toolCalling: 1, structuredOutput: 0.5, streaming: true },
  constraints: defaultConstraints(),
  legacyCapabilities: ["quick", "tools"],
};
const frontier: ModelProfile = { ...small, id: "frontier", tier: "cloud", legacyCapabilities: ["reasoning", "tools"] };

function budget(chars: number, toolBudget = 6): ModelBudget {
  return {
    modelId: "test",
    sizeClass: "small",
    contextTokens: Math.ceil(chars / 4),
    contextChars: chars,
    toolBudget,
    reasoning: "low",
    reserveOutputTokens: 0,
  };
}

const tool = (name: string, description: string): CompileTool => ({
  name,
  description,
  schema: { type: "function", function: { name, description, parameters: { type: "object", properties: {} } } },
});

const TOOLS: CompileTool[] = [
  tool("run_rspec", "Run RSpec tests for a Ruby spec file"),
  tool("read_file", "Read a file from the workspace"),
  tool("write_file", "Write a file in the workspace"),
  tool("search_code", "Search code in the repository"),
  tool("git_diff", "Show the git diff"),
  tool("browser_navigate", "Open a web page in the browser"),
  tool("docker", "Run a docker command"),
  tool("sqlite_query", "Query a sqlite database"),
  tool("github_pr", "Open a GitHub pull request"),
];

const BASE: CompileInput = {
  goal: "Fix the failing authentication spec",
  step: { id: "s3", objective: "Make auth_spec.rb pass", inputs: ["spec/auth_spec.rb"] },
  constraints: ["Do not modify the database schema"],
  successCriteria: ["bundle exec rspec spec/auth_spec.rb exits 0"],
};

describe("ContextCompiler", () => {
  it("always includes pinned sections in a fixed order", () => {
    const out = new ContextCompiler().compile(BASE, budget(8_000));
    expect(out.sections.map((s) => s.name)).toEqual(["task", "step", "constraints", "success_criteria"]);
    expect(out.promptBlock).toContain("<task_goal>\nFix the failing authentication spec\n</task_goal>");
    expect(out.promptBlock).toContain("objective: Make auth_spec.rb pass");
    expect(out.truncated).toBe(false);
  });

  it("caps tools to the budget, ranks by goal relevance and records drops", () => {
    const out = new ContextCompiler().compile(
      { ...BASE, goal: "Run the failing rspec test", tools: TOOLS },
      budget(20_000, 3),
    );
    expect(out.tools).toHaveLength(3);
    expect(out.tools[0]).toBe("run_rspec");
    expect(out.excluded.filter((e) => e.section === "tools")).toHaveLength(TOOLS.length - 3);
    expect(out.toolSchemaChars).toBeGreaterThan(0);
    expect(out.usedChars).toBe(out.promptBlock.length + out.toolSchemaChars);
  });

  it("keeps pinned tools even when they rank last", () => {
    const out = new ContextCompiler().compile(
      { ...BASE, tools: TOOLS, pinnedTools: ["sqlite_query"] },
      budget(20_000, 2),
    );
    expect(out.tools[0]).toBe("sqlite_query");
    expect(out.tools).toHaveLength(2);
  });

  it("dedupes tools by name", () => {
    const out = new ContextCompiler().compile({ ...BASE, tools: [TOOLS[0], TOOLS[0]] }, budget(20_000));
    expect(out.tools).toEqual(["run_rspec"]);
    expect(out.excluded).toContainEqual({ section: "tools", id: "run_rspec", reason: "duplicate tool name" });
  });

  it("orders state as failures → decisions → facts → artifacts → progress; verified facts first", () => {
    const out = new ContextCompiler().compile(
      {
        ...BASE,
        failures: ["old failure", "patched token check; spec still fails at line 48"],
        decisions: ["keep Devise"],
        facts: [
          { id: "f1", text: "authentication uses Devise sessions" },
          { id: "f2", text: "Redis is required", verified: true, source: "docs/arch.md" },
        ],
        artifacts: [{ uri: "artifact://test-results/456", summary: "37 passed, 2 failed", excerpt: "auth_spec.rb:48" }],
        completedSteps: ["inspect repo", "locate spec"],
        pendingSteps: ["commit"],
      },
      budget(20_000),
    );
    const names = out.sections.map((s) => s.name);
    expect(names.slice(4)).toEqual(["failures", "decisions", "facts", "artifacts", "progress"]);
    const failures = out.sections.find((s) => s.name === "failures")!;
    expect(failures.itemIds[0]).toBe("failure:1"); // most recent first
    expect(out.sections.find((s) => s.name === "facts")!.itemIds).toEqual(["f2", "f1"]);
    expect(out.promptBlock).toContain("[verified] Redis is required (source: docs/arch.md)");
    expect(out.promptBlock).toContain("artifact://test-results/456 — 37 passed, 2 failed");
    const progress = out.sections.find((s) => s.name === "progress")!;
    expect(progress.itemIds).toEqual(["pending:0", "done:1", "done:0"]);
  });

  it("packs evidence through ContextPacker without duplicating the goal", () => {
    const out = new ContextCompiler().compile(
      {
        ...BASE,
        evidence: {
          diagnostics: [{ path: "spec/auth_spec.rb", message: "expected 200 got 401", severity: "error" }],
          code: [{ path: "app/controllers/sessions_controller.rb", text: "def create; end", score: 1 }],
        },
      },
      budget(20_000),
    );
    const ev = out.sections.find((s) => s.name === "evidence")!;
    expect(ev.text).toContain("expected 200 got 401");
    expect(ev.text).not.toContain("<task_goal>");
    expect(ev.itemIds).not.toContain("goal");
    expect(out.promptBlock.match(/<task_goal>/g)).toHaveLength(1);
  });

  it("drops low-priority state first under a tight budget and stays within it", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, text: `fact number ${i} `.repeat(10) }));
    const b = budget(2_000);
    const out = new ContextCompiler().compile(
      { ...BASE, failures: ["spec fails at line 48"], facts: many, completedSteps: ["a", "b"] },
      b,
    );
    expect(out.truncated).toBe(true);
    expect(out.promptBlock).toContain("spec fails at line 48");
    expect(out.excluded.some((e) => e.section === "facts")).toBe(true);
    expect(out.usedChars).toBeLessThanOrEqual(b.contextChars);
  });

  it("truncates but never drops pinned sections when they exceed the budget", () => {
    const out = new ContextCompiler().compile(
      { ...BASE, goal: "goal ".repeat(400), constraints: ["c ".repeat(500)] },
      budget(600),
    );
    expect(out.truncated).toBe(true);
    expect(out.sections.map((s) => s.name)).toEqual(["task", "step", "constraints", "success_criteria"]);
    expect(out.promptBlock).toContain("…[truncated]");
  });

  it("compiles the same world state smaller for a small model than for a frontier model", () => {
    const facts = Array.from({ length: 300 }, (_, i) => ({
      id: `f${i}`,
      text: `authentication detail ${i} `.repeat(8),
    }));
    const input: CompileInput = { ...BASE, facts, tools: TOOLS };
    const s = compileContext(small, input);
    const f = compileContext(frontier, input);
    expect(s.budget.contextChars).toBeLessThan(f.budget.contextChars);
    expect(s.usedChars).toBeLessThanOrEqual(budgetForProfile(small).contextChars);
    expect(s.usedChars).toBeLessThan(f.usedChars);
    expect(s.tools.length).toBeLessThanOrEqual(6);
    expect(f.tools).toHaveLength(TOOLS.length);
  });

  it("is deterministic for identical input", () => {
    const input: CompileInput = {
      ...BASE,
      tools: TOOLS,
      facts: [
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ],
    };
    const c = new ContextCompiler();
    expect(c.compile(input, budget(4_000))).toEqual(c.compile(input, budget(4_000)));
  });

  it("validates input and options", () => {
    expect(() => new ContextCompiler().compile({ goal: "  " }, budget(1_000))).toThrow("goal is required");
    expect(() => new ContextCompiler({ evidenceShare: 1.5 })).toThrow(RangeError);
  });
});
