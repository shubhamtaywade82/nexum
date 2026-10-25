import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentDeclinedError,
  AgentMutationStrategy,
  ScriptedAgentRuntime,
} from "../../src/evolution/mutation/agent-mutation.js";
import { DEFAULT_COMPONENT_PATHS } from "../../src/evolution/mutation/mutation-executor.js";
import {
  PROTECTED_EVALUATION_PATHS,
  mutationScopeViolation,
  protectedEvaluationPath,
} from "../../src/evolution/mutation/path-scope.js";
import { ImprovementTarget } from "../../src/evolution/targets/target-engine.js";
import { HarnessDiagnosis } from "../../src/evolution/types.js";

// The evaluator and the benchmark suite must stay fixed across a lineage: an accepted candidate
// becomes the next parent, so a mutation that could edit them would judge its own successors, and
// one that could read the cases could fit the held-out set.

function target(): ImprovementTarget {
  return {
    id: "target-tool_utilization-1",
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

function diagnosis(): HarnessDiagnosis {
  return {
    failureClass: "tool_selection",
    component: "tools",
    evidence: [{ type: "tool_error", summary: "repeated tool argument failures" }],
    confidence: 0.8,
    rootCause: "tool schemas too broad",
    proposedFix: "prune tool schemas",
    expectedImpact: { capability: 0.05, reliability: 0.1, cost: 0 },
  };
}

describe("protected evaluation paths", () => {
  it("refuses an edit to the evaluator or the benchmark suite even under a broad allowed prefix", () => {
    for (const path of ["src/evolution/engine-v2.ts", "src/benchmark/cases.ts", "src/evolution/heldout-split.ts"]) {
      expect(mutationScopeViolation(path, ["src/"])).toContain("evaluation code");
    }
  });

  it("is not bypassed by case, a leading ./ or a doubled slash", () => {
    for (const path of ["SRC/Evolution/engine-v2.ts", "./src/benchmark/cases.ts", "src//benchmark/cases.ts"]) {
      expect(protectedEvaluationPath(path)).not.toBeNull();
    }
  });

  it("leaves ordinary harness code editable", () => {
    expect(mutationScopeViolation("src/tools/schemas.ts", ["src/"])).toBeNull();
    expect(mutationScopeViolation("src/evolutionary/notes.ts", ["src/"])).toBeNull();
  });

  it("is never part of a default mutation scope, and every default path exists in the repository", () => {
    for (const [component, paths] of Object.entries(DEFAULT_COMPONENT_PATHS)) {
      for (const path of paths) {
        expect({ component, path, protected: protectedEvaluationPath(path) }).toEqual({
          component,
          path,
          protected: null,
        });
        expect({ component, path, exists: existsSync(path) }).toEqual({ component, path, exists: true });
      }
    }
    expect(PROTECTED_EVALUATION_PATHS).toEqual(["src/evolution/", "src/benchmark/"]);
  });

  describe("the agent's worktree view", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "protected-view-"));
      for (const dir of ["src/evolution", "src/benchmark", "src/tools"])
        await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, "src/evolution/heldout-split.ts"), "export const SECRET_SPLIT = 1;\n");
      await writeFile(join(root, "src/benchmark/cases.ts"), "export const HELD_OUT_CASE = 1;\n");
      await writeFile(join(root, "src/tools/schemas.ts"), "export const toolSchemas = [];\n");
      // A file in an editable directory that points into the benchmark suite.
      await symlink(join(root, "src/benchmark/cases.ts"), join(root, "src/tools/cases-link.ts"));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("hides the evaluator and the cases from reads and listings, including through a symlink", async () => {
      const seen: Record<string, string | null> = {};
      let listed: string[] = [];
      const runtime = new ScriptedAgentRuntime("probe", async (request) => {
        for (const path of [
          "src/evolution/heldout-split.ts",
          "src/benchmark/cases.ts",
          "src/tools/cases-link.ts",
          "src/tools/schemas.ts",
        ]) {
          seen[path] = await request.worktree.readFile(path);
        }
        listed = await request.worktree.listFiles();
        return { edits: [], investigation: [], summary: "probe only", declined: { reason: "probe" } };
      });
      const strategy = new AgentMutationStrategy({ runtime });

      await expect(
        strategy.inspectTarget({
          worktreePath: root,
          target: target(),
          context: {
            diagnosis: diagnosis(),
            scope: { kind: "single_component", components: ["tools"], rationale: "test" },
          },
        }),
      ).rejects.toBeInstanceOf(AgentDeclinedError);

      expect(seen["src/evolution/heldout-split.ts"]).toBeNull();
      expect(seen["src/benchmark/cases.ts"]).toBeNull();
      expect(seen["src/tools/cases-link.ts"]).toBeNull();
      expect(seen["src/tools/schemas.ts"]).toContain("toolSchemas");
      expect(listed).toContain("src/tools/schemas.ts");
      expect(listed.filter((p) => p.startsWith("src/evolution/") || p.startsWith("src/benchmark/"))).toEqual([]);
    });
  });
});
