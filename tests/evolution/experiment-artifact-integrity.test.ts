import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExperimentArtifact,
  ExperimentArtifactEnvelope,
  ExperimentArtifactInput,
  readExperimentArtifact,
  verifyExperimentArtifactIntegrity,
  writeExperimentArtifact,
} from "../../src/evolution/experiments/experiment-artifact.js";

/**
 * Threat model, stated plainly: the artifact's sha256 is a self-hash. It detects
 * accidental or partial edits that were not re-hashed. It does not detect an
 * attacker who rewrites the payload and the hash together. The last case below
 * pins that limit, so no one can later claim more than the code delivers.
 */

function delivered(): ExperimentArtifactInput {
  return {
    experimentId: "exp-integrity-1",
    strategyName: "heuristic",
    model: "test-model",
    tier: "local",
    verifyProfileName: "full",
    benchmarkCategories: [],
    baselineAbsent: true,
    target: {
      id: "t1",
      capability: "tool_utilization",
      desiredOutcome: "fewer tool errors",
      observableSymptoms: [],
      measurableMetrics: [],
      affectedComponents: ["tools"],
      confidence: 0.9,
      evaluationPlan: { successCriterion: "x", steps: [], executorModels: ["qwen"] },
      sourceFailureClasses: ["tool_selection"],
      createdAt: 0,
    } as ExperimentArtifactInput["target"],
    diagnosis: {
      failureClass: "tool_selection",
      component: "tools",
      evidence: [],
      confidence: 0.8,
      rootCause: "schemas too broad",
      proposedFix: "prune",
      expectedImpact: { capability: 0, reliability: 0, cost: 0 },
    },
    scope: { kind: "single_component", components: ["tools"], rationale: "test" },
    record: null,
    mutation: {},
    baselineResults: [],
    candidateResults: [],
    github: {
      branch: "evolution/h1",
      prNumber: 42,
      prUrl: "https://github.com/o/r/pull/42",
      ciPassed: true,
      reviewApproved: true,
      accepted: true,
      mergeStatus: "rejected",
      mergeCommitSha: null,
      contentVerified: null,
      merged: false,
    },
    localDelivery: null,
    failure: null,
  };
}

describe("experiment artifact integrity (self-hash, accidental-edit detection)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artifact-integrity-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("verifies a freshly written artifact", () => {
    const path = writeExperimentArtifact(dir, buildExperimentArtifact(delivered()));
    expect(readExperimentArtifact(path).integrity).toEqual({ ok: true });
  });

  it("detects a partial edit that was not re-hashed (a merge flipped to merged)", () => {
    const path = writeExperimentArtifact(dir, buildExperimentArtifact(delivered()));
    const raw = JSON.parse(readFileSync(path, "utf8")) as ExperimentArtifactEnvelope;
    raw.payload.delivery.merged = true;
    raw.payload.delivery.mergeStatus = "merged";
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const { integrity } = readExperimentArtifact(path);
    expect(integrity.ok).toBe(false);
    if (!integrity.ok) expect(integrity.reason).toMatch(/does not match/);
  });

  it("detects a removed integrity block", () => {
    const envelope = buildExperimentArtifact(delivered()) as unknown as Record<string, unknown>;
    delete envelope.integrity;
    expect(verifyExperimentArtifactIntegrity(envelope).ok).toBe(false);
  });

  it("detects a hash of the wrong algorithm", () => {
    const envelope = buildExperimentArtifact(delivered());
    const forged = { ...envelope, integrity: { algorithm: "md5" as "sha256", hash: envelope.integrity.hash } };
    expect(verifyExperimentArtifactIntegrity(forged).ok).toBe(false);
  });

  it("rejects a document that is not an experiment artifact", () => {
    expect(verifyExperimentArtifactIntegrity({ kind: "something-else" }).ok).toBe(false);
    expect(verifyExperimentArtifactIntegrity(null).ok).toBe(false);
  });

  it("documents the limit: a payload rewritten together with its hash verifies, so this is not tamper-proof", () => {
    // An attacker who can write the file recomputes the hash. The self-hash
    // cannot tell. Only an independently held anchor (a signature, or a copy in
    // another system) could. This test pins that limit so it is never overclaimed.
    const envelope = buildExperimentArtifact(delivered());
    const rewritten = JSON.parse(JSON.stringify(envelope)) as ExperimentArtifactEnvelope;
    rewritten.payload.delivery!.merged = true;
    rewritten.payload.delivery!.mergeStatus = "merged";
    rewritten.integrity.hash = createHash("sha256").update(JSON.stringify(rewritten.payload)).digest("hex");

    expect(verifyExperimentArtifactIntegrity(rewritten)).toEqual({ ok: true });
  });
});
