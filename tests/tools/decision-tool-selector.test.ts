import { Tool } from "../../src/tools/tool.js";
import {
  DecisionToolSelector,
  ToolDomain,
  DOMAINS,
  DOMAIN_TOOL_NAMES,
} from "../../src/tools/decision-tool-selector.js";
import { FakeDecisionGateway } from "../../src/models/decision/fake-gateway.js";
import { DecisionPolicyError, DecisionTransportError } from "../../src/models/decision/errors.js";
import type { DecisionPolicy } from "../../src/models/decision/decision-policy.js";

class MockTool extends Tool {
  constructor(
    private readonly _name: string,
    private readonly _desc: string = "",
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

// The full set of tools the deterministic domain→tool mapping knows about.
const ALL_TOOLS: Tool[] = [
  new MockTool("read_file", "Read a file", ["File System"], ["read", "open"]),
  new MockTool("write_file", "Write a file", ["File System"], ["write"]),
  new MockTool("patch_file", "Patch a file", ["File System"], ["patch"]),
  new MockTool("run_shell", "Run a shell command", ["Terminal"], ["shell", "execute"]),
  new MockTool("git_status", "Git status", ["Git"], ["git", "status"]),
  new MockTool("git_diff", "Git diff", ["Git"], ["git", "diff"]),
  new MockTool("git_commit", "Git commit", ["Git"], ["git", "commit"]),
  new MockTool("github_pr", "Open a GitHub PR", ["GitHub"], ["github", "pr"]),
  new MockTool("rails_console", "Rails console", ["Rails"], ["rails", "console"]),
  new MockTool("db_query", "Database query", ["Database"], ["sql", "query"]),
];

function domainsFor(tools: Tool[]): string[] {
  return DOMAINS.filter((d) => DOMAIN_TOOL_NAMES[d].some((name) => tools.some((t) => t.name === name)));
}

describe("DecisionToolSelector — clear heuristic stage", () => {
  it("uses the heuristic directly for a high-confidence filesystem request (no System One call)", async () => {
    let called = 0;
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
      onDecide: () => called++,
    });
    const selector = new DecisionToolSelector({ decisionGateway: fake, decisionModel: "m" });
    const selected = await selector.selectTools("read a file from disk", [], ALL_TOOLS);

    // Heuristic won — System One was never consulted.
    expect(called).toBe(0);
    // Filesystem domain maps to deterministic tool names.
    expect(selected.map((t) => t.name)).toContain("read_file");
  });

  it("uses the heuristic directly for a clear shell-only request", async () => {
    let called = 0;
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "shell" } },
      onDecide: () => called++,
    });
    const selector = new DecisionToolSelector({ decisionGateway: fake, decisionModel: "m" });
    const selected = await selector.selectTools("run a shell command to grep logs", [], ALL_TOOLS);
    expect(called).toBe(0);
    expect(selected.map((t) => t.name)).toContain("run_shell");
  });
});

describe("DecisionToolSelector — ambiguous prompt reaches System One", () => {
  it("calls System One when no domain heuristic is high-confidence", async () => {
    let called = 0;
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: {
          selected: "filesystem",
          probabilities: { filesystem: 0.9, shell: 0.05, git: 0.05 },
        },
      },
      onDecide: () => called++,
    });
    const selector = new DecisionToolSelector({ decisionGateway: fake, decisionModel: "m" });

    // "do something complex" matches no domain keyword strongly.
    const selected = await selector.selectTools("do something complex", [], ALL_TOOLS);

    expect(called).toBe(1);
    expect(selected.map((t) => t.name)).toContain("read_file");
  });

  it("returns NO_TOOLS when every System One probability is below the policy threshold", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: {
          probabilities: { filesystem: 0.1, shell: 0.1, git: 0.1 },
        },
      },
    });
    const policy: DecisionPolicy = { minimumProbability: 0.5, maxDomains: 5 };
    const selector = new DecisionToolSelector({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: policy,
    });

    const selected = await selector.selectTools("do something complex", [], ALL_TOOLS);
    expect(selected).toEqual([]);
  });

  it("returns NO_TOOLS for an 'explain concept' prompt even when System One would otherwise engage", async () => {
    // "what is dependency injection" should not select an operational tool.
    // The heuristic sees zero keyword overlap → ambiguous → System One is
    // consulted, but the policy threshold converts a low-probability answer
    // to NO_TOOLS, which is the desired outcome.
    const fake = new FakeDecisionGateway({
      decisions: { domain: { probabilities: { filesystem: 0.05, shell: 0.05 } } },
    });
    const selector = new DecisionToolSelector({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 },
    });

    const selected = await selector.selectTools("what is dependency injection?", [], ALL_TOOLS);
    expect(selected).toEqual([]);
  });
});

