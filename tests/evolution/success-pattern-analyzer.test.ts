import {
  SuccessPatternAnalyzer,
  canonicalToolSequence,
} from "../../src/evolution/experience/success-pattern-analyzer.js";
import { ExperienceRecord } from "../../src/evolution/experience/types.js";

function rec(
  id: string,
  taskClass: string,
  actions: string[],
  opts: { verified?: boolean; model?: string; confidence?: number } = {},
): ExperienceRecord {
  const verified = opts.verified ?? true;
  return {
    episodeId: id,
    taskClass,
    failureMode: "",
    contextSnapshot: "",
    actionSequence: actions,
    outcome: {
      verdict: "success",
      externallyVerified: verified,
      score: 0.9,
    },
    verifierEvidence: {
      testsRan: verified,
      testsPassed: verified ? true : null,
      signals: {},
    },
    executorModel: opts.model ?? "test-model",
    harnessVersion: "abc123",
    transferable: "unknown",
    confidence: opts.confidence ?? 0.8,
    createdAt: 1000,
  };
}

describe("SuccessPatternAnalyzer (EVO-003)", () => {
  test("returns empty patterns and sufficient=false when fewer than minSamples successes", () => {
    const analyzer = new SuccessPatternAnalyzer({ minSamples: 3 });
    const result = analyzer.analyze([rec("ep-1", "feature", ["read_file", "patch_file", "run_tests"])]);
    expect(result.patterns).toEqual([]);
    expect(result.sufficient).toBe(false);
    expect(result.totalSuccesses).toBe(1);
  });

  test("clusters repeatable success patterns by (taskClass, toolSequenceShape)", () => {
    const analyzer = new SuccessPatternAnalyzer({ minSamples: 3 });
    const records = [
      rec("ep-1", "feature", ["read_file", "patch_file", "run_tests"]),
      rec("ep-2", "feature", ["read_file", "patch_file", "run_tests"]),
      rec("ep-3", "feature", ["read_file", "patch_file", "run_tests"]),
      // different shape — should NOT cluster with the above
      rec("ep-4", "feature", ["read_file", "run_tests"]),
      // different task class — should NOT cluster
      rec("ep-5", "bugfix", ["read_file", "patch_file", "run_tests"]),
    ];
    const result = analyzer.analyze(records);
    expect(result.sufficient).toBe(true);
    const featurePatch = result.patterns.find(
      (p) => p.taskClass === "feature" && p.toolSequenceShape === "read_file→patch_file→run_tests",
    );
    expect(featurePatch).toBeDefined();
    expect(featurePatch!.independentSamples).toBe(3);
    expect(featurePatch!.episodeIds).toEqual(["ep-1", "ep-2", "ep-3"]);
  });

  test("excludes unverified self-judged successes by default (S³Gym)", () => {
    const analyzer = new SuccessPatternAnalyzer({ minSamples: 2 });
    const records = [
      rec("ep-1", "feature", ["read_file", "run_tests"], { verified: true }),
      rec("ep-2", "feature", ["read_file", "run_tests"], { verified: true }),
      rec("ep-3", "feature", ["read_file", "run_tests"], { verified: false }), // self-judged
    ];
    const result = analyzer.analyze(records);
    expect(result.skippedUnverified).toBe(1);
    const pattern = result.patterns[0];
    expect(pattern).toBeDefined();
    expect(pattern.independentSamples).toBe(2); // ep-3 excluded
  });

  test("includeUnverified=true admits self-judged successes", () => {
    const analyzer = new SuccessPatternAnalyzer({ minSamples: 2, includeUnverified: true });
    const records = [
      rec("ep-1", "feature", ["read_file", "run_tests"], { verified: false }),
      rec("ep-2", "feature", ["read_file", "run_tests"], { verified: false }),
    ];
    const result = analyzer.analyze(records);
    expect(result.skippedUnverified).toBe(0);
    expect(result.patterns[0].independentSamples).toBe(2);
  });

  test("flags alreadyCapturedAsSkill when shape is in knownSkillShapes", () => {
    const analyzer = new SuccessPatternAnalyzer({ minSamples: 2 });
    const records = [
      rec("ep-1", "feature", ["read_file", "patch_file", "run_tests"]),
      rec("ep-2", "feature", ["read_file", "patch_file", "run_tests"]),
    ];
    const knownSkills = new Set([canonicalToolSequence(["read_file", "patch_file", "run_tests"])]);
    const result = analyzer.analyze(records, knownSkills);
    expect(result.patterns[0].alreadyCapturedAsSkill).toBe(true);
  });

  test("includeAlreadyCaptured=false hides skill-captured patterns", () => {
    const analyzer = new SuccessPatternAnalyzer({ minSamples: 2, includeAlreadyCaptured: false });
    const records = [
      rec("ep-1", "feature", ["read_file", "patch_file", "run_tests"]),
      rec("ep-2", "feature", ["read_file", "patch_file", "run_tests"]),
    ];
    const knownSkills = new Set([canonicalToolSequence(["read_file", "patch_file", "run_tests"])]);
    const result = analyzer.analyze(records, knownSkills);
    expect(result.patterns).toEqual([]);
  });

  test("de-duplicates episode ids (re-ingestion does not inflate count)", () => {
    const analyzer = new SuccessPatternAnalyzer({ minSamples: 2 });
    const records = [
      rec("ep-1", "feature", ["read_file", "run_tests"]),
      rec("ep-1", "feature", ["read_file", "run_tests"]), // same episode id
      rec("ep-1", "feature", ["read_file", "run_tests"]), // same episode id
      rec("ep-2", "feature", ["read_file", "run_tests"]),
    ];
    const result = analyzer.analyze(records);
    const pattern = result.patterns[0];
    expect(pattern).toBeDefined();
    expect(pattern.independentSamples).toBe(2); // ep-1 + ep-2, not 4
  });

  test("canonicalToolSequence collapses adjacent repeats", () => {
    expect(canonicalToolSequence(["read_file", "read_file", "patch_file", "run_tests"])).toBe(
      "read_file→patch_file→run_tests",
    );
    expect(canonicalToolSequence(["read_file", "patch_file", "patch_file", "run_tests"])).toBe(
      "read_file→patch_file→run_tests",
    );
    expect(canonicalToolSequence([])).toBe("(empty)");
  });

  test("aggregates executorModels across the cluster (cross-model evidence)", () => {
    const analyzer = new SuccessPatternAnalyzer({ minSamples: 2 });
    const records = [
      rec("ep-1", "feature", ["read_file", "run_tests"], { model: "ollama/llama3" }),
      rec("ep-2", "feature", ["read_file", "run_tests"], { model: "beam" }),
    ];
    const result = analyzer.analyze(records);
    expect(result.patterns[0].executorModels.sort()).toEqual(["beam", "ollama/llama3"]);
  });

  test("sorts patterns by independentSamples desc then meanConfidence desc", () => {
    const analyzer = new SuccessPatternAnalyzer({ minSamples: 2 });
    const records = [
      // pattern A: 3 samples, confidence 0.5
      rec("ep-1", "a", ["read_file"], { confidence: 0.5 }),
      rec("ep-2", "a", ["read_file"], { confidence: 0.5 }),
      rec("ep-3", "a", ["read_file"], { confidence: 0.5 }),
      // pattern B: 3 samples, confidence 0.9 → should rank above A
      rec("ep-4", "b", ["read_file"], { confidence: 0.9 }),
      rec("ep-5", "b", ["read_file"], { confidence: 0.9 }),
      rec("ep-6", "b", ["read_file"], { confidence: 0.9 }),
      // pattern C: 2 samples → should rank below A and B regardless of confidence
      rec("ep-7", "c", ["read_file"], { confidence: 1.0 }),
      rec("ep-8", "c", ["read_file"], { confidence: 1.0 }),
    ];
    const result = analyzer.analyze(records);
    expect(result.patterns.map((p) => p.taskClass)).toEqual(["b", "a", "c"]);
  });
});
