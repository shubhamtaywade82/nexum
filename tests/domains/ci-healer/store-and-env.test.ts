import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, repoCommandEnv } from "../../../src/domains/ci-healer/adapters/agent-env.js";
import { NodeCommandRunner } from "../../../src/domains/ci-healer/adapters/command-runner.js";
import { CommandError, StateError, TimeoutError } from "../../../src/domains/ci-healer/errors.js";
import { LedgerStore } from "../../../src/domains/ci-healer/persistence/ledger-store.js";

describe("LedgerStore", () => {
  let dir: string;
  let store: LedgerStore;
  const REPO = "acme/app";
  let clock: Date;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ledger-spec-"));
    clock = new Date("2026-11-01T00:00:00Z");
    store = new LedgerStore(join(dir, "state.db"), () => clock);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const addFix = (name = "fix/ci-main-1", pr = 1) =>
    store.addLineage(REPO, {
      healBranch: name,
      baseBranch: "main",
      originRunId: 1,
      originSha: "a".repeat(40),
      prNumber: pr,
      attempts: 1,
    });

  it("persists lineages across reopen and records an audit event for each change", () => {
    addFix();
    store.close();
    store = new LedgerStore(join(dir, "state.db"));
    expect(store.getLineage(REPO, "fix/ci-main-1")).toMatchObject({ state: "PR_OPEN", prNumber: 1, attempts: 1 });
    expect(store.recentEvents(REPO, 5).map((event) => event.kind)).toContain("lineage_opened");
  });

  it("rejects illegal transitions instead of applying them", () => {
    addFix();
    store.transition(REPO, "fix/ci-main-1", "CLOSED", { pr_state: "MERGED" });
    expect(() => store.transition(REPO, "fix/ci-main-1", "PR_OPEN")).toThrow(/illegal transition CLOSED -> PR_OPEN/);
  });

  it("resumes a crash-interrupted HEALING lineage as PR_OPEN without changing its attempts", () => {
    addFix();
    store.update(REPO, "fix/ci-main-1", { attempts: 2, lastAttemptedSha: "b".repeat(40) });
    store.transition(REPO, "fix/ci-main-1", "HEALING");
    expect(store.recoverInterrupted(REPO)).toEqual(["fix/ci-main-1"]);
    expect(store.getLineage(REPO, "fix/ci-main-1")).toMatchObject({ state: "PR_OPEN", attempts: 2 });
  });

  it("counts only non-closed lineages against a base branch", () => {
    addFix("fix/ci-main-1", 1);
    addFix("fix/ci-main-2", 2);
    store.transition(REPO, "fix/ci-main-2", "CLOSED", { pr_state: "MERGED" });
    expect(store.activeForBase(REPO, "main").map((lineage) => lineage.healBranch)).toEqual(["fix/ci-main-1"]);
    expect(store.activeForBase(REPO, "other")).toEqual([]);
  });

  it("keeps handled heads per repository, base, and sha", () => {
    store.markHead(REPO, "main", "abc", "NO_PATCH");
    store.markHead(REPO, "main", "abc", "ERRORED");
    expect(store.handledOutcome(REPO, "main", "abc")).toBe("ERRORED");
    expect(store.handledOutcome(REPO, "main", "def")).toBeUndefined();
    expect(store.handledOutcome("other/repo", "main", "abc")).toBeUndefined();
  });

  it("grants a lease to one owner at a time and frees it on release or expiry", () => {
    const now = clock.getTime();
    expect(store.acquireLease("tick", "w1", 60_000, now)).toBe(true);
    expect(store.acquireLease("tick", "w2", 60_000, now)).toBe(false);
    store.releaseLease("tick", "w1");
    expect(store.acquireLease("tick", "w2", 60_000, now)).toBe(true);
    expect(store.acquireLease("tick", "w3", 60_000, now + 61_000)).toBe(true);
  });

  it("refuses a database file that is not SQLite, instead of starting empty", async () => {
    const path = join(dir, "garbage.db");
    await writeFile(path, "this is not a database");
    expect(() => new LedgerStore(path)).toThrow(StateError);
  });

  it("refuses a database written by a newer schema", () => {
    const path = join(dir, "future.db");
    const db = new Database(path);
    db.pragma("user_version = 99");
    db.close();
    expect(() => new LedgerStore(path)).toThrow(/newer than this build/);
  });
});

describe("agent environment policy", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "gh-secret-2",
    NEXUM_GITHUB_TOKEN: "x",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GIT_ASKPASS: "/usr/bin/askpass",
    NEXUM_MODEL: "qwen",
    OLLAMA_API_KEY: "model-key",
    FOO: "bar",
  };

  it("gives the agent model configuration, including provider keys", () => {
    expect(agentEnv(source)).toMatchObject({
      PATH: "/usr/bin",
      LC_ALL: "C",
      NEXUM_MODEL: "qwen",
      OLLAMA_API_KEY: "model-key",
    });
  });

  it("never passes GitHub or SSH credentials, even when explicitly allowed", () => {
    const env = agentEnv(source, ["GH_TOKEN", "SSH_AUTH_SOCK"]);
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "NEXUM_GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS"]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("drops unrelated variables unless explicitly allowed", () => {
    expect(agentEnv(source)).not.toHaveProperty("FOO");
    expect(agentEnv(source, ["FOO"])).toMatchObject({ FOO: "bar" });
  });

  it("gives repo-controlled commands no model keys", () => {
    const env = repoCommandEnv(source);
    expect(env).toMatchObject({ PATH: "/usr/bin" });
    for (const name of ["OLLAMA_API_KEY", "NEXUM_MODEL", "GH_TOKEN"]) expect(env).not.toHaveProperty(name);
  });
});

describe("NodeCommandRunner", () => {
  const runner = new NodeCommandRunner();

  it("returns stdout and status, and raises CommandError on failure", async () => {
    await expect(runner.run(["sh", "-c", "printf ok"], { timeoutMs: 5000 })).resolves.toMatchObject({
      status: 0,
      stdout: "ok",
    });
    await expect(runner.run(["sh", "-c", "echo bad >&2; exit 4"], { timeoutMs: 5000 })).rejects.toThrow(CommandError);
    await expect(runner.run(["sh", "-c", "exit 2"], { timeoutMs: 5000, allowFailure: true })).resolves.toMatchObject({
      status: 2,
    });
  });

  it("kills a command that exceeds its timeout and rejects promptly", async () => {
    const started = Date.now();
    await expect(runner.run(["sleep", "30"], { timeoutMs: 500 })).rejects.toThrow(TimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not expose the daemon's credentials to a clean-env command", async () => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "leak-me";
    try {
      const result = await runner.run(["sh", "-c", 'printf %s "${GH_TOKEN-unset}"'], {
        timeoutMs: 5000,
        env: repoCommandEnv(),
      });
      expect(result.stdout).toBe("unset");
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });
});
