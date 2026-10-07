import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/cli/config.js";
import { trustWorkspace, WorkspaceTrustStore } from "../../src/cli/workspace-trust.js";

describe("loadConfig apiKeys pool", () => {
  const originalEnv = { ...process.env };
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "config-test-"));
    process.env.DEVAGENT_WORKSPACE = workspaceRoot;
    process.env.DEVAGENT_TEST_NO_GLOBAL = "true";
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEYS;
    delete process.env.DEVAGENT_TIER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is undefined when no keys are configured anywhere", () => {
    expect(loadConfig().apiKeys).toBeUndefined();
  });

  it("resolves NEXUM_WRITE_SCOPE against the workspace root and leaves it unset by default", () => {
    delete process.env.NEXUM_WRITE_SCOPE;
    expect(loadConfig().writeScope).toBeUndefined();
    process.env.NEXUM_WRITE_SCOPE = "src";
    expect(loadConfig().writeScope).toBe(join(workspaceRoot, "src"));
    process.env.NEXUM_WRITE_SCOPE = "/abs/scope";
    expect(loadConfig().writeScope).toBe("/abs/scope");
  });

  it("puts OLLAMA_API_KEY first in the pool", () => {
    process.env.OLLAMA_API_KEY = "primary_key";
    expect(loadConfig().apiKeys).toEqual(["primary_key"]);
  });

  it("appends comma-separated OLLAMA_API_KEYS after the primary key", () => {
    process.env.OLLAMA_API_KEY = "primary_key";
    process.env.OLLAMA_API_KEYS = "second_key, third_key";
    expect(loadConfig().apiKeys).toEqual(["primary_key", "second_key", "third_key"]);
  });

  it("pairs structured accounts with the labels /usage and /balance print", () => {
    mkdirSync(join(workspaceRoot, ".nexum"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".nexum", "config.json"),
      JSON.stringify({
        apiKeys: ["acct_one"],
        accounts: [
          { apiKey: "acct_one", label: "me@example.com" },
          { apiKey: "acct_two", label: "  work  " },
          { apiKey: "acct_three" },
        ],
      }),
    );
    const trustStore = WorkspaceTrustStore.inMemory();
    trustWorkspace(workspaceRoot, trustStore);
    const cfg = loadConfig({ trustStore });

    // the flat list stays the ordered pool; accounts contribute their keys too
    expect(cfg.apiKeys).toEqual(["acct_one", "acct_two", "acct_three"]);
    expect(cfg.accountLabels).toEqual({ acct_one: "me@example.com", acct_two: "work" });
    // no label -> no entry, so the provider falls back to a masked key suffix
    expect(cfg.accountLabels).not.toHaveProperty("acct_three");
  });

  // Credentials are not WORKSPACE_SAFE_KEYS: a checked-in config cannot inject
  // an API key (or redirect usage reporting) before the workspace is trusted.
  it("ignores accounts from an untrusted workspace", () => {
    mkdirSync(join(workspaceRoot, ".nexum"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".nexum", "config.json"),
      JSON.stringify({ accounts: [{ apiKey: "untrusted_key", label: "intruder" }] }),
    );
    const cfg = loadConfig({ trustStore: WorkspaceTrustStore.inMemory() });
    expect(cfg.apiKeys).toBeUndefined();
    expect(cfg.accountLabels).toBeUndefined();
  });

  it("loads API keys and config from workspace .env files", () => {
    delete process.env.DEVAGENT_TEST_NO_GLOBAL;
    delete process.env.NEXUM_TEST_NO_GLOBAL;
    delete process.env.OLLAMA_API_KEY;
    writeFileSync(join(workspaceRoot, ".env"), "OLLAMA_API_KEY=env_workspace_key\nNEXUM_TIER=cloud\n");
    // a workspace .env is repository content: it loads once the workspace is trusted
    const trustStore = WorkspaceTrustStore.inMemory();
    trustWorkspace(workspaceRoot, trustStore);
    const cfg = loadConfig({ trustStore });
    expect(cfg.apiKey).toBe("env_workspace_key");
    expect(cfg.tier).toBe("cloud");
  });
});

