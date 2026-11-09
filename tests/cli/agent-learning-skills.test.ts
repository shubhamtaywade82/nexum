/**
 * A repository's skills reach the system prompt only once the workspace is
 * trusted, and trust granted mid-session takes effect on the next turn.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLearning } from "../../src/cli/agent-learning.js";
import { trustWorkspace, WorkspaceTrustStore } from "../../src/cli/workspace-trust.js";
import { MemoryStore } from "../../src/memory/store.js";
import type { Provider } from "../../src/models/adapters/provider.js";

let base: string;
let root: string;
let store: WorkspaceTrustStore;
let memory: MemoryStore;
const savedCwd = process.cwd();

function writeRepoSkill(id: string, frontmatter: string): void {
  const dir = join(root, ".nexum", "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${id}\n\nSteps.`);
}

function makeLearning(): AgentLearning {
  return new AgentLearning({
    workspaceRoot: root,
    provider: {} as Provider,
    memory,
    skillsHomeDir: join(base, "home"),
    enableExperienceIngestion: false,
    trustStore: store,
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "nexum-learning-skills-")));
  root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  store = WorkspaceTrustStore.at(join(base, "home", ".nexum", "trusted-workspaces.json"));
  memory = new MemoryStore(join(base, "memory.db"));
  process.chdir(root);
});

afterEach(() => {
  process.chdir(savedCwd);
  memory.close();
  rmSync(base, { recursive: true, force: true });
});

describe("AgentLearning workspace skill gate", () => {
  it("withholds a repository's skill until trust is granted, then loads it on the next turn", () => {
    writeRepoSkill("rails-api", "name: Rails API\ndescription: REST design\ntags: [rails, api]");
    const learning = makeLearning();

    expect(learning.getSkillsRegistry().list()).toEqual([]);
    expect(learning.resolveForPrompt("help me build a rails api")).toEqual([]);
    expect(learning.skillsWithheldReason()).toMatch(/nexum trust/);

    trustWorkspace(root, store);

    expect(learning.resolveForPrompt("help me build a rails api").map((s) => s.id)).toEqual(["rails-api"]);
    expect(learning.skillsWithheldReason()).toBeNull();
  });

  it("reports the withheld state once, and again only when it changes", () => {
    writeRepoSkill("rails-api", "name: Rails API");
    const learning = makeLearning();

    expect(learning.takeWithheldNotice()).toMatch(/nexum trust/);
    expect(learning.takeWithheldNotice()).toBeNull();

    trustWorkspace(root, store);
    expect(learning.takeWithheldNotice()).toBeNull(); // now loaded: nothing to report
  });

  it("a disable-model-invocation skill is never auto-selected but still loads when pinned", () => {
    writeRepoSkill(
      "deploy-prod",
      "name: Deploy\ndescription: prod deploy\ntags: [deploy]\ndisable-model-invocation: true",
    );
    trustWorkspace(root, store);
    const learning = makeLearning();

    expect(learning.resolveForPrompt("deploy the production service")).toEqual([]);

    learning.pinSkill("deploy-prod");
    expect(learning.resolveForPrompt("anything at all").map((s) => s.id)).toEqual(["deploy-prod"]);
  });
});
