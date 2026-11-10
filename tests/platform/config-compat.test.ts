import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveWorkspaceConfig } from "../../src/cli/config.js";
import { suppressDeprecationWarnings } from "../../src/platform/environment.js";

const savedEnv = { ...process.env };

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * End-to-end compatibility matrix from docs/REBRANDING.md §8 — what a user
 * upgrading from devagent-ts 1.x experiences, asserted at the loadConfig()
 * level (env + config-file layers together).
 */
describe("loadConfig — DevAgent → Nexum compatibility matrix", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    suppressDeprecationWarnings(true); // keep test output clean
    workspaceRoot = mkdtempSync(join(tmpdir(), "nexum-config-"));
    process.env = { ...savedEnv };
    setEnv("NEXUM_WORKSPACE", workspaceRoot);
    setEnv("DEVAGENT_WORKSPACE", undefined);
    setEnv("NEXUM_TEST_NO_GLOBAL", "true");
    setEnv("DEVAGENT_TEST_NO_GLOBAL", undefined);
    setEnv("NEXUM_MODEL", undefined);
    setEnv("DEVAGENT_MODEL", undefined);
    setEnv("NEXUM_TIER", undefined);
    setEnv("DEVAGENT_TIER", undefined);
    setEnv("NEXUM_AUTO_APPROVE", undefined);
    setEnv("DEVAGENT_AUTO_APPROVE", undefined);
    setEnv("OLLAMA_API_KEY", undefined);
    setEnv("OLLAMA_API_KEYS", undefined);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("new NEXUM_MODEL variable works (canonical path)", () => {
    setEnv("NEXUM_MODEL", "canonical-model");
    expect(loadConfig().model).toBe("canonical-model");
  });

  it("old DEVAGENT_MODEL variable still works (deprecated fallback)", () => {
    setEnv("DEVAGENT_MODEL", "legacy-model");
    expect(loadConfig().model).toBe("legacy-model");
  });

  it("NEXUM_MODEL beats DEVAGENT_MODEL when both are set", () => {
    setEnv("NEXUM_MODEL", "canonical");
    setEnv("DEVAGENT_MODEL", "legacy");
    expect(loadConfig().model).toBe("canonical");
  });

  it("legacy .devagent/config.json is still read", () => {
    mkdirSync(join(workspaceRoot, ".devagent"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".devagent", "config.json"), JSON.stringify({ model: "from-legacy-file" }));
    expect(loadConfig().model).toBe("from-legacy-file");
  });

  it("canonical .nexum/config.json wins key-by-key over legacy .devagent/config.json", () => {
    mkdirSync(join(workspaceRoot, ".devagent"), { recursive: true });
    mkdirSync(join(workspaceRoot, ".nexum"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".devagent", "config.json"),
      JSON.stringify({ model: "legacy-model", toolSelectionMode: "heuristic" }),
    );
    writeFileSync(join(workspaceRoot, ".nexum", "config.json"), JSON.stringify({ model: "canonical-model" }));
    const cfg = loadConfig();
    expect(cfg.model).toBe("canonical-model"); // canonical file wins
    expect(cfg.toolSelectionMode).toBe("heuristic"); // legacy-only key survives
  });

  it("saveWorkspaceConfig writes .nexum/config.json (never .devagent)", () => {
    saveWorkspaceConfig(workspaceRoot, { model: "saved-model" });
    expect(join(workspaceRoot, ".nexum", "config.json")).toBeTruthy();
    const fs = jest.requireActual("node:fs") as typeof import("node:fs");
    expect(fs.existsSync(join(workspaceRoot, ".nexum", "config.json"))).toBe(true);
    expect(fs.existsSync(join(workspaceRoot, ".devagent", "config.json"))).toBe(false);
    expect(loadConfig().model).toBe("saved-model");
  });

  it("NEXUM.md is honored as a project-rules file alongside AGENTS.md/DEVAGENT.md", () => {
    writeFileSync(join(workspaceRoot, "NEXUM.md"), "Always write tests first.");
    const cfg = loadConfig();
    expect(cfg.systemPrompt).toContain("Always write tests first.");
  });

  it("legacy DEVAGENT_TIER=cloud still routes to the cloud tier", () => {
    setEnv("DEVAGENT_TIER", "cloud");
    expect(loadConfig().tier).toBe("cloud");
  });

  it("legacy DEVAGENT_AUTO_APPROVE=false can switch off a config-file true", () => {
    mkdirSync(join(workspaceRoot, ".nexum"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".nexum", "config.json"), JSON.stringify({ autoApprove: true }));
    setEnv("DEVAGENT_AUTO_APPROVE", "false");
    expect(loadConfig().autoApprove).toBe(false);
  });

  it("defaults apply when nothing is set (fresh-workspace startup)", () => {
    const cfg = loadConfig();
    expect(cfg.model).toBe("qwen3.5:4b");
    expect(cfg.tier).toBe("local");
    expect(cfg.autoApprove).toBe(false);
  });
});
