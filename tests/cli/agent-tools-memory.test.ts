/**
 * Tests for the default-on semantic-memory wiring in AgentToolManager.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolManager } from "../../src/cli/agent-tools.js";
import { resetDeprecationWarnings, suppressDeprecationWarnings } from "../../src/platform/environment.js";

describe("AgentToolManager intelligence wiring", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-memtools-"));
    suppressDeprecationWarnings(true);
    resetDeprecationWarnings();
    delete process.env.NEXUM_SEMANTIC_MEMORY;
  });

  afterEach(() => {
    suppressDeprecationWarnings(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("registerBaseTools auto-mounts the memory pack (default-on)", () => {
    const manager = new AgentToolManager();
    manager.registerBaseTools(dir);
    expect(manager.mountedPacks.has("memory")).toBe(true);
    expect(manager.kernelCatalog.get("memory_save")).toBeDefined();
    expect(manager.kernelCatalog.get("memory_recall")).toBeDefined();
    expect(existsSync(join(dir, ".nexum", "memory.db"))).toBe(true);
  });

  it("reuses the same semantic memory instance on repeat calls", () => {
    const manager = new AgentToolManager();
    manager.registerIntelligenceTools(dir);
    const first = manager.semanticMemory;
    manager.registerIntelligenceTools(dir);
    expect(manager.semanticMemory).toBe(first);
  });

  it("honors the NEXUM_SEMANTIC_MEMORY=0 kill switch", () => {
    process.env.NEXUM_SEMANTIC_MEMORY = "0";
    const manager = new AgentToolManager();
    manager.registerBaseTools(dir);
    expect(manager.mountedPacks.has("memory")).toBe(false);
  });
});
