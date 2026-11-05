import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv } from "../../../src/domains/ci-healer/adapters/agent-env.js";
import { AgentRouter } from "../../../src/domains/ci-healer/adapters/agent-router.js";
import { NodeCommandRunner } from "../../../src/domains/ci-healer/adapters/command-runner.js";
import { GitCli } from "../../../src/domains/ci-healer/adapters/git-cli.js";
import { NexumRpcAgent } from "../../../src/domains/ci-healer/adapters/nexum-rpc.js";
import { HostRepoCommands } from "../../../src/domains/ci-healer/adapters/repo-commands.js";
import { Healer, selectScanWindow } from "../../../src/domains/ci-healer/application/healer.js";
import { LogSource } from "../../../src/domains/ci-healer/application/log-source.js";
import { parseConfig } from "../../../src/domains/ci-healer/config.js";
import { Digester } from "../../../src/domains/ci-healer/domain/digest.js";
import { LedgerStore } from "../../../src/domains/ci-healer/persistence/ledger-store.js";
import { createLogger } from "../../../src/domains/ci-healer/logger.js";
import { buildOriginAndClone, git, publish, type Fixture } from "./support/git-fixture.js";
import { FakeGitHub, ciRun } from "./support/fake-github.js";

const FIXTURE = join(process.cwd(), "tests/domains/ci-healer/fixtures/fake-nexum.mjs");
const REPO = "acme/app";
const AGENT_BRANCH = "fix/ci-main-111";
const NO_SHA = "0".repeat(40);

/**
 * Real git (bare origin, clone, worktrees, pushes), the real NexumRpcAgent client
 * behind an AgentRouter, and a protocol-compatible agent double. GitHub is the
 * in-memory fake. Repo commands run on the host here, which the config must
 * acknowledge. The Docker path is covered by unit tests of its arguments.
 */