describe("workspace root resolution (git-root, like most editor tooling)", () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.DEVAGENT_WORKSPACE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
  });

  it("finds the project root via .git even with no .devagent yet (first run in a new project)", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gitroot-test-")));
    mkdirSync(join(projectRoot, ".git"));
    const nested = join(projectRoot, "src", "deep", "nested");
    mkdirSync(nested, { recursive: true });

    process.chdir(nested);
    expect(loadConfig().workspaceRoot).toBe(projectRoot);
  });

  it("finds the project root when launched from a subdirectory with no .devagent yet", async () => {
    // Regression: a prior session created .devagent at the git root; a new
    // session launched from a different, still-.devagent-less subdirectory
    // must resolve to the same root, not fork off a fresh one.
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gitroot-test-")));
    mkdirSync(join(projectRoot, ".git"));
    mkdirSync(join(projectRoot, ".devagent"));
    const otherSubdir = join(projectRoot, "packages", "other");
    mkdirSync(otherSubdir, { recursive: true });

    process.chdir(otherSubdir);
    expect(loadConfig().workspaceRoot).toBe(projectRoot);
  });

  it("falls back to nearest .devagent when there is no .git", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "devagent-only-test-")));
    mkdirSync(join(projectRoot, ".devagent"));
    const nested = join(projectRoot, "sub");
    mkdirSync(nested);

    process.chdir(nested);
    expect(loadConfig().workspaceRoot).toBe(projectRoot);
  });

  it("prefers .git over a farther-out .devagent when both exist at different levels", async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), "outer-devagent-")));
    mkdirSync(join(outer, ".devagent"));
    const inner = join(outer, "project");
    mkdirSync(inner);
    mkdirSync(join(inner, ".git"));

    process.chdir(inner);
    expect(loadConfig().workspaceRoot).toBe(inner);
  });

  it("DEVAGENT_WORKSPACE still overrides everything", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "gitroot-test-")));
    mkdirSync(join(projectRoot, ".git"));
    const override = await realpath(await mkdtemp(join(tmpdir(), "override-test-")));

    process.env.DEVAGENT_WORKSPACE = override;
    process.chdir(projectRoot);
    expect(loadConfig().workspaceRoot).toBe(override);
  });
});

describe("enableHeuristicGate flag", () => {
  const originalEnv = { ...process.env };
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "config-test-"));
    process.env.DEVAGENT_WORKSPACE = workspaceRoot;
    delete process.env.DEVAGENT_HEURISTIC_GATE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to true", () => {
    expect(loadConfig().enableHeuristicGate).toBe(true);
  });

  it("is false when DEVAGENT_HEURISTIC_GATE=false", () => {
    process.env.DEVAGENT_HEURISTIC_GATE = "false";
    expect(loadConfig().enableHeuristicGate).toBe(false);
  });
});

describe("loadConfig host/tier interaction", () => {
  const originalEnv = { ...process.env };
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "config-host-"));
    process.env.DEVAGENT_WORKSPACE = workspaceRoot;
    delete process.env.OLLAMA_HOST;
    delete process.env.DEVAGENT_TIER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses OLLAMA_HOST for the local tier", () => {
    process.env.OLLAMA_HOST = "http://127.0.0.1:9999";
    const cfg = loadConfig();
    expect(cfg.tier).toBe("local");
    expect(cfg.host).toBe("http://127.0.0.1:9999");
  });

  // OLLAMA_HOST is the local-Ollama convention. Returning it for a cloud-tier
  // config pointed Cloud requests -- Bearer token attached -- at the user's
  // own localhost.
  it("ignores OLLAMA_HOST when the tier is cloud", () => {
    process.env.OLLAMA_HOST = "http://127.0.0.1:9999";
    process.env.DEVAGENT_TIER = "cloud";
    const cfg = loadConfig();
    expect(cfg.tier).toBe("cloud");
    expect(cfg.host).toBeUndefined();
  });

  it("still honours an explicit host from a trusted workspace config on the cloud tier", () => {
    mkdirSync(join(workspaceRoot, ".devagent"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".devagent", "config.json"), JSON.stringify({ host: "https://proxy.example" }));
    process.env.OLLAMA_HOST = "http://127.0.0.1:9999";
    process.env.DEVAGENT_TIER = "cloud";
    // untrusted, a repository cannot redirect model traffic (prompts, code, bearer token)
    expect(loadConfig().host).toBeUndefined();
    const trustStore = WorkspaceTrustStore.inMemory();
    trustWorkspace(workspaceRoot, trustStore);
    expect(loadConfig({ trustStore }).host).toBe("https://proxy.example");
  });

  it("defaults sandbox to true", () => {
    expect(loadConfig().sandbox).toBe(true);
  });

  it("disables sandbox when NEXUM_SANDBOX=false", () => {
    process.env.NEXUM_SANDBOX = "false";
    expect(loadConfig().sandbox).toBe(false);
  });
});

