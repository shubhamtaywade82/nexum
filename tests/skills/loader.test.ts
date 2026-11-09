import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, loadSkillContent, loadSkillMeta } from "../../src/skills/loader.js";

function writeSkill(root: string, id: string, frontmatter: string, body = "# Body\n\ncontent"): string {
  const dir = join(root, ".devagent", "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
  return dir;
}

describe("loadSkillMeta / discoverSkills", () => {
  let workspaceRoot: string;
  let homeDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "devagent-ws-"));
    homeDir = mkdtempSync(join(tmpdir(), "devagent-home-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("parses frontmatter and uses the directory name as id", () => {
    const dir = writeSkill(
      workspaceRoot,
      "rails-api",
      "name: Rails API\ndescription: REST APIs\ntags: [rails, api]\nversion: 1.2.0",
    );
    const meta = loadSkillMeta(dir, "workspace");
    expect(meta).toMatchObject({
      id: "rails-api",
      name: "Rails API",
      description: "REST APIs",
      tags: ["rails", "api"],
      version: "1.2.0",
      scope: "workspace",
    });
  });

  it("falls back to defaults for missing frontmatter fields", () => {
    const dir = writeSkill(workspaceRoot, "bare", "name: Bare");
    const meta = loadSkillMeta(dir, "workspace");
    expect(meta).toMatchObject({ id: "bare", description: "", tags: [], version: "0.0.0" });
  });

  it("returns null for a missing SKILL.md", () => {
    const dir = join(workspaceRoot, ".devagent", "skills", "ghost");
    mkdirSync(dir, { recursive: true });
    expect(loadSkillMeta(dir, "workspace")).toBeNull();
  });

  it("discoverSkills finds workspace and global skills, workspace wins on id collision", () => {
    writeSkill(homeDir, "shared", "name: Global Version\ndescription: from global");
    writeSkill(homeDir, "global-only", "name: Global Only");
    writeSkill(workspaceRoot, "shared", "name: Workspace Version\ndescription: from workspace");

    const found = discoverSkills({ workspaceRoot, homeDir, workspaceTrusted: true });
    const byId = new Map(found.map((s) => [s.id, s]));

    expect(byId.get("shared")).toMatchObject({ name: "Workspace Version", scope: "workspace" });
    expect(byId.get("global-only")).toMatchObject({ name: "Global Only", scope: "global" });
    expect(found).toHaveLength(2);
  });

  it("skips a directory with no SKILL.md rather than throwing", () => {
    mkdirSync(join(workspaceRoot, ".devagent", "skills", "empty-dir"), { recursive: true });
    writeSkill(workspaceRoot, "valid", "name: Valid");
    expect(() => discoverSkills({ workspaceRoot, homeDir, workspaceTrusted: true })).not.toThrow();
    expect(discoverSkills({ workspaceRoot, homeDir, workspaceTrusted: true }).map((s) => s.id)).toEqual(["valid"]);
  });

  it("returns an empty list when no skills directories exist", () => {
    expect(discoverSkills({ workspaceRoot, homeDir, workspaceTrusted: true })).toEqual([]);
  });
  it("withholds workspace skills unless the caller establishes trust (fail closed by default)", () => {
    writeSkill(workspaceRoot, "repo-skill", "name: Repo Skill");
    writeSkill(homeDir, "global-skill", "name: Global Skill");

    expect(discoverSkills({ workspaceRoot, homeDir }).map((s) => s.id)).toEqual(["global-skill"]);
    expect(
      discoverSkills({ workspaceRoot, homeDir, workspaceTrusted: true })
        .map((s) => s.id)
        .sort(),
    ).toEqual(["global-skill", "repo-skill"]);
  });

  it("reads disable-model-invocation instead of ignoring it", () => {
    const manual = writeSkill(workspaceRoot, "manual", "name: Manual\ndisable-model-invocation: true");
    const auto = writeSkill(workspaceRoot, "auto", "name: Auto");

    expect(loadSkillMeta(manual, "workspace")?.disableModelInvocation).toBe(true);
    expect(loadSkillMeta(auto, "workspace")?.disableModelInvocation).toBeUndefined();
  });
});

describe("loadSkillContent", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "devagent-ws-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("strips frontmatter from the body and lists resource files", () => {
    const dir = writeSkill(workspaceRoot, "with-resources", "name: With Resources", "# Heading\n\nSome body text.");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "references", "notes.md"), "notes");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh");

    const meta = loadSkillMeta(dir, "workspace")!;
    const content = loadSkillContent(meta);

    expect(content.body).toBe("# Heading\n\nSome body text.");
    expect(content.references).toEqual(["notes.md"]);
    expect(content.scripts).toEqual(["run.sh"]);
    expect(content.templates).toEqual([]);
  });

  it("discovers skills from the canonical .nexum/skills location", () => {
    const ws = mkdtempSync(join(tmpdir(), "nexum-skills-ws-"));
    const home = mkdtempSync(join(tmpdir(), "nexum-skills-home-"));
    try {
      const dir = join(ws, ".nexum", "skills", "nexum-skill");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: Nexum Skill\ndescription: canonical location\n---\nbody");

      const found = discoverSkills({ workspaceRoot: ws, homeDir: home, workspaceTrusted: true });
      expect(found.map((s) => s.id)).toContain("nexum-skill");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still discovers legacy .devagent/skills as a deprecated fallback", () => {
    const ws = mkdtempSync(join(tmpdir(), "nexum-skills-ws-"));
    const home = mkdtempSync(join(tmpdir(), "nexum-skills-home-"));
    try {
      const dir = join(ws, ".devagent", "skills", "legacy-skill");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: Legacy Skill\ndescription: legacy location\n---\nbody");

      const found = discoverSkills({ workspaceRoot: ws, homeDir: home, workspaceTrusted: true });
      expect(found.map((s) => s.id)).toContain("legacy-skill");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("canonical .nexum/skills wins over a same-id legacy .devagent/skills copy", () => {
    const ws = mkdtempSync(join(tmpdir(), "nexum-skills-ws-"));
    const home = mkdtempSync(join(tmpdir(), "nexum-skills-home-"));
    try {
      for (const [dirName, skillName] of [
        [".devagent", "Legacy Version"],
        [".nexum", "Canonical Version"],
      ] as const) {
        const dir = join(ws, dirName, "skills", "dupe");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skillName}\ndescription: d\n---\nbody`);
      }
      const found = discoverSkills({ workspaceRoot: ws, homeDir: home, workspaceTrusted: true });
      expect(found.find((s) => s.id === "dupe")?.name).toBe("Canonical Version");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
