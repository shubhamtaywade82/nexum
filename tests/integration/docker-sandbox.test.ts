/**
 * REAL-DAEMON integration tests for the sandbox boundary. Opt-in:
 *
 *   docker build -t nexum-sandbox:latest docker/nexum-sandbox/
 *   npm run test:docker
 *
 * Unit tests check the generated `docker run` arguments; these check that a
 * real daemon actually enforces them (secret masking, read-only git
 * internals, write scope, no network, dropped privileges, labelled
 * ownership, no egress for docker-tool containers).
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellTool } from "../../src/tools/shell.js";
import { RunTestsTool } from "../../src/tools/project-tools.js";
import { DockerTool, AGENT_NETWORK } from "../../src/tools/docker-tools.js";

const enabled = process.env.NEXUM_DOCKER_TESTS === "1";
const describeIfDocker = enabled ? describe : describe.skip;
const IMAGE = "nexum-sandbox:latest";
const TIMEOUT = 180_000;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

describeIfDocker("sandbox boundary against a real Docker daemon", () => {
  let root: string;
  let shell: ShellTool;
  const run = async (command: string, tool: ShellTool = shell) => {
    const r = await tool.call({ command });
    return { exit: r.exitCode as number, out: String(r.stdout).trim(), err: String(r.stderr).trim() };
  };

  beforeAll(() => {
    try {
      docker("image", "inspect", IMAGE);
    } catch {
      throw new Error(`${IMAGE} is missing: docker build -t ${IMAGE} docker/nexum-sandbox/`);
    }
    root = realpathSync(mkdtempSync(join(tmpdir(), "nexum-docker-it-")));
    writeFileSync(join(root, ".env"), "API_KEY=sk-live-secret\n");
    linkSync(join(root, ".env"), join(root, "notes.txt"));
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "token.txt"), "tok\n");
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "app.txt"), "app\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('src/ran.txt','ok')\"" } }),
    );
    shell = new ShellTool({ workspaceRoot: root, timeoutSec: 120 });
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(
    "masks secrets, including hardlink aliases, but not ordinary files",
    async () => {
      expect((await run("wc -c < .env")).out).toBe("0");
      expect((await run("wc -c < notes.txt")).out).toBe("0");
      expect((await run("cat secrets/token.txt")).exit).not.toBe(0);
      expect((await run("cat app.txt")).out).toBe("app");
    },
    TIMEOUT,
  );

  it(
    "keeps .git hooks and config read-only",
    async () => {
      expect((await run("echo evil > .git/hooks/pre-commit")).exit).not.toBe(0);
      expect((await run("echo '[core] fsmonitor=x' >> .git/config")).exit).not.toBe(0);
      expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("[core]\n");
    },
    TIMEOUT,
  );

  it(
    "has no network, no capabilities, no privilege escalation and a read-only root filesystem",
    async () => {
      const net = await run(
        "node -e \"fetch('https://example.com').then(()=>console.log('NET')).catch(()=>console.log('NETFAIL'))\"",
      );
      expect(net.out).toBe("NETFAIL");
      const status = (await run("grep -E 'CapEff|NoNewPrivs' /proc/self/status")).out;
      expect(status).toMatch(/CapEff:\s+0{16}/);
      expect(status).toMatch(/NoNewPrivs:\s+1/);
      expect((await run("touch /etc/x")).exit).not.toBe(0);
      expect((await run("touch /tmp/x && echo ok")).out).toBe("ok");
    },
    TIMEOUT,
  );

  it(
    "writes as the host user, and only inside the write scope when one is set",
    async () => {
      expect((await run("echo x > created.txt && echo ok")).out).toBe("ok");
      expect(statSync(join(root, "created.txt")).uid).toBe(process.getuid!());
      const scoped = new ShellTool({ workspaceRoot: root, timeoutSec: 120, writeScope: join(root, "src") });
      expect((await run("echo x > outside.txt", scoped)).exit).not.toBe(0);
      expect((await run("echo x > src/inside.txt && echo ok", scoped)).out).toBe("ok");
    },
    TIMEOUT,
  );

  it(
    "runs package scripts inside the sandbox",
    async () => {
      const result = await new RunTestsTool(root, shell).call({});
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(root, "src", "ran.txt"), "utf8")).toBe("ok");
    },
    TIMEOUT,
  );

  describe("docker tool", () => {
    const tool = () => new DockerTool(root);
    const probe = "fetch('https://example.com').then(()=>console.log('NET')).catch(()=>console.log('NETFAIL'))";

    afterAll(() => {
      for (const name of ["nx-it-srv", "nx-it-foreign"]) {
        try {
          docker("rm", "-f", name);
        } catch {
          // already gone
        }
      }
    });

    it(
      "containers get no egress but reach each other on the internal agent network",
      async () => {
        const srv = await tool().call({
          args: [
            "run",
            "-d",
            "--name",
            "nx-it-srv",
            IMAGE,
            "node",
            "-e",
            "require('http').createServer((q,r)=>r.end('pong')).listen(80)",
          ],
        });
        expect(srv.exitCode).toBe(0);
        expect(docker("network", "inspect", "--format", "{{.Internal}}", AGENT_NETWORK)).toBe("true");
        await new Promise((r) => setTimeout(r, 1500));
        const egress = await tool().call({ args: ["run", "--rm", IMAGE, "node", "-e", probe] });
        expect(String(egress.stdout).trim()).toBe("NETFAIL");
        const peer = await tool().call({
          args: ["run", "--rm", IMAGE, "node", "-e", "fetch('http://nx-it-srv/').then(r=>r.text()).then(console.log)"],
        });
        expect(String(peer.stdout).trim()).toBe("pong");
      },
      TIMEOUT,
    );

    it(
      "only lists and touches containers it created",
      async () => {
        docker("run", "-d", "--name", "nx-it-foreign", IMAGE, "sleep", "300");
        const ps = await tool().call({ args: ["ps", "--format", "{{.Names}}"] });
        expect(String(ps.stdout)).not.toContain("nx-it-foreign");
        const inspect = await tool().call({ args: ["inspect", "nx-it-foreign"] });
        expect(inspect.error).toBe("DisallowedDockerCommandError");
      },
      TIMEOUT,
    );

    it(
      "builds without network",
      async () => {
        mkdirSync(join(root, "img"), { recursive: true });
        writeFileSync(join(root, "img", "Dockerfile"), `FROM ${IMAGE}\nRUN node -e "${probe}" > /probe.txt\n`);
        const build = await tool().call({ args: ["build", "--no-cache", "-t", "nx-it-img", "img"] });
        expect(build.exitCode).toBe(0);
        const out = await tool().call({ args: ["run", "--rm", "nx-it-img", "cat", "/probe.txt"] });
        expect(String(out.stdout).trim()).toBe("NETFAIL");
      },
      TIMEOUT,
    );
  });
});