describe("Healer end to end (real git, real rpc client, router, fake GitHub)", () => {
  let root: string;
  let fx: Fixture;
  let github: FakeGitHub;
  let lines: string[];
  let store: LedgerStore;
  let nexumLog: string;
  let mode: string;
  let overrides: Record<string, unknown>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "healer-it-"));
    fx = await buildOriginAndClone(root);
    github = new FakeGitHub();
    lines = [];
    nexumLog = join(root, "nexum.log");
    mode = "fix";
    overrides = {};
    store = new LedgerStore(join(root, "state.db"));
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  function healer(): Healer {
    const config = parseConfig({
      repo: { slug: REPO, dir: fx.work },
      state_file: join(root, "state.db"),
      kill_switch_file: join(root, "DISABLED"),
      worktree_base: join(root, "wt"),
      nexum_command: [process.execPath, FIXTURE],
      nexum_timeout_sec: 30,
      setup_timeout_sec: 30,
      verify_commands: ["test -f fixed.txt"],
      verify_timeout_sec: 30,
      sandbox: { mode: "host", acknowledge_host_execution: true },
      ...overrides,
    });
    const runner = new NodeCommandRunner();
    const log = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    const gitPort = new GitCli({
      command: runner,
      repoDir: fx.work,
      author: config.git_author,
      log,
      sleep: async () => undefined,
    });
    const nexum = new NexumRpcAgent({
      command: config.nexum_command,
      timeoutMs: 30_000,
      env: agentEnv({ ...process.env, FAKE_NEXUM: mode, FAKE_NEXUM_LOG: nexumLog }, ["FAKE_NEXUM", "FAKE_NEXUM_LOG"]),
      log,
    });
    const router = new AgentRouter({
      repository: REPO,
      candidates: [{ name: "nexum", agent: nexum }],
      store,
      log,
      policy: { rateLimitCooldownMs: 1_800_000, breakerThreshold: 3, breakerCooldownMs: 900_000 },
      now: () => new Date("2026-11-01T00:00:00Z"),
      reset: (workspace) => gitPort.resetWorktree(workspace),
    });
    const logs = new LogSource({ github, digester: new Digester(), log, byteCap: config.log_byte_cap });
    return new Healer({
      config,
      github,
      git: gitPort,
      agent: router,
      repo: new HostRepoCommands(runner),
      logs,
      store,
      log,
      now: () => new Date("2026-11-01T00:00:00Z"),
    });
  }

  const remoteSha = (branch: string) => git(["rev-parse", `refs/heads/${branch}`], fx.origin);

  const remoteBranchExists = async (branch: string): Promise<boolean> => {
    try {
      await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], fx.origin);
      return true;
    } catch {
      return false;
    }
  };

  const nexumInvocations = async (): Promise<number> => {
    try {
      return (await readFile(nexumLog, "utf8")).split("<<END>>").length - 1;
    } catch {
      return 0;
    }
  };

  /** Simulates CI failing on the default branch's current head. */
  const mainFailure = (sha: string, runId = 111) => {
    github.setBranchRun("main", ciRun(runId, { headBranch: "main", headSha: sha }));
  };

  /** Simulates CI failing on the agent branch's current head. */
  const failOnHead = (head: string, runId: number, pr = 1) => {
    github.setBranchRun(AGENT_BRANCH, ciRun(runId, { headBranch: AGENT_BRANCH, headSha: head }));
    github.setPull(pr, head);
  };

  describe("default-branch failure", () => {
    it("heals into a draft PR against main and leaves the main checkout untouched", async () => {
      const m1 = await remoteSha("main");
      mainFailure(m1);
      await healer().tick();

      expect(await remoteBranchExists(AGENT_BRANCH)).toBe(true);
      expect(await git(["show", `${AGENT_BRANCH}:fixed.txt`], fx.origin)).toContain("fixed");
      expect(github.created).toEqual([expect.objectContaining({ base: "main", head: AGENT_BRANCH })]);
      expect(store.getLineage(REPO, AGENT_BRANCH)).toMatchObject({ state: "PR_OPEN", prNumber: 1, attempts: 1 });
      expect(store.handledOutcome(REPO, "main", m1)).toBe("PR_OPEN");

      expect(await git(["status", "--porcelain"], fx.work)).toBe("");
      expect(await git(["branch", "--list", AGENT_BRANCH], fx.work)).toBe("");
      expect(await readdir(join(root, "wt"))).toEqual([]);
    });

    it("never re-invokes the agent for a failing commit it has already handled", async () => {
      mainFailure(await remoteSha("main"));
      await healer().tick();
      github.setPull(1, await remoteSha(AGENT_BRANCH));
      await healer().tick();

      expect(await nexumInvocations()).toBe(1);
      expect(github.created).toHaveLength(1);
    });

    it("gives the agent the failure digest inside a nonce-delimited, untrusted block", async () => {
      mainFailure(await remoteSha("main"));
      await healer().tick();
      const goal = await readFile(nexumLog, "utf8");
      expect(goal).toMatch(/<<<CI_LOG_BEGIN ([0-9a-f]+)\n[\s\S]*CI_LOG_END \1>>>/);
      expect(goal).toContain("Do not commit, push, or create branches");
    });
  });

  describe("verification and policy gates", () => {
    it("pushes nothing when verification fails without any edit", async () => {
      const m1 = await remoteSha("main");
      mode = "noop";
      mainFailure(m1);
      await healer().tick();

      expect(await remoteBranchExists(AGENT_BRANCH)).toBe(false);
      expect(github.created).toEqual([]);
      expect(store.handledOutcome(REPO, "main", m1)).toBe("NO_PATCH");
    });

    it("pushes nothing when the agent edited files but verification still fails", async () => {
      const m1 = await remoteSha("main");
      mode = "edit_unrelated";
      mainFailure(m1);
      await healer().tick();

      expect(await remoteBranchExists(AGENT_BRANCH)).toBe(false);
      expect(github.created).toEqual([]);
      expect(lines.join("\n")).toContain("verification failed");
    });

    it("refuses a patch touching CI workflow files even when verification passes", async () => {
      mode = "fix_forbidden";
      mainFailure(await remoteSha("main"));
      await healer().tick();

      expect(await remoteBranchExists(AGENT_BRANCH)).toBe(false);
      expect(lines.join("\n")).toContain("forbidden paths");
    });

    it("pushes nothing when the agent reports failure, and records the reason", async () => {
      mode = "fail";
      mainFailure(await remoteSha("main"));
      await healer().tick();

      expect(await remoteBranchExists(AGENT_BRANCH)).toBe(false);
      expect(lines.join("\n")).toContain("model unavailable");
    });

    it("treats an agent crash as a no-patch outcome, not a daemon crash", async () => {
      mode = "crash";
      const m1 = await remoteSha("main");
      mainFailure(m1);
      await expect(healer().tick()).resolves.toBeUndefined();
      expect(store.handledOutcome(REPO, "main", m1)).toBe("NO_PATCH");
    });

    it("marks the head ERRORED and pushes nothing when environment setup fails", async () => {
      const m1 = await remoteSha("main");
      overrides = { setup_commands: ["exit 1"] };
      mainFailure(m1);
      await healer().tick();

      expect(await nexumInvocations()).toBe(0);
      expect(await remoteBranchExists(AGENT_BRANCH)).toBe(false);
      expect(store.handledOutcome(REPO, "main", m1)).toBe("ERRORED");
      expect(lines.join("\n")).toContain("needs a human reset");
    });
  });

  describe("in-place iteration on agent PRs", () => {
    it("spends at most max_heal_attempts_per_lineage attempts, then stops and reports EXHAUSTED", async () => {
      mainFailure(await remoteSha("main"));
      await healer().tick();

      const heads = [await remoteSha(AGENT_BRANCH)];
      for (const attempt of [2, 3]) {
        failOnHead(heads[heads.length - 1], 200 + attempt);
        await healer().tick();
        heads.push(await remoteSha(AGENT_BRANCH));
        expect(heads[heads.length - 1]).not.toBe(heads[heads.length - 2]);
        expect(store.getLineage(REPO, AGENT_BRANCH)?.attempts).toBe(attempt);
      }

      failOnHead(heads[heads.length - 1], 299);
      await healer().tick();
      expect(store.getLineage(REPO, AGENT_BRANCH)?.state).toBe("EXHAUSTED");
      expect(await remoteSha(AGENT_BRANCH)).toBe(heads[heads.length - 1]);
      expect(await nexumInvocations()).toBe(3);
    });

    it("does not spend a second attempt on a head after a crash mid-heal", async () => {
      mainFailure(await remoteSha("main"));
      await healer().tick();
      const h1 = await remoteSha(AGENT_BRANCH);

      failOnHead(h1, 201);
      store.update(REPO, AGENT_BRANCH, { attempts: 2, lastAttemptedSha: h1 });
      store.transition(REPO, AGENT_BRANCH, "HEALING");
      await healer().tick();

      expect(store.getLineage(REPO, AGENT_BRANCH)?.state).toBe("PR_OPEN");
      expect(await nexumInvocations()).toBe(1);
    });

    it("moves to GREEN when the PR head is green, then CLOSED when merged", async () => {
      mainFailure(await remoteSha("main"));
      await healer().tick();
      const h1 = await remoteSha(AGENT_BRANCH);

      github.setBranchRun(AGENT_BRANCH, ciRun(301, { headBranch: AGENT_BRANCH, headSha: h1, conclusion: "success" }));
      github.setPull(1, h1);
      await healer().tick();
      expect(store.getLineage(REPO, AGENT_BRANCH)?.state).toBe("GREEN");

      github.setPull(1, h1, "MERGED");
      await healer().tick();
      expect(store.getLineage(REPO, AGENT_BRANCH)?.state).toBe("CLOSED");
    });

    it("waits while checks are still running on the current head", async () => {
      mainFailure(await remoteSha("main"));
      await healer().tick();
      const h1 = await remoteSha(AGENT_BRANCH);

      github.setBranchRun(
        AGENT_BRANCH,
        ciRun(401, { headBranch: AGENT_BRANCH, headSha: h1, status: "in_progress", conclusion: "" }),
      );
      github.setPull(1, h1);
      await healer().tick();

      expect(store.getLineage(REPO, AGENT_BRANCH)?.state).toBe("PR_OPEN");
      expect(await nexumInvocations()).toBe(1);
    });
  });

  describe("branch-head discovery", () => {
    it("ignores failures on runs whose SHA is not the current branch head, and says so", async () => {
      github.setBranchRun("main", ciRun(150, { headBranch: "main", headSha: NO_SHA }));
      await healer().tick();

      expect(await nexumInvocations()).toBe(0);
      expect(github.created).toEqual([]);
      expect(lines.join("\n")).toContain("no runs report the branch head");
    });

    it("allows only one open agent lineage per base branch", async () => {
      mainFailure(await remoteSha("main"));
      await healer().tick();
      github.setPull(1, await remoteSha(AGENT_BRANCH));

      const m2 = await publish(fx.seed, { branch: "main", file: "app.rb", content: "v2\n" });
      mainFailure(m2, 112);
      await healer().tick();

      expect(await nexumInvocations()).toBe(1);
      expect(github.created).toHaveLength(1);
    });

    it("heals a failing feature branch that has an open PR, targeting that branch", async () => {
      const f1 = await publish(fx.seed, { branch: "feature/x", file: "lib/x.rb", content: "x\n" });
      github.openPrs = [
        {
          number: 7,
          headRefName: "feature/x",
          baseRefName: "main",
          headRefOid: f1,
          isCrossRepository: false,
          isDraft: false,
        },
      ];
      github.setBranchRun("feature/x", ciRun(301, { headBranch: "feature/x", headSha: f1 }));
      await healer().tick();

      expect(await remoteBranchExists("fix/ci-feature-x-301")).toBe(true);
      expect(github.created).toEqual([expect.objectContaining({ base: "feature/x", head: "fix/ci-feature-x-301" })]);
    });

    it("never scans a branch without an open PR, even when it is failing", async () => {
      const o1 = await publish(fx.seed, { branch: "orphan", file: "o.rb", content: "o\n" });
      github.setBranchRun("orphan", ciRun(302, { headBranch: "orphan", headSha: o1 }));
      await healer().tick();

      expect(await nexumInvocations()).toBe(0);
    });
  });

  describe("dry run", () => {
    it("reports the plan without writing ledger, branches, or PRs", async () => {
      const m1 = await remoteSha("main");
      mainFailure(m1);
      const planned = await healer().plan();

      expect(planned.join("\n")).toContain(`would heal branch=main run=111 base=main head=${m1.slice(0, 7)}`);
      expect(await remoteBranchExists(AGENT_BRANCH)).toBe(false);
      expect(await nexumInvocations()).toBe(0);
      expect(store.recentEvents(REPO, 10)).toEqual([]);
    });
  });

  describe("agent environment", () => {
    it("the agent process sees its model configuration but never GH_TOKEN", async () => {
      const agent = new NexumRpcAgent({
        command: [process.execPath, FIXTURE],
        timeoutMs: 30_000,
        env: agentEnv(
          { PATH: process.env.PATH, HOME: root, GH_TOKEN: "leak-me", OLLAMA_API_KEY: "model-key", FAKE_NEXUM: "env" },
          ["FAKE_NEXUM"],
        ),
        log: createLogger({ sink: () => undefined }),
      });
      const outcome = await agent.execute({ workspace: fx.work, goal: "report credentials" });
      expect(outcome.output).toBe("GH=absent OLLAMA=model-key");
    });
  });
});

