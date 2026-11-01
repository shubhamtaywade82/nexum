import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRouter, type RuntimeCandidate } from "../../../src/domains/ci-healer/adapters/agent-router.js";
import { antigravityAgent, openCodeAgent } from "../../../src/domains/ci-healer/adapters/cli-agents.js";
import {
  buildDockerRunArgs,
  buildRepoCommands,
  DockerRepoCommands,
  HostRepoCommands,
  preflightSandbox,
  type SandboxSettings,
} from "../../../src/domains/ci-healer/adapters/repo-commands.js";
import type {
  AgentOutcome,
  AgentPort,
  CommandOptions,
  CommandPort,
  CommandResult,
  Logger,
} from "../../../src/domains/ci-healer/application/ports.js";
import { parseConfig } from "../../../src/domains/ci-healer/config.js";
import { ConfigError, TimeoutError } from "../../../src/domains/ci-healer/errors.js";
import { LedgerStore } from "../../../src/domains/ci-healer/persistence/ledger-store.js";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const SETTINGS: SandboxSettings = {
  mode: "docker",
  image: "nexum-sandbox:latest",
  memory: "2g",
  cpus: "2",
  pids_limit: 256,
  setup_network: "bridge",
};

/** Records every command. Returns scripted results in order, and the last result repeats. */
class RecordingCommands implements CommandPort {
  readonly calls: { argv: string[]; options: CommandOptions }[] = [];
  constructor(private readonly script: ((argv: string[]) => CommandResult | Error)[] = []) {}

  async run(argv: readonly string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push({ argv: [...argv], options });
    const next =
      this.script.length > 0 ? this.script[Math.min(this.calls.length - 1, this.script.length - 1)] : undefined;
    const result = next ? next([...argv]) : { status: 0, stdout: "", stderr: "" };
    if (result instanceof Error) throw result;
    if (result.status !== 0 && !options.allowFailure) {
      throw new Error(`command failed: ${argv.join(" ")}`);
    }
    return result;
  }
}

describe("buildDockerRunArgs (sandbox hardening)", () => {
  const args = buildDockerRunArgs({
    name: "ci-healer-test",
    worktree: "/tmp/wt/app-111-a318b67",
    command: "npm test",
    network: "none",
    timeoutSec: 900,
    uid: 1000,
    gid: 1000,
    env: { PATH: "/usr/bin", LANG: "C.UTF-8", TZ: "UTC", GH_TOKEN: "leak-me", HOME: "/home/u" },
    settings: SETTINGS,
  });

  it("disables the network for verify and drops every capability", () => {
    expect(args).toContain("--network=none");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--read-only");
  });

  it("runs as the host uid and gid, never as root", () => {
    const user = args[args.indexOf("--user") + 1];
    expect(user).toBe("1000:1000");
  });

  it("mounts exactly one host path: the worktree", () => {
    const mounts = args.flatMap((arg, index) => (arg === "--mount" ? [args[index + 1]] : []));
    expect(mounts).toEqual(["type=bind,source=/tmp/wt/app-111-a318b67,target=/workspace"]);
    expect(args).not.toContain("-v");
  });

  it("passes only locale and terminal variables, never credentials or the host PATH", () => {
    expect(args).toEqual(expect.arrayContaining(["-e", "LANG=C.UTF-8", "-e", "TZ=UTC", "-e", "HOME=/tmp"]));
    expect(args.some((arg) => arg.startsWith("GH_TOKEN="))).toBe(false);
    expect(args.some((arg) => arg.startsWith("PATH="))).toBe(false);
    expect(args.some((arg) => arg.startsWith("HOME=/home"))).toBe(false);
  });

  it("applies resource limits and a writable but non-executable-escape tmpfs", () => {
    expect(args).toEqual(expect.arrayContaining(["--memory=2g", "--cpus=2", "--pids-limit=256"]));
    expect(args).toContain("/tmp:rw,exec,nosuid,size=512m");
  });

  it("ends with the image, an in-container timeout, and the command", () => {
    expect(args.slice(-6)).toEqual(["nexum-sandbox:latest", "timeout", "900", "sh", "-c", "npm test"]);
  });

  it("refuses a worktree path that would break docker's --mount syntax", () => {
    expect(() =>
      buildDockerRunArgs({
        ...{
          name: "x",
          worktree: "/tmp/a,b",
          command: "true",
          network: "none",
          timeoutSec: 1,
          uid: 1,
          gid: 1,
          env: {},
          settings: SETTINGS,
        },
      }),
    ).toThrow(ConfigError);
  });
});

