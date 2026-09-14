import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../../src/cli/config.js";

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

  it("puts OLLAMA_API_KEY first in the pool", () => {
    process.env.OLLAMA_API_KEY = "primary_key";
    expect(loadConfig().apiKeys).toEqual(["primary_key"]);
  });

  it("appends comma-separated OLLAMA_API_KEYS after the primary key", () => {
    process.env.OLLAMA_API_KEY = "primary_key";
    process.env.OLLAMA_API_KEYS = "second_key, third_key";
    expect(loadConfig().apiKeys).toEqual(["primary_key", "second_key", "third_key"]);
  });

  it("loads API keys and config from workspace .env files", () => {
    delete process.env.DEVAGENT_TEST_NO_GLOBAL;
    delete process.env.NEXUM_TEST_NO_GLOBAL;
    delete process.env.OLLAMA_API_KEY;
    writeFileSync(join(workspaceRoot, ".env"), "OLLAMA_API_KEY=env_workspace_key\nNEXUM_TIER=cloud\n");
    const cfg = loadConfig();
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

  it("still honours an explicit host from the config file on the cloud tier", () => {
    mkdirSync(join(workspaceRoot, ".devagent"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".devagent", "config.json"), JSON.stringify({ host: "https://proxy.example" }));
    process.env.OLLAMA_HOST = "http://127.0.0.1:9999";
    process.env.DEVAGENT_TIER = "cloud";
    expect(loadConfig().host).toBe("https://proxy.example");
  });

  it("defaults sandbox to true", () => {
    expect(loadConfig().sandbox).toBe(true);
  });

  it("disables sandbox when NEXUM_SANDBOX=false", () => {
    process.env.NEXUM_SANDBOX = "false";
    expect(loadConfig().sandbox).toBe(false);
  });
});
