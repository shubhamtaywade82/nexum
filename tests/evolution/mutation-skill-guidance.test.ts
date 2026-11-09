/**
 * The mutation agent's process guidance is read from the repository's skill files,
 * and only when the workspace may load its skills.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMutationSkillGuidance } from "../../src/evolution/mutation/skill-guidance.js";

let root: string;
let home: string;

function writeSkill(id: string, body: string, extraFrontmatter = ""): void {
  const dir = join(root, ".nexum", "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: test\n${extraFrontmatter}---\n\n${body}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evo-guidance-ws-"));
  home = mkdtempSync(join(tmpdir(), "evo-guidance-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("loadMutationSkillGuidance", () => {
  it("puts the skill files' own text into the prompt, so an edit to a SKILL.md changes the agent's guidance", () => {
    writeSkill("diagnosing-bugs", "Build a red-capable loop before hypothesising. UNIQUE-DIAG-LINE");
    writeSkill("tdd", "Red, green, refactor. UNIQUE-TDD-LINE");

    const guidance = loadMutationSkillGuidance(root, { workspaceTrusted: true, homeDir: home });

    expect(guidance.text).toContain("UNIQUE-DIAG-LINE");
    expect(guidance.text).toContain("UNIQUE-TDD-LINE");
    expect(guidance.loaded).toEqual(["diagnosing-bugs", "tdd"]);
    expect(guidance.skipped).toEqual([
      { id: "codebase-design", reason: "missing" },
      { id: "code-review", reason: "missing" },
    ]);
  });

  it("loads nothing from an untrusted workspace: repository content must not steer the model before trust", () => {
    writeSkill("diagnosing-bugs", "UNIQUE-DIAG-LINE");

    const guidance = loadMutationSkillGuidance(root, { workspaceTrusted: false, homeDir: home });

    expect(guidance.text).toBe("");
    expect(guidance.loaded).toEqual([]);
  });

  it("does not inject a skill marked disable-model-invocation", () => {
    writeSkill("diagnosing-bugs", "UNIQUE-DIAG-LINE", "disable-model-invocation: true\n");

    const guidance = loadMutationSkillGuidance(root, { workspaceTrusted: true, homeDir: home });

    expect(guidance.text).not.toContain("UNIQUE-DIAG-LINE");
    expect(guidance.skipped).toContainEqual({ id: "diagnosing-bugs", reason: "user-invoked" });
  });

  it("keeps the total within the budget, truncating each skill's text", () => {
    writeSkill("diagnosing-bugs", "x".repeat(5_000));
    writeSkill("codebase-design", "y".repeat(5_000));
    writeSkill("tdd", "z".repeat(5_000));
    writeSkill("code-review", "w".repeat(5_000));

    const guidance = loadMutationSkillGuidance(root, { workspaceTrusted: true, homeDir: home, budgetChars: 1_000 });

    expect(guidance.text).toContain("[truncated]");
    expect(guidance.text.length).toBeLessThan(1_000 + 500);
  });
});
