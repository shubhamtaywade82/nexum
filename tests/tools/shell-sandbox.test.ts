/**
 * Shell sandbox hardening: container privileges, workspace mounts (write
 * scope, git internals, secret masking), and routing of project/ruby script
 * runners through the sandbox instead of the host.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellTool } from "../../src/tools/shell.js";
import { RunTestsTool } from "../../src/tools/project-tools.js";
import { RunRubocopTool } from "../../src/domains/ruby/rubocop-tool.js";
import { RunRSpecTool } from "../../src/domains/ruby/rspec-tool.js";
import { shellQuote, type CommandRunner } from "../../src/tools/command-runner.js";
import { WriteFileTool, SensitivePathError } from "../../src/tools/filesystem.js";
import { AgentToolManager } from "../../src/cli/agent-tools.js";
import { parityPosture } from "../../src/core/policy/postures.js";
import { WorkspaceGuard } from "../../src/core/fs/workspace-guard.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "nexum-sandbox-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dockerArgs(tool: ShellTool, command = "echo hi"): string[] {
  return (tool as unknown as { dockerArgs: (c: string, cmd: string) => string[] }).dockerArgs("c1", command);
}

const empty = () => join(root, ".nexum", "sandbox-empty");

function mounts(args: string[]): string[] {
  return args.flatMap((a, i) => (args[i - 1] === "--mount" ? [a] : []));
}

describe("container privileges", () => {
  it("drops root, capabilities and privilege escalation, and keeps the root filesystem read-only", () => {
    const args = dockerArgs(new ShellTool({ workspaceRoot: root }));
    expect(args).toEqual(
      expect.arrayContaining([
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--read-only",
        "--pids-limit=128",
      ]),
    );
    expect(args[args.indexOf("--user") + 1]).toBe(`${process.getuid!()}:${process.getgid!()}`);
    expect(args[args.indexOf("--tmpfs") + 1]).toMatch(/^\/tmp:/);
    expect(args).toContain("HOME=/tmp");
  });

  it("passes the command through untouched (no chown of the workspace)", () => {
    const args = dockerArgs(new ShellTool({ workspaceRoot: root }), "npm test");
    expect(args.slice(-3)).toEqual(["sh", "-c", "npm test"]);
    expect(args.join(" ")).not.toContain("chown");
  });
});

describe("workspace mounts", () => {
  it("mounts the workspace read-write when no write scope is set", () => {
    const m = mounts(dockerArgs(new ShellTool({ workspaceRoot: root })));
    expect(m[0]).toBe(`type=bind,source=${root},target=/workspace`);
  });

  it("with a write scope, mounts the workspace read-only and only the scope read-write", () => {
    mkdirSync(join(root, "src"));
    const m = mounts(dockerArgs(new ShellTool({ workspaceRoot: root, writeScope: join(root, "src") })));
    expect(m[0]).toBe(`type=bind,source=${root},target=/workspace,readonly`);
    expect(m[1]).toBe(`type=bind,source=${join(root, "src")},target=/workspace/src`);
  });

  it("masks secret files with an empty file and secret directories with an empty tmpfs", () => {
    writeFileSync(join(root, ".env"), "API_KEY=x");
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", ".env.production"), "API_KEY=y");
    writeFileSync(join(root, "server.pem"), "key");
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "token.txt"), "t");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", ".env"), "fixture");
    writeFileSync(join(root, "app.ts"), "ok");

    const m = mounts(dockerArgs(new ShellTool({ workspaceRoot: root })));
    expect(m).toEqual(
      expect.arrayContaining([
        `type=bind,source=${empty()},target=/workspace/.env,readonly`,
        `type=bind,source=${empty()},target=/workspace/config/.env.production,readonly`,
        `type=bind,source=${empty()},target=/workspace/server.pem,readonly`,
        "type=tmpfs,target=/workspace/secrets,tmpfs-size=4096,tmpfs-mode=0500",
      ]),
    );
    expect(m.join("\n")).not.toContain("app.ts");
    expect(m.join("\n")).not.toContain("node_modules");
  });

  it("the mask file is empty and re-created if something wrote to it", () => {
    writeFileSync(join(root, ".env"), "API_KEY=x");
    dockerArgs(new ShellTool({ workspaceRoot: root }));
    rmSync(empty());
    writeFileSync(empty(), "not empty");
    dockerArgs(new ShellTool({ workspaceRoot: root }));
    expect(readFileSync(empty(), "utf8")).toBe("");
  });

  it("mounts .git/hooks and .git/config read-only so nothing planted runs on the host", () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n");
    const m = mounts(dockerArgs(new ShellTool({ workspaceRoot: root })));
    expect(m).toEqual(
      expect.arrayContaining([
        `type=bind,source=${join(root, ".git", "hooks")},target=/workspace/.git/hooks,readonly`,
        `type=bind,source=${join(root, ".git", "config")},target=/workspace/.git/config,readonly`,
      ]),
    );
  });

  it("mounts .nexum (created if missing) and .devagent read-only", () => {
    mkdirSync(join(root, ".devagent"));
    const m = mounts(dockerArgs(new ShellTool({ workspaceRoot: root })));
    expect(existsSync(join(root, ".nexum"))).toBe(true);
    expect(m).toEqual(
      expect.arrayContaining([
        `type=bind,source=${join(root, ".nexum")},target=/workspace/.nexum,readonly`,
        `type=bind,source=${join(root, ".devagent")},target=/workspace/.devagent,readonly`,
      ]),
    );
  });

  it("protects a symlinked .nexum where it really lives", () => {
    mkdirSync(join(root, "state"));
    symlinkSync("state", join(root, ".nexum"));
    const m = mounts(dockerArgs(new ShellTool({ workspaceRoot: root })));
    expect(m).toContain(`type=bind,source=${join(root, "state")},target=/workspace/state,readonly`);
  });

  it("CSV-quotes mount fields containing commas", () => {
    writeFileSync(join(root, "a,b.pem"), "key");
    const m = mounts(dockerArgs(new ShellTool({ workspaceRoot: root })));
    expect(m).toContain(`type=bind,source=${empty()},"target=/workspace/a,b.pem",readonly`);
  });

  it("fails closed when the workspace is too large to scan for secrets", async () => {
    const big = join(root, "big");
    mkdirSync(big);
    for (let i = 0; i <= 100_000; i++) writeFileSync(join(big, `f${i}`), "");
    const tool = new ShellTool({ workspaceRoot: root });
    (tool as unknown as { dockerAvailable: boolean }).dockerAvailable = true;
    const result = await tool.call({ command: "echo hi" });
    expect(result.error).toBe("SandboxScanError");
  }, 60_000);
});

describe("script runners go through the runner, not the host", () => {
  function fakeRunner(): CommandRunner & { calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      call: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "3 examples, 0 failures\n1 file inspected, 2 offenses detected", stderr: "" };
      },
    };
  }

  it("run_tests executes the package script via the runner with a bounded timeout", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo HOST > ran.txt" } }));
    const runner = fakeRunner();
    const result = await new RunTestsTool(root, runner).call({});
    expect(runner.calls).toEqual([{ command: "npm run test", timeoutSec: 900 }]);
    expect(result).toMatchObject({ command: "npm run test", exitCode: 0 });
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
  });

  it("rubocop/rspec quote paths for the runner and reject option injection", async () => {
    const runner = fakeRunner();
    const rspec = await new RunRSpecTool(root, runner).call({ path: "spec/my spec.rb", line: 4 });
    expect(runner.calls[0].command).toBe("bundle exec rspec --format documentation 'spec/my spec.rb:4'");
    expect(rspec).toMatchObject({ examples: 3, failures: 0 });

    const rubocop = await new RunRubocopTool(root, runner).call({ path: "--require=/tmp/evil.rb" });
    expect(rubocop.error).toBe("ArgumentError");
    const badFormat = await new RunRSpecTool(root, runner).call({ format: "EvilFormatter" });
    expect(badFormat.error).toBe("ArgumentError");
    expect(runner.calls).toHaveLength(1);
  });

  it("shellQuote survives quotes and metacharacters", () => {
    expect(shellQuote("a'b; rm -rf /")).toBe(`'a'\\''b; rm -rf /'`);
    expect(shellQuote("spec/foo_spec.rb:12")).toBe("spec/foo_spec.rb:12");
  });

  it("registerBaseTools wires run_tests and run_rspec to a sandboxed ShellTool", () => {
    const manager = new AgentToolManager();
    manager.registerBaseTools(root, undefined, { sandbox: true });
    for (const name of ["run_tests", "run_rspec"]) {
      const entry = [...manager.mountedPacks.values()].flatMap((p) => p.entries).find((e) => e.tool.name === name);
      const runner = (entry?.tool as unknown as { runner?: ShellTool }).runner;
      expect(runner).toBeInstanceOf(ShellTool);
      expect(runner?.sandbox).toBe(true);
    }
  });
});

describe("file tools cannot plant git hooks or config", () => {
  it("write_file into .git/ is refused", async () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    const write = new WriteFileTool(root);
    await expect(write.call({ path: ".git/hooks/pre-commit", content: "#!/bin/sh\ncurl evil" })).rejects.toThrow(
      SensitivePathError,
    );
    await expect(write.call({ path: ".git/config", content: "[core]\nfsmonitor = evil" })).rejects.toThrow(
      SensitivePathError,
    );
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });
});

describe("file tools cannot change Nexum's own state", () => {
  it("writes, deletes and moves under .nexum/ and .devagent/ are refused; reads are not", async () => {
    mkdirSync(join(root, ".nexum"));
    writeFileSync(join(root, ".nexum", "config.json"), '{"sandbox":true}');
    const write = new WriteFileTool(root);
    for (const path of [".nexum/config.json", ".nexum/publisher-trust.json", ".devagent/config.json"]) {
      await expect(write.call({ path, content: '{"sandbox":false}' })).rejects.toThrow(SensitivePathError);
    }
    const guard = new WorkspaceGuard({ root });
    expect(guard.check("delete", ".nexum").allowed).toBe(false);
    expect(guard.check("move", ".nexum/config.json").allowed).toBe(false);
    expect(guard.check("mkdir", ".nexum/plugins").allowed).toBe(false);
    expect(guard.check("read", ".nexum/config.json").allowed).toBe(true);
    expect(guard.check("write", "src/.nexum-notes.md").allowed).toBe(true);
  });
});

describe("policy: denials run before product allowances", () => {
  it("read-only agent modes deny the shell even for commands parity considers benign", () => {
    const manager = new AgentToolManager();
    manager.registerBaseTools(root, undefined, { sandbox: true });
    const tool = manager.kernelCatalog.definition("run_shell")!;
    const decide = (command: string, mode?: string) =>
      parityPosture().check({ tool, args: { command }, agentId: "devagent", runId: "r1", mode });
    expect(decide("ls")).toMatchObject({ allowed: true });
    for (const mode of ["ask", "review"]) {
      expect(decide("ls", mode)).toMatchObject({ allowed: false, rule: "mode-restriction" });
      expect(decide("echo x > notes.txt", mode)).toMatchObject({ allowed: false, rule: "mode-restriction" });
    }
  });
});

describe("host mode (sandbox disabled) requires confirmation", () => {
  it("the CLI's parity posture asks before ANY host shell command, but lets benign sandboxed ones through", () => {
    const decide = (sandbox: boolean, command: string) => {
      const manager = new AgentToolManager();
      manager.registerBaseTools(root, undefined, { sandbox });
      const tool = manager.kernelCatalog.definition("run_shell")!;
      return parityPosture().check({ tool, args: { command }, agentId: "devagent", runId: "r1" });
    };
    expect(decide(true, "ls")).toMatchObject({ allowed: true, requireConfirmation: false });
    expect(decide(false, "ls")).toMatchObject({ allowed: true, requireConfirmation: true });
    expect(decide(false, "cat ~/.aws/credentials")).toMatchObject({ requireConfirmation: true });
    expect(decide(true, "rm -rf /workspace")).toMatchObject({ requireConfirmation: true });
  });

  function policyOf(manager: AgentToolManager, id: string) {
    return manager.kernelCatalog.definition(id)?.policy.confirmation;
  }

  it("run_shell and script runners require confirmation only when running on the host", () => {
    const host = new AgentToolManager();
    host.registerBaseTools(root, undefined, { sandbox: false });
    for (const id of ["run_shell", "run_tests", "run_build", "run_rspec", "run_rubocop"]) {
      expect(policyOf(host, id)).toBe("required");
    }

    const sandboxed = new AgentToolManager();
    sandboxed.registerBaseTools(root, undefined, { sandbox: true });
    // sandboxed script runners stay unattended; run_shell is high-risk and confirms either way
    for (const id of ["run_tests", "run_rspec"]) {
      expect(policyOf(sandboxed, id)).not.toBe("required");
    }
  });
});