describe("selectScanWindow", () => {
  it("always includes the default branch first", () => {
    expect(selectScanWindow("main", ["feat/a", "feat/b"], undefined, 5)).toEqual(["main", "feat/a", "feat/b"]);
  });

  it("resumes after the cursor and wraps around, so every PR is reached", () => {
    const branches = ["feat/a", "feat/b", "feat/c", "feat/d"];
    expect(selectScanWindow("main", branches, "feat/b", 3)).toEqual(["main", "feat/c", "feat/d"]);
    expect(selectScanWindow("main", branches, "feat/d", 3)).toEqual(["main", "feat/a", "feat/b"]);
  });

  it("restarts from the beginning when the cursor branch has closed", () => {
    expect(selectScanWindow("main", ["feat/a", "feat/b"], "gone", 5)).toEqual(["main", "feat/a", "feat/b"]);
  });

  it("never exceeds the budget, and still scans the default branch with a budget of one", () => {
    expect(selectScanWindow("main", ["feat/a", "feat/b"], undefined, 1)).toEqual(["main"]);
  });
});

describe("branch scan cursor", () => {
  it("advances across ticks so a large PR set is scanned in rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-"));
    const ledger = new LedgerStore(join(dir, "state.db"));
    try {
      expect(ledger.scanCursor(REPO)).toBeUndefined();
      ledger.setScanCursor(REPO, "feat/b");
      ledger.setScanCursor(REPO, "feat/c");
      expect(ledger.scanCursor(REPO)).toBe("feat/c");
    } finally {
      ledger.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
