import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerTool, AGENT_LABEL } from "../../src/tools/docker-tools.js";
import { AgentToolManager } from "../../src/cli/agent-tools.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws-docker-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DockerTool", () => {
  it("runs an allowlisted subcommand, scoped to agent-owned objects", async () => {
    const result = await new DockerTool(dir).call({ args: ["ps"] });
    expect(typeof result.exitCode).toBe("number");
    expect(result.command).toBe(`docker ps --filter label=${AGENT_LABEL}`);
  });

  it("rejects empty args and unknown subcommands", async () => {
    const tool = new DockerTool(dir);
    expect((await tool.call({ args: [] })).error).toBe("ArgumentError");
    expect((await tool.call({ args: ["rmi", "-f", "some-image"] })).error).toBe("DisallowedDockerCommandError");
  });

  it.each([
    [["run", "-v", "/:/host", "alpine"]],
    [["run", "-v/:/host", "alpine"]],
    [["run", "-itv", "/:/host", "alpine"]],
    [["run", "--volume=/etc:/x", "alpine"]],
    [["run", "-v", "./:/w", "alpine"]],
    [["run", "--mount", "type=bind,src=/,dst=/h", "alpine"]],
    [["run", "--mount", "src=/var/run/docker.sock,dst=/s", "alpine"]],
    [["run", "--privileged", "alpine"]],
    [["run", "--cap-add", "SYS_ADMIN", "alpine"]],
    [["run", "--device", "/dev/sda", "alpine"]],
    [["run", "--pid=host", "alpine"]],
    [["run", "--userns=host", "alpine"]],
    [["run", "--network", "host", "alpine"]],
    [["run", "--net=container:db", "alpine"]],
    [["run", "--security-opt", "seccomp=unconfined", "alpine"]],
    [["run", "--volumes-from", "db", "alpine"]],
    [["run", "--env-file", ".env", "alpine"]],
    [["run", "-e", "OLLAMA_API_KEY", "alpine"]],
    [["run", "-p", "8080:80", "nginx"]],
    [["cp", "/home/user/.ssh/id_rsa", "c:/"]],
    [["compose", "up"]],
    [["build", "-o", "/home/user/.ssh", "."]],
    [["build", "--ssh", "default", "."]],
    [["build", "--secret", "id=k,src=.env", "."]],
    [["build", "--iidfile", "/tmp/x", "."]],
    [["build", "--cache-to", "type=local,dest=/tmp/c", "."]],
    [["build", "--build-arg", "OLLAMA_API_KEY", "."]],
    [["build", "https://github.com/example/repo.git"]],
    [["build", "-"]],
    [["build", ".."]],
    [["build", "-f", "/etc/Dockerfile", "."]],
  ])("blocks %j", async (args) => {
    const result = await new DockerTool(dir).call({ args });
    expect(result.error).toBe("DisallowedDockerCommandError");
  });

  it("refuses a build context that contains secrets", () => {
    writeFileSync(join(dir, "Dockerfile"), "FROM alpine\nCOPY . /app\n");
    writeFileSync(join(dir, ".env"), "KEY=1");
    const plan = new DockerTool(dir).plan(["build", "-t", "app", "."]);
    expect(plan).toMatchObject({ ok: false });
    expect(plan.ok ? "" : plan.message).toContain(".env");
  });

  it("labels what it creates and leaves the container command alone", () => {
    const tool = new DockerTool(dir);
    const run = tool.plan([
      "run",
      "-d",
      "--rm",
      "--name",
      "web",
      "-p",
      "127.0.0.1:8080:80",
      "-e",
      "MODE=dev",
      "-v",
      "pgdata:/var/lib/postgresql",
      "--mount",
      "type=tmpfs,dst=/cache",
      "-it",
      "alpine",
      "ls",
      "-v",
      "/",
    ]);
    expect(run).toMatchObject({ ok: true });
    expect(run.ok && run.args.slice(0, 3)).toEqual(["run", "--label", AGENT_LABEL]);

    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "Dockerfile"), "FROM alpine\n");
    const build = tool.plan(["build", "-t", "app:dev", "-f", "app/Dockerfile", "app"]);
    expect(build).toMatchObject({ ok: true });
    expect(build.ok && build.args.slice(0, 3)).toEqual(["build", "--label", AGENT_LABEL]);
  });

  it("only touches containers this agent created", async () => {
    const labels: Record<string, string> = { mine: "true" };
    const tool = new DockerTool(dir, { labelOf: async (t) => labels[t] });
    for (const args of [
      ["exec", "postgres", "env"],
      ["inspect", "postgres"],
      ["logs", "postgres"],
      ["stop", "postgres"],
      ["rm", "-f", "postgres"],
      ["stop", "mine", "postgres"],
    ]) {
      const result = await tool.call({ args });
      expect(result.error).toBe("DisallowedDockerCommandError");
      expect(result.message).toContain("not created by this agent");
    }
    const own = await tool.call({ args: ["logs", "--tail", "20", "mine"] });
    expect(own.error).toBeUndefined();
    const followed = await tool.call({ args: ["logs", "-f", "mine"] });
    expect(followed.error).toBe("DisallowedDockerCommandError");
    const execEnv = await tool.call({ args: ["exec", "-e", "OLLAMA_API_KEY", "mine", "env"] });
    expect(execEnv.error).toBe("DisallowedDockerCommandError");
  });

  it("is not mounted by registerBaseTools unless opted in", () => {
    const off = new AgentToolManager();
    off.registerBaseTools(dir);
    expect(off.mountedPacks.has("docker")).toBe(false);
    const on = new AgentToolManager();
    on.registerBaseTools(dir, undefined, undefined, undefined, { dockerTool: true });
    expect(on.mountedPacks.has("docker")).toBe(true);
  });
});
