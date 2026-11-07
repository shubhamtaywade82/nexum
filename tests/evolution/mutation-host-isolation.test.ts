import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitWorktreeMutationExecutor } from "../../src/evolution/mutation/mutation-executor.js";
import { MutationScope } from "../../src/evolution/mutation/mutation-scope.js";
import { ImprovementTarget } from "../../src/evolution/targets/target-engine.js";

/**
 * The actuator executes candidate-controlled code on the host (verification
 * gates) and runs git commit hooks from the candidate worktree. Neither may
 * receive the operator's credentials. These tests run the real default runner
 * against a real git repository, with no injected fakes.
 */

const exec = promisify(execFile);
const SECRET = "ghp_regression_secret_do_not_leak";
const KEY_SECRET = "sk-regression-ollama-do-not-leak";

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  return res.stdout;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "isorepo-"));
  await mkdir(join(root, "src", "tools"), { recursive: true });
  await exec("git", ["init", "-q", "-b", "main", root]);
  await writeFile(join(root, "src", "tools", "index.ts"), "export const tools = 1;\n", "utf8");
  await writeFile(join(root, "README.md"), "repo\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function target(): ImprovementTarget {
  return {
    id: "target-tool_utilization-iso",
    capability: "tool_utilization",
    desiredOutcome: "Tool error rate drops",
    observableSymptoms: ["tool_selection failures"],
    measurableMetrics: ["reliability.toolErrorRate"],
    affectedComponents: ["tools"],
    confidence: 0.9,
    evaluationPlan: {
      successCriterion: "tool error rate drops",
      steps: [{ suite: "tool-calling", split: "visible", minRuns: 3 }],
      executorModels: ["qwen"],
    },
    sourceFailureClasses: ["tool_selection"],
    createdAt: Date.now(),
  };
}

function scope(): MutationScope {
  return { kind: "single_component", components: ["tools"], rationale: "isolation test scope" };
}

describe("mutation executor host isolation", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let repoRoot: string;
  let wsRoot: string;
  let markerDir: string;

  beforeEach(async () => {
    for (const name of ["GITHUB_TOKEN", "OLLAMA_API_KEY"]) savedEnv[name] = process.env[name];
    process.env.GITHUB_TOKEN = SECRET;
    process.env.OLLAMA_API_KEY = KEY_SECRET;
    repoRoot = await makeRepo();
    wsRoot = await mkdtemp(join(tmpdir(), "isows-"));
    markerDir = await mkdtemp(join(tmpdir(), "isomark-"));
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(repoRoot, { recursive: true, force: true });
    await rm(wsRoot, { recursive: true, force: true });
    await rm(markerDir, { recursive: true, force: true });
  });

  it("verification commands run without credential variables but keep ordinary ones", async () => {
    const executor = new GitWorktreeMutationExecutor({
      worktreeParentDir: wsRoot,
      verifyCommands: [
        [
          "node",
          "-e",
          "process.stdout.write(`${process.env.GITHUB_TOKEN ?? 'absent'}|${process.env.OLLAMA_API_KEY ?? 'absent'}|${Boolean(process.env.PATH)}`)",
        ],
      ],
    });
    const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
    const ws = await executor.prepareWorkspace({ repoRoot, parentCommit: head, candidateHarnessId: "H-env" });
    const plan = await executor.inspectTarget(ws, target(), { scope: scope() });
    await executor.implement(ws, plan);

    const verification = await executor.verify(ws, plan);

    expect(verification.commands[0].exitCode).toBe(0);
    expect(verification.commands[0].output).toBe("absent|absent|true");
    expect(verification.commands[0].output).not.toContain(SECRET);
    expect(verification.commands[0].output).not.toContain(KEY_SECRET);
    await executor.dispose(ws);
  });

  it("the candidate commit does not run repository hooks on the host", async () => {
    const marker = join(markerDir, "hook-ran");
    const hookPath = join(repoRoot, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, `#!/bin/sh\ntouch "${marker}"\n`, "utf8");
    await chmod(hookPath, 0o755);

    const executor = new GitWorktreeMutationExecutor({
      worktreeParentDir: wsRoot,
      verifyCommands: [["node", "--version"]],
    });
    const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
    const ws = await executor.prepareWorkspace({ repoRoot, parentCommit: head, candidateHarnessId: "H-hook" });
    const plan = await executor.inspectTarget(ws, target(), { scope: scope() });
    await executor.implement(ws, plan);
    const artifact = await executor.finalize(ws, plan);

    expect(artifact.commitSha).toMatch(/^[0-9a-f]{40}$/);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await executor.dispose(ws);
  });
});