describe("repo command routing", () => {
  it("runs verify with no network and setup with the configured setup network", async () => {
    const commands = new RecordingCommands();
    const repo = new DockerRepoCommands(commands, { ...SETTINGS, setup_network: "bridge" });

    await repo.run("npm test", { cwd: "/tmp/wt/a", timeoutMs: 60_000, phase: "verify" });
    await repo.run("npm ci", { cwd: "/tmp/wt/a", timeoutMs: 60_000, phase: "setup" });

    expect(commands.calls[0].argv[0]).toBe("docker");
    expect(commands.calls[0].argv).toContain("--network=none");
    expect(commands.calls[1].argv).toContain("--network=bridge");
  });

  it("removes the named container when a command times out", async () => {
    const { TimeoutError } = await import("../../../src/domains/ci-healer/errors.js");
    const commands = new RecordingCommands([() => new TimeoutError("slow")]);
    const repo = new DockerRepoCommands(commands, SETTINGS);

    await expect(repo.run("sleep 999", { cwd: "/tmp/wt/a", timeoutMs: 1000, phase: "verify" })).rejects.toThrow(
      TimeoutError,
    );
    const removal = commands.calls.find((call) => call.argv[1] === "rm");
    expect(removal?.argv).toEqual(expect.arrayContaining(["rm", "-f"]));
  });

  it("host mode runs through sh with only the allowlisted environment", async () => {
    const commands = new RecordingCommands();
    await new HostRepoCommands(commands).run("npm test", { cwd: "/tmp/wt/a", timeoutMs: 1000, phase: "verify" });
    expect(commands.calls[0].argv).toEqual(["sh", "-c", "npm test"]);
    expect(commands.calls[0].options.env).not.toHaveProperty("GH_TOKEN");
  });

  it("selects the implementation from sandbox.mode", () => {
    const commands = new RecordingCommands();
    expect(buildRepoCommands(commands, SETTINGS)).toBeInstanceOf(DockerRepoCommands);
    expect(buildRepoCommands(commands, { ...SETTINGS, mode: "host" })).toBeInstanceOf(HostRepoCommands);
  });
});

describe("preflightSandbox (fails closed)", () => {
  it("refuses docker mode when the daemon is unreachable, instead of falling back to the host", async () => {
    const commands = new RecordingCommands([() => ({ status: 1, stdout: "", stderr: "no daemon" })]);
    await expect(preflightSandbox(commands, SETTINGS)).rejects.toThrow(/Docker daemon is not reachable/);
  });

  it("refuses docker mode when the sandbox image is missing, and says how to build it", async () => {
    const commands = new RecordingCommands([
      () => ({ status: 0, stdout: "27.0", stderr: "" }),
      () => ({ status: 1, stdout: "", stderr: "No such image" }),
    ]);
    await expect(preflightSandbox(commands, SETTINGS)).rejects.toThrow(/docker build -t nexum-sandbox:latest/);
  });

  it("does nothing in host mode", async () => {
    const commands = new RecordingCommands();
    await preflightSandbox(commands, { ...SETTINGS, mode: "host" });
    expect(commands.calls).toEqual([]);
  });
});

describe("config: sandbox and runtime chain", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cfg-repo-"));
    mkdirSync(join(repo, ".git"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const base = () => ({ repo: { slug: "acme/app", dir: repo }, verify_commands: ["npm test"] });

  it("defaults to docker sandboxing and the nexum runtime", () => {
    const config = parseConfig(base());
    expect(config.sandbox.mode).toBe("docker");
    expect(config.agent_chain).toEqual([{ runtime: "nexum" }]);
  });

  it("refuses host execution unless it is acknowledged", () => {
    expect(() => parseConfig({ ...base(), sandbox: { mode: "host" } })).toThrow(/acknowledge_host_execution/);
    expect(parseConfig({ ...base(), sandbox: { mode: "host", acknowledge_host_execution: true } }).sandbox.mode).toBe(
      "host",
    );
  });

  it("requires a model for opencode runtime entries", () => {
    expect(() => parseConfig({ ...base(), agent_chain: [{ runtime: "opencode" }] })).toThrow(ConfigError);
  });
});

describe("AgentRouter (ordered chain with circuit breakers)", () => {
  let dir: string;
  let store: LedgerStore;
  let nowMs: number;
  const REPO = "acme/app";
  const policy = { rateLimitCooldownMs: 1_800_000, breakerThreshold: 3, breakerCooldownMs: 900_000 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "router-"));
    store = new LedgerStore(join(dir, "state.db"));
    nowMs = Date.parse("2026-11-01T00:00:00Z");
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A scripted agent. Each call consumes the next outcome. */
  function scripted(
    name: string,
    outcomes: (AgentOutcome | Error)[],
  ): { candidate: RuntimeCandidate; calls: () => number } {
    let calls = 0;
    const agent: AgentPort = {
      async execute() {
        const next = outcomes[Math.min(calls, outcomes.length - 1)];
        calls += 1;
        if (next instanceof Error) throw next;
        return { ...next, runtime: name };
      },
    };
    return { candidate: { name, agent }, calls: () => calls };
  }

  const router = (candidates: RuntimeCandidate[], resets: string[] = []) =>
    new AgentRouter({
      repository: REPO,
      candidates,
      store,
      log: silent,
      policy,
      now: () => new Date(nowMs),
      reset: async (workspace) => {
        resets.push(workspace);
      },
    });

  const failure = (error: string): AgentOutcome => ({ status: "failed", output: "", error });
  const done: AgentOutcome = { status: "completed", output: "ok" };

  it("falls through to the next candidate, resets the worktree in between, and names the winner", async () => {
    const resets: string[] = [];
    const first = scripted("nexum", [failure("model unavailable")]);
    const second = scripted("opencode:ollama/qwen", [done]);
    const outcome = await router([first.candidate, second.candidate], resets).execute({
      workspace: "/wt/a",
      goal: "g",
    });

    expect(outcome).toMatchObject({ status: "completed", runtime: "opencode:ollama/qwen" });
    expect(resets).toEqual(["/wt/a"]);
  });

  it("skips a candidate in cooldown after a rate-limit error, without calling it", async () => {
    const free = scripted("opencode:free-model", [failure("HTTP 429 Too Many Requests")]);
    const local = scripted("opencode:ollama/qwen", [done]);
    const chain = router([free.candidate, local.candidate]);

    await chain.execute({ workspace: "/wt/a", goal: "g" });
    nowMs += 60_000;
    await chain.execute({ workspace: "/wt/a", goal: "g" });

    expect(free.calls()).toBe(1);
    expect(local.calls()).toBe(2);
  });

  it("opens the breaker after consecutive failures, then closes it after the cooldown", async () => {
    const flaky = scripted("nexum", [failure("boom"), failure("boom"), failure("boom"), done]);
    const chain = router([flaky.candidate]);

    for (let attempt = 0; attempt < 3; attempt += 1) await chain.execute({ workspace: "/wt/a", goal: "g" });
    expect(flaky.calls()).toBe(3);

    nowMs += 60_000;
    expect((await chain.execute({ workspace: "/wt/a", goal: "g" })).status).toBe("failed");
    expect(flaky.calls()).toBe(3);

    nowMs += 900_000;
    expect((await chain.execute({ workspace: "/wt/a", goal: "g" })).status).toBe("completed");
    expect(flaky.calls()).toBe(4);
  });

  it("resets the failure count on success", async () => {
    const agent = scripted("nexum", [failure("boom"), failure("boom"), done, failure("boom"), failure("boom")]);
    const chain = router([agent.candidate]);
    for (let attempt = 0; attempt < 5; attempt += 1) await chain.execute({ workspace: "/wt/a", goal: "g" });
    expect(agent.calls()).toBe(5);
  });

  it("reports every candidate's error when the whole chain fails", async () => {
    const a = scripted("nexum", [failure("crashed")]);
    const b = scripted("agy", [new TimeoutError("rpc timed out")]);
    const outcome = await router([a.candidate, b.candidate]).execute({ workspace: "/wt/a", goal: "g" });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("nexum: crashed");
    expect(outcome.error).toContain("agy: rpc timed out");
  });
});

