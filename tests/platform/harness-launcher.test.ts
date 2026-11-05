import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ACTIVE_HARNESS_ENV,
  FROZEN_EXIT_CODE,
  HARNESS_MANIFEST,
  decideLaunch,
  isAgentCommand,
  readManifest,
  runActiveHarness,
  type CommandRunner,
} from "../../src/platform/harness-launcher.js";

const execFileAsync = promisify(execFile);

const POINTER = { id: "H1", commitSha: "a".repeat(40) };

describe("decideLaunch", () => {
  const manifest = { pointer: POINTER, frozen: false };
  const base = { command: "fix", env: {}, manifest, currentCommit: "b".repeat(40) };

  it("switches an agent command to the activated commit", () => {
    expect(decideLaunch(base)).toEqual({ kind: "switch", pointer: POINTER });
  });

  it("treats the TUI (no command) and a task string as agent commands", () => {
    expect(isAgentCommand(undefined)).toBe(true);
    expect(isAgentCommand("add a test for parseConfig")).toBe(true);
  });

  it("never switches a control command: the evaluator must not run the harness it judges", () => {
    for (const command of ["evolve", "doctor", "trust", "--version", "--help", "session"]) {
      expect(decideLaunch({ ...base, command }).kind).toBe("in-place");
    }
  });

  it("runs in place inside the activated child, and with the NEXUM_HARNESS=current opt-out", () => {
    expect(decideLaunch({ ...base, env: { [ACTIVE_HARNESS_ENV]: POINTER.commitSha } }).kind).toBe("in-place");
    expect(decideLaunch({ ...base, env: { NEXUM_HARNESS: "current" } }).kind).toBe("in-place");
  });

  it("runs in place with no manifest, no pointer, or when the checkout is already on the commit", () => {
    expect(decideLaunch({ ...base, manifest: null }).kind).toBe("in-place");
    expect(decideLaunch({ ...base, manifest: { pointer: null, frozen: false } }).kind).toBe("in-place");
    expect(decideLaunch({ ...base, currentCommit: POINTER.commitSha }).kind).toBe("in-place");
    expect(decideLaunch({ ...base, currentCommit: POINTER.commitSha.slice(0, 12) }).kind).toBe("in-place");
  });

  it("refuses an agent start while a rollback is in flight", () => {
    expect(decideLaunch({ ...base, manifest: { pointer: POINTER, frozen: true } }).kind).toBe("frozen");
  });
});

describe("readManifest", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-manifest-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ignores a pointer whose commit is not a SHA, so a ref like a branch name can never be executed", () => {
    writeFileSync(
      join(dir, HARNESS_MANIFEST),
      JSON.stringify({ activeHarness: { id: "H1", commitSha: "main; rm -rf /" } }),
    );
    expect(readManifest(dir)).toEqual({ pointer: null, frozen: false });
  });

  it("reads the pointer and the freeze marker", () => {
    writeFileSync(
      join(dir, HARNESS_MANIFEST),
      JSON.stringify({ activeHarness: { id: "H1", commitSha: "ABCDEF1234567" }, frozen: { at: 1 } }),
    );
    expect(readManifest(dir)).toEqual({ pointer: { id: "H1", commitSha: "abcdef1234567" }, frozen: true });
  });
});

describe("runActiveHarness against a real git checkout", () => {
  let repo: string;
  let store: string;
  let shaA: string;
  let shaFails: string;
  const commands: string[] = [];

  // A real runner that also records each command, to prove a second start does not rebuild.
  const run: CommandRunner = async (command, args, cwd) => {
    commands.push(`${command} ${args.join(" ")}`);
    try {
      const { stdout, stderr } = await execFileAsync(command, args, { cwd });
      return { exitCode: 0, output: `${stdout}${stderr}` };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { exitCode: typeof e.code === "number" ? e.code : 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  const git = (...args: string[]) =>
    execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo }).then((r) =>
      r.stdout.trim(),
    );

  // Each commit's bin/cli.js names its harness, echoes its args, and exits with a distinctive code.
  const commitHarness = async (name: string, build: string): Promise<string> => {
    mkdirSync(join(repo, "bin"), { recursive: true });
    writeFileSync(
      join(repo, "bin", "cli.js"),
      `console.log("harness-${name}", process.argv.slice(2).join(" "), process.env.${ACTIVE_HARNESS_ENV} ? "child" : "");\nprocess.exit(3);\n`,
    );
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fake-nexum", scripts: { build } }));
    await git("add", "-A");
    await git("commit", "-qm", name);
    return git("rev-parse", "HEAD");
  };

  const activate = (commitSha: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(repo, HARNESS_MANIFEST),
      JSON.stringify({ activeHarness: { id: "H-test", commitSha }, ...extra }),
    );

  const start = async (command: string | undefined, argv: string[]) => {
    let output = "";
    const logs: string[] = [];
    const exitCode = await runActiveHarness({
      command,
      argv,
      packageRoot: repo,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      storeDir: store,
      run,
      stdio: "pipe",
      onOutput: (chunk) => (output += chunk),
      log: (line) => logs.push(line),
    });
    return { exitCode, output, logs };
  };

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "harness-repo-"));
    store = mkdtempSync(join(tmpdir(), "harness-store-"));
    await execFileAsync("git", ["init", "-q", "."], { cwd: repo });
    shaA = await commitHarness("A", `node -e "require('fs').writeFileSync('built.txt','A')"`);
    shaFails = await commitHarness("broken", "node -e process.exit(1)");
    await commitHarness("B", `node -e "require('fs').writeFileSync('built.txt','B')"`);
  }, 60_000);

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  });

  it("runs the activated commit for an agent command, with the same args and exit code", async () => {
    activate(shaA);
    const { exitCode, output, logs } = await start("fix", ["fix", "the", "bug"]);

    expect(output).toContain("harness-A fix the bug child");
    expect(exitCode).toBe(3);
    expect(readFileSync(join(store, shaA, "built.txt"), "utf8")).toBe("A");
    expect(logs.some((l) => l.includes("running activated harness H-test"))).toBe(true);
  }, 60_000);

  it("reuses a prepared harness instead of checking out and building again", async () => {
    activate(shaA);
    commands.length = 0;
    const { output } = await start(undefined, []);

    expect(output).toContain("harness-A");
    expect(commands.filter((c) => c.startsWith("git worktree add") || c.startsWith("npm run build"))).toEqual([]);
  }, 60_000);

  it("leaves control commands on the installed code", async () => {
    activate(shaA);
    expect((await start("evolve", ["evolve", "--mutate"])).exitCode).toBeNull();
  });

  it("runs in place when the checkout is already on the activated commit", async () => {
    activate(await git("rev-parse", "HEAD"));
    expect((await start("fix", ["fix"])).exitCode).toBeNull();
  });

  it("refuses an agent start while a rollback is in flight", async () => {
    activate(shaA, { frozen: { at: 1, reason: "runtime rollback in flight" } });
    expect((await start("fix", ["fix"])).exitCode).toBe(FROZEN_EXIT_CODE);
  });

  it("fails closed when the activated commit does not build, and marks nothing ready", async () => {
    activate(shaFails);
    const { exitCode, output, logs } = await start("fix", ["fix"]);

    expect(exitCode).toBe(1);
    expect(output).toBe("");
    expect(logs.join("\n")).toMatch(/building it failed/);
    expect(logs.join("\n")).toMatch(/NEXUM_HARNESS=current/);
    expect(existsSync(join(store, shaFails, ".nexum-harness-ready"))).toBe(false);
  }, 60_000);
});
