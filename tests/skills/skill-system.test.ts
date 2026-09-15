/**
 * Tests for the SkillSystem (formal skill system).
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillSystem, FilesystemSkillProvider, InMemorySkillProvider } from "../../src/skills/index.js";
import type { SkillContent } from "../../src/skills/types.js";

// Re-export for test convenience.
export { SkillSystem, FilesystemSkillProvider, InMemorySkillProvider };

describe("InMemorySkillProvider", () => {
  it("lists and loads in-memory skills", async () => {
    const skill: SkillContent = {
      id: "test-skill",
      name: "Test Skill",
      description: "A test skill",
      tags: ["test"],
      version: "1.0.0",
      scope: "workspace",
      dir: "/tmp",
      path: "/tmp/SKILL.md",
      body: "This is the skill body.",
      references: [],
      scripts: [],
      templates: [],
    };
    const provider = new InMemorySkillProvider([skill]);
    const list = await provider.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("test-skill");
    const loaded = await provider.load(list[0]);
    expect(loaded.body).toBe("This is the skill body.");
  });
});

describe("SkillSystem", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-skills-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("with filesystem provider", () => {
    it("discovers skills from .nexum/skills/", async () => {
      const skillsDir = join(tmpDir, ".nexum", "skills", "crypto-futures");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, "SKILL.md"),
        `---
name: crypto-futures
description: Use when the user mentions crypto futures trading
tags: [crypto, futures, trading, binance]
version: 1.0.0
---

# Crypto Futures Trading Skill

This skill covers crypto futures trading strategies.
`,
      );

      const provider = new FilesystemSkillProvider({ workspaceRoot: tmpDir });
      const list = await provider.list();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("crypto-futures");
      expect(list[0].tags).toContain("crypto");
    });
  });

  describe("selectAndInject", () => {
    it("selects relevant skills based on prompt tags", async () => {
      const skill: SkillContent = {
        id: "crypto",
        name: "Crypto",
        description: "Use when the user mentions crypto trading",
        tags: ["crypto", "trading", "binance"],
        version: "1.0.0",
        scope: "workspace",
        dir: "/tmp",
        path: "/tmp/SKILL.md",
        body: "Crypto trading skill body.",
        references: [],
        scripts: [],
        templates: [],
      };
      const system = new SkillSystem([new InMemorySkillProvider([skill])]);
      const injection = await system.selectAndInject({
        prompt: "I want to trade crypto on Binance",
        maxSkills: 3,
      });
      expect(injection.injectedSkillIds).toContain("crypto");
      expect(injection.content).toContain("Crypto trading skill body");
      expect(injection.estimatedTokens).toBeGreaterThan(0);
    });

    it("returns empty injection when no skills match", async () => {
      const skill: SkillContent = {
        id: "ruby",
        name: "Ruby",
        description: "Ruby on Rails development",
        tags: ["ruby", "rails"],
        version: "1.0.0",
        scope: "workspace",
        dir: "/tmp",
        path: "/tmp/SKILL.md",
        body: "Ruby skill body.",
        references: [],
        scripts: [],
        templates: [],
      };
      const system = new SkillSystem([new InMemorySkillProvider([skill])]);
      const injection = await system.selectAndInject({
        prompt: "help me with python data science",
      });
      expect(injection.injectedSkillIds.length).toBe(0);
      expect(injection.content).toBe("");
    });

    it("excludes already-injected skills", async () => {
      const skill: SkillContent = {
        id: "crypto",
        name: "Crypto",
        description: "crypto trading",
        tags: ["crypto"],
        version: "1.0.0",
        scope: "workspace",
        dir: "/tmp",
        path: "/tmp/SKILL.md",
        body: "Crypto body.",
        references: [],
        scripts: [],
        templates: [],
      };
      const system = new SkillSystem([new InMemorySkillProvider([skill])]);
      const injection = await system.selectAndInject({
        prompt: "crypto trading help",
        alreadyInjected: ["crypto"],
      });
      expect(injection.injectedSkillIds.length).toBe(0);
    });
  });
});