describe("DecisionToolSelector — domain→tool mapping is deterministic and bounded", () => {
  it("maps a single selected domain to its deterministic tool set, intersected with available tools", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: {
          probabilities: { filesystem: 0.9, shell: 0.05, git: 0.05 },
        },
      },
    });
    const selector = new DecisionToolSelector({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 },
    });

    const selected = await selector.selectTools("do something complex", [], ALL_TOOLS);
    // Only filesystem cleared the threshold.
    expect(selected.map((t) => t.name).sort()).toEqual(["patch_file", "read_file", "write_file"]);
  });

  it("bounds the selected domains to maxDomains", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: {
          probabilities: {
            filesystem: 0.9,
            shell: 0.85,
            git: 0.8,
            github: 0.75,
            rails: 0.7,
            database: 0.65,
          },
        },
      },
    });
    const selector = new DecisionToolSelector({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 2 },
    });

    const selected = await selector.selectTools("do something complex", [], ALL_TOOLS);
    const selectedDomains = domainsFor(selected).sort();
    // Only the top 2 domains (filesystem + shell) by probability.
    expect(selectedDomains).toEqual(["filesystem", "shell"]);
  });
});

describe("DecisionToolSelector — security invariants", () => {
  it("System One cannot invent tool names: a selected domain with no matching available tools is dropped silently", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: {
          probabilities: {
            // System One picks "deployment" with high probability. There
            // are no deployment tools in the available set — the result
            // must be empty (NO_TOOLS), not an invented tool.
            deployment: 0.95,
          },
        },
      },
    });
    const selector = new DecisionToolSelector({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 },
    });

    const selected = await selector.selectTools("do something complex", [], ALL_TOOLS);
    expect(selected).toEqual([]);
  });

  it("System One cannot invent domains: an out-of-band selected id falls back to the heuristic result (NO_TOOLS for an ambiguous prompt)", async () => {
    // The DecisionToolSelector constructs the request with a fixed domain
    // set as the choices. The gateway (real or fake) rejects out-of-band
    // ids — the FakeDecisionGateway throws DecisionProtocolError because
    // the selected id "super_search_repo" is not in the declared choices.
    // The selector catches the DecisionError and falls back to the
    // heuristic result (which is [] for an ambiguous prompt). System One
    // cannot escape its bounded choice set, and a malformed System One
    // answer does not break the agent — it degrades to heuristic mode.
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: { selected: "super_search_repo" },
      },
    });
    const selector = new DecisionToolSelector({
      decisionGateway: fake,
      decisionModel: "m",
    });
    const selected = await selector.selectTools("do something complex", [], ALL_TOOLS);
    expect(selected).toEqual([]);
  });

  it("System One cannot bypass the ApprovalBroker / tool policy / execution / cloud — selector only returns Tool[]", async () => {
    // The DecisionToolSelector's return type is `Tool[]`. It has no
    // execute/approve/sandbox/cloud fields. The downstream executor (not
    // this selector) is what consults the ApprovalBroker, tool policy,
    // sandbox, and tier — System One only changes which tools are
    // surfaced. This test exists as a contract lock: the selector cannot
    // by construction force execution or call cloud chat.
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
    });
    const selector = new DecisionToolSelector({ decisionGateway: fake, decisionModel: "m" });
    const result = await selector.selectTools("read the file", [], ALL_TOOLS);
    for (const t of result) {
      // Tools returned are inert Tool instances; calling them is the
      // executor's job, not the selector's.
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      // The Tool contract requires call() to be present and async.
      expect(typeof t.call).toBe("function");
    }
  });
});

