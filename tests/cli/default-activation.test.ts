import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config.js";

/**
 * Functional capabilities are on by default and need no enabling env or flag.
 * The Docker sandbox family remains independently configurable. These tests pin
 * both halves so a regression in either direction shows up.
 */

const CONFIG_ENV = [
  "NEXUM_DECISION",
  "NEXUM_SELF_CONSISTENCY",
  "NEXUM_VERIFIER",
  "NEXUM_SANDBOX",
  "NEXUM_DOCKER_TOOL",
  "NEXUM_DOCKER_EGRESS",
  "NEXUM_AUTO_APPROVE",
  "NEXUM_AUTO_PLAN",
  "NEXUM_PLAN_HINT",
  "NEXUM_LOCAL_WORKER",
  "NEXUM_HEURISTIC_GATE",
  "NEXUM_AVAIL_CHECK",
  "NEXUM_WRITE_SCOPE",
  "NEXUM_QUICK_MODEL",
] as const;

describe("default activation", () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    for (const name of CONFIG_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    saved.HOME = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), "defaults-home-"));
    workspace = await mkdtemp(join(tmpdir(), "defaults-ws-"));
    process.env.HOME = home;
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it("turns on the model-side features without any env or flag", () => {
    const cfg = loadConfig({ workspaceRoot: workspace });

    expect(cfg.enableDecision).toBe(true);
    expect(cfg.enableSelfConsistency).toBe(true);
    expect(cfg.enableVerifier).toBe(true);
    expect(cfg.autoApprove).toBe(true);
    expect(cfg.enableLocalWorker).toBe(true);
    expect(cfg.enableHeuristicGate).toBe(true);
    expect(cfg.enableAvailabilityCheck).toBe(true);
    expect(cfg.autoPlan).toBe("always");
  });

  it("keeps the sandbox optional: on by default, switched off only by its own env", () => {
    expect(loadConfig({ workspaceRoot: workspace }).sandbox).toBe(true);

    process.env.NEXUM_SANDBOX = "false";
    expect(loadConfig({ workspaceRoot: workspace }).sandbox).toBe(false);
  });

  it("keeps Docker daemon access and container egress disabled by default", () => {
    const cfg = loadConfig({ workspaceRoot: workspace });

    expect(cfg.dockerTool).toBe(false);
    expect(cfg.dockerEgress).toBe(false);
  });

  it("keeps the critic pass active with or without a separately configured quick model", () => {
    expect(loadConfig({ workspaceRoot: workspace }).enableVerifier).toBe(true);

    process.env.NEXUM_QUICK_MODEL = "quick-model";
    expect(loadConfig({ workspaceRoot: workspace }).enableVerifier).toBe(true);
  });

  it("still lets env turn the on-by-default features off", () => {
    process.env.NEXUM_DECISION = "false";
    process.env.NEXUM_SELF_CONSISTENCY = "false";
    const cfg = loadConfig({ workspaceRoot: workspace });

    expect(cfg.enableDecision).toBe(false);
    expect(cfg.enableSelfConsistency).toBe(false);

    process.env.NEXUM_AUTO_APPROVE = "false";
    process.env.NEXUM_AUTO_PLAN = "ask";
    const overridden = loadConfig({ workspaceRoot: workspace });
    expect(overridden.autoApprove).toBe(false);
    expect(overridden.autoPlan).toBe("ask");
  });
});
