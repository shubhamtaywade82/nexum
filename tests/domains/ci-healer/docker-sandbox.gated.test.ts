import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DockerRepoCommands } from "../../../src/domains/ci-healer/adapters/repo-commands.js";
import { NodeCommandRunner } from "../../../src/domains/ci-healer/adapters/command-runner.js";

const exec = promisify(execFile);

/**
 * Real-daemon checks for the sandbox. They run only when CI_HEALER_DOCKER_TESTS=1 and
 * the image exists, because they need a Docker daemon and nexum-sandbox:latest. They are
 * skipped by default, so the default suite stays hermetic.
 */
const enabled = process.env.CI_HEALER_DOCKER_TESTS === "1";
const describeIfDocker = enabled ? describe : describe.skip;

describeIfDocker("sandbox against a real Docker daemon", () => {
  const image = process.env.CI_HEALER_SANDBOX_IMAGE ?? "nexum-sandbox:latest";
  const settings = {
    mode: "docker" as const,
    image,
    memory: "512m",
    cpus: "1",
    pids_limit: 128,
    setup_network: "bridge" as const,
  };
  let worktree: string;
  let repo: DockerRepoCommands;

  beforeAll(() => {
    worktree = mkdtempSync(join(tmpdir(), "sandbox-real-"));
    writeFileSync(join(worktree, "marker.txt"), "inside\n");
    repo = new DockerRepoCommands(new NodeCommandRunner(), settings);
  });

  afterAll(() => rmSync(worktree, { recursive: true, force: true }));

  it("verify commands cannot reach the network", async () => {
    const result = await repo.run("wget -q -T 5 -O /dev/null http://example.com || echo network-blocked", {
      cwd: worktree,
      timeoutMs: 60_000,
      phase: "verify",
      allowFailure: true,
    });
    expect(result.stdout + result.stderr).toMatch(/network-blocked/);
  });

  it("verify commands see the worktree and nothing else from the host", async () => {
    const result = await repo.run(
      'cat marker.txt && test -z "${GH_TOKEN-}" && test ! -e "$HOME/.config/gh" && echo isolated',
      { cwd: worktree, timeoutMs: 60_000, phase: "verify" },
    );
    expect(result.stdout).toContain("inside");
    expect(result.stdout).toContain("isolated");
  });

  it("the root filesystem is read-only; only the worktree and /tmp are writable", async () => {
    const result = await repo.run(
      "touch /usr/local/x 2>/dev/null && echo root-writable || echo root-readonly; touch /tmp/y && echo tmp-writable; touch /workspace/z && echo worktree-writable",
      { cwd: worktree, timeoutMs: 60_000, phase: "verify" },
    );
    expect(result.stdout).toContain("root-readonly");
    expect(result.stdout).toContain("tmp-writable");
    expect(result.stdout).toContain("worktree-writable");
  });

  it("runs as the host user, not root", async () => {
    const result = await repo.run("id -u", { cwd: worktree, timeoutMs: 60_000, phase: "verify" });
    expect(Number(result.stdout.trim())).toBe(process.getuid?.() ?? 1000);
  });

  it("a command that exceeds its timeout is stopped and its container removed", async () => {
    const started = Date.now();
    await expect(repo.run("sleep 300", { cwd: worktree, timeoutMs: 5_000, phase: "verify" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(60_000);
    const { stdout } = await exec("docker", ["ps", "-a", "--filter", "name=ci-healer-", "--format", "{{.Names}}"]);
    expect(stdout.trim()).toBe("");
  });
});