describe("DecisionToolSelector — fallback behavior", () => {
  it("falls back to the heuristic result when System One throws a transport error", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
      failWith: new DecisionTransportError("ECONNREFUSED"),
    });
    const selector = new DecisionToolSelector({ decisionGateway: fake, decisionModel: "m" });
    // The prompt is ambiguous so heuristic returns nothing; the System One
    // call throws DecisionTransportError → selector catches and returns
    // the heuristic fallback (which is []).
    const selected = await selector.selectTools("do something complex", [], ALL_TOOLS);
    expect(selected).toEqual([]);
  });

  it("falls back to the heuristic result when System One throws a policy error", async () => {
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
      failWith: new DecisionPolicyError("threshold not met", "domain"),
    });
    const selector = new DecisionToolSelector({ decisionGateway: fake, decisionModel: "m" });
    const selected = await selector.selectTools("do something complex", [], ALL_TOOLS);
    expect(selected).toEqual([]);
  });

  it("falls back to the heuristic result when no decisionGateway is configured (Decision Plane disabled)", async () => {
    // When enableDecision=false, the DecisionToolSelector receives no
    // gateway. It must still work — it just degrades to pure heuristic
    // mode (no System One call ever). This is the backward-compat path.
    const selector = new DecisionToolSelector({ decisionModel: "m" });
    const selected = await selector.selectTools("read the file from disk", [], ALL_TOOLS);
    expect(selected.map((t) => t.name)).toContain("read_file");
  });

  it("bounds the final tool list to maxActiveTools", async () => {
    const fake = new FakeDecisionGateway({
      decisions: {
        domain: {
          probabilities: { filesystem: 0.9, shell: 0.9 },
        },
      },
    });
    const selector = new DecisionToolSelector({
      decisionGateway: fake,
      decisionModel: "m",
      decisionPolicy: { minimumProbability: 0.5, maxDomains: 5 },
      maxActiveTools: 2,
    });
    const selected = await selector.selectTools("do something complex", [], ALL_TOOLS);
    expect(selected.length).toBeLessThanOrEqual(2);
  });
});

describe("DecisionToolSelector — batches one System One call for all domains", () => {
  it("issues a single decide() call with all domains as a single question's choices (not one per domain)", async () => {
    const seenRequests: Array<{ questions: Array<{ id: string; choices?: Array<{ id: string }> }> }> = [];
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
      onDecide: (req) => seenRequests.push(req),
    });
    const selector = new DecisionToolSelector({ decisionGateway: fake, decisionModel: "m" });

    await selector.selectTools("do something complex", [], ALL_TOOLS);

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].questions).toHaveLength(1);
    // The single question's choices list every domain the selector knows.
    const choices = seenRequests[0].questions[0].choices ?? [];
    const choiceIds = choices.map((c) => c.id);
    expect(choiceIds.sort()).toEqual([...DOMAINS].sort());
  });

  it("uses a compact context (no full tool descriptions, no repository dump)", async () => {
    let seenContext: string | undefined;
    const fake = new FakeDecisionGateway({
      decisions: { domain: { selected: "filesystem" } },
      onDecide: (req) => {
        seenContext = req.context;
      },
    });
    const selector = new DecisionToolSelector({ decisionGateway: fake, decisionModel: "m" });

    await selector.selectTools("do something complex", [], ALL_TOOLS);

    // Compact: a few hundred bytes, not many KB.
    expect(seenContext!.length).toBeLessThan(4000);
  });
});

describe("DecisionToolSelector — domains catalog", () => {
  it("DOMAINS exposes the bounded domain set", () => {
    expect(DOMAINS).toContain("filesystem");
    expect(DOMAINS).toContain("shell");
    expect(DOMAINS).toContain("git");
    expect(DOMAINS).toContain("github");
    expect(DOMAINS).toContain("rails");
    expect(DOMAINS).toContain("database");
    expect(DOMAINS).toContain("browser");
    expect(DOMAINS).toContain("lsp");
    expect(DOMAINS).toContain("documentation");
    expect(DOMAINS).toContain("testing");
    expect(DOMAINS).toContain("package-management");
    expect(DOMAINS).toContain("deployment");
  });

  it("every ToolDomain maps to a non-empty deterministic tool-name list", () => {
    for (const d of DOMAINS) {
      const tools = DOMAIN_TOOL_NAMES[d as ToolDomain];
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) expect(typeof t).toBe("string");
    }
  });
});