describe("headless CLI runtimes", () => {
  it("opencode is invoked as `run --model <provider/model> --format json <goal>`", async () => {
    const commands = new RecordingCommands();
    const agent = openCodeAgent({
      model: "openrouter/anthropic/claude-sonnet-4.5",
      binary: "opencode",
      command: commands,
      timeoutMs: 60_000,
      env: {},
    });
    const outcome = await agent.execute({ workspace: "/wt/a", goal: "fix it" });

    expect(commands.calls[0].argv).toEqual([
      "opencode",
      "run",
      "--model",
      "openrouter/anthropic/claude-sonnet-4.5",
      "--format",
      "json",
      "fix it",
    ]);
    expect(outcome).toMatchObject({ status: "completed", runtime: "opencode:openrouter/anthropic/claude-sonnet-4.5" });
  });

  it("antigravity is invoked in print mode with a JSON envelope and no permission-bypass flag", async () => {
    const commands = new RecordingCommands();
    await antigravityAgent({ binary: "agy", command: commands, timeoutMs: 60_000, env: {} }).execute({
      workspace: "/wt/a",
      goal: "fix it",
    });

    expect(commands.calls[0].argv).toEqual(["agy", "-p", "fix it", "--output-format", "json"]);
    expect(commands.calls[0].argv.join(" ")).not.toMatch(/skip-permissions|yolo/);
  });

  it("treats a non-zero exit as failure, carrying the CLI's stderr", async () => {
    const commands = new RecordingCommands([() => ({ status: 2, stdout: "", stderr: "not signed in" })]);
    const outcome = await antigravityAgent({ binary: "agy", command: commands, timeoutMs: 60_000, env: {} }).execute({
      workspace: "/wt/a",
      goal: "g",
    });
    expect(outcome).toMatchObject({ status: "failed", error: "not signed in", runtime: "agy" });
  });
});

describe("ledger schema upgrade to version 2", () => {
  it("adds runtime and scan tables to a version 1 ledger without touching lineages", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-"));
    const path = join(dir, "state.db");
    try {
      new LedgerStore(path).close();
      const raw = new Database(path);
      raw.exec("DROP TABLE runtime_health; DROP TABLE scan_cursors;");
      raw.pragma("user_version = 1");
      raw.close();

      const upgraded = new LedgerStore(path);
      upgraded.close();
      const check = new Database(path, { readonly: true });
      expect(check.pragma("user_version", { simple: true })).toBe(2);
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      expect(tables.map((table) => table.name)).toEqual(
        expect.arrayContaining(["lineages", "runtime_health", "scan_cursors"]),
      );
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