describe("parseAutoPlan", () => {
  it("accepts the three modes, honours the legacy hint switch, and defaults to ask", async () => {
    const { parseAutoPlan } = await import("../../src/cli/config.js");
    expect(parseAutoPlan("always")).toBe("always");
    expect(parseAutoPlan(" OFF ")).toBe("off");
    expect(parseAutoPlan("ask")).toBe("ask");
    expect(parseAutoPlan(undefined, "0")).toBe("off");
    expect(parseAutoPlan("nonsense")).toBe("ask");
    expect(parseAutoPlan(undefined)).toBe("ask");
  });
});

describe("commented config file (config.example.jsonc)", () => {
  const originalEnv = { ...process.env };
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "config-jsonc-")));
    process.env.DEVAGENT_WORKSPACE = workspaceRoot;
    mkdirSync(join(workspaceRoot, ".nexum"), { recursive: true });
    // anything the example sets must not be shadowed by the shell's own config
    for (const key of ["MODEL", "TIER", "HOST", "SHELL_TIMEOUT_SEC", "MAX_ACTIVE_TOOLS", "SANDBOX"]) {
      delete process.env[`NEXUM_${key}`];
      delete process.env[`DEVAGENT_${key}`];
    }
    delete process.env.OLLAMA_HOST;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("accepts // and /* */ comments and keeps // inside string literals", () => {
    writeFileSync(
      join(workspaceRoot, ".nexum", "config.json"),
      `{
        // project default model
        "model": "commented-model", // trailing comment
        /* block comment */
        "host": "http://127.0.0.1:11434",
        "writeScope": "src"
      }`,
    );
    const trustStore = WorkspaceTrustStore.inMemory();
    trustWorkspace(workspaceRoot, trustStore);
    const cfg = loadConfig({ trustStore });

    expect(cfg.model).toBe("commented-model");
    expect(cfg.writeScope).toBe(join(workspaceRoot, "src"));
    // the "//" inside the URL was not mistaken for a comment
    expect(cfg.host).toBe("http://127.0.0.1:11434");
  });

  it("still falls back to defaults when the file is genuinely malformed", () => {
    writeFileSync(join(workspaceRoot, ".nexum", "config.json"), '{ "model": "broken" ');
    const cfg = loadConfig({ trustStore: WorkspaceTrustStore.inMemory() });
    expect(cfg.model).toBe("qwen3.5:4b");
  });

  it("ships a config.example.jsonc that actually parses", () => {
    const example = fileURLToPath(new URL("../../config.example.jsonc", import.meta.url));
    copyFileSync(example, join(workspaceRoot, ".nexum", "config.json"));
    const trustStore = WorkspaceTrustStore.inMemory();
    trustWorkspace(workspaceRoot, trustStore);
    const cfg = loadConfig({ trustStore });

    // these are unset unless the example's values were read
    expect(cfg.shellTimeoutSec).toBe(30);
    expect(cfg.maxActiveTools).toBe(8);
    expect(cfg.autoApprove).toBe(false);
    expect(cfg.sandbox).toBe(true);
  });
});
