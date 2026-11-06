import { ClosedLoopEngine } from "../../src/evolution/engine-v2.js";
import { SuccessPatternAnalyzer } from "../../src/evolution/experience/success-analyzer.js";
import { capabilityAreaFor } from "../../src/evolution/targets/target-engine.js";
import { Episode, Grade } from "../../src/learning/types.js";

function successGrade(over: { score?: number; signals?: Partial<Grade["signals"]> } = {}): Grade {
  return {
    score: over.score ?? 0.9,
    signals: {
      testsRan: true,
      testsPassed: true,
      toolErrorRate: 0,
      pathEscapes: 0,
      patchFailures: 0,
      loopAborted: false,
      turnCount: 4,
      retriedSameToolMax: 0,
      ...(over.signals ?? {}),
    },
    verdict: "success",
  };
}

function successEpisode(
  id: string,
  goal: string,
  over: { score?: number; signals?: Partial<Grade["signals"]> } = {},
): Episode {
  return {
    id,
    goal,
    startedAt: 1,
    endedAt: 2,
    toolEvents: [],
    activatedSkillIds: [],
    terminal: "answered",
    finalAssistantText: "done",
    grade: successGrade(over),
  };
}

describe("Success-driven evolution through ClosedLoopEngine.observe (v2.4)", () => {
  it("keeps the legacy contract: uniformly clean successes produce no diagnoses and no target", () => {
    const engine = new ClosedLoopEngine();
    const observation = engine.observe([
      successEpisode("ep-1", "add feature flag support"),
      successEpisode("ep-2", "add pagination support"),
      successEpisode("ep-3", "add export support"),
    ]);
    expect(observation.diagnoses).toEqual([]);
    expect(observation.target).toBeNull();
    expect(observation.plan).toBeNull();
  });

  it("forms an improvement target from an ALL-SUCCESSFUL workspace when the successes are wasteful", () => {
    const engine = new ClosedLoopEngine();
    const observation = engine.observe([
      successEpisode("ep-1", "fix login validation bug", { signals: { toolErrorRate: 0.5 } }),
      successEpisode("ep-2", "fix export encoding bug", { signals: { toolErrorRate: 0.6 } }),
      successEpisode("ep-3", "fix caching expiry bug", { signals: { toolErrorRate: 0.55 } }),
    ]);
    // No failure diagnoser output — every episode succeeded and passed tests.
    expect(observation.diagnoses.every((d) => d.failureClass === "efficiency_opportunity")).toBe(true);
    expect(observation.diagnoses.length).toBeGreaterThanOrEqual(3);
    // The capability-level target forms from success evidence alone.
    expect(observation.target).not.toBeNull();
    expect(observation.target!.capability).toBe("tool_utilization");
    expect(observation.target!.sourceFailureClasses).toContain("efficiency_opportunity");
    expect(observation.mutationScope).not.toBeNull();
    expect(observation.plan).not.toBeNull();
  });

  it("blends failure and success diagnoses in one observation", () => {
    const engine = new ClosedLoopEngine();
    const failure: Episode = {
      ...successEpisode("ep-f1", "fix broken import"),
      terminal: "answered",
      grade: {
        score: 0.3,
        signals: {
          testsRan: true,
          testsPassed: false,
          toolErrorRate: 0.5,
          pathEscapes: 0,
          patchFailures: 0,
          loopAborted: false,
          turnCount: 2,
          retriedSameToolMax: 0,
        },
        verdict: "failure",
      },
    };
    const observation = engine.observe([
      failure,
      successEpisode("ep-s1", "fix login validation bug", { signals: { toolErrorRate: 0.5 } }),
    ]);
    const classes = observation.diagnoses.map((d) => d.failureClass);
    expect(classes).toContain("premature_completion");
    expect(classes).toContain("efficiency_opportunity");
  });

  it("maps the new failure classes onto capability areas", () => {
    expect(capabilityAreaFor("efficiency_opportunity")).toBe("tool_utilization");
    expect(capabilityAreaFor("success_pattern")).toBe("execution_stability");
  });

  it("accepts an injected success analyzer (suppressed thresholds produce nothing)", () => {
    const engine = new ClosedLoopEngine({
      successAnalyzer: new SuccessPatternAnalyzer({
        wastefulToolErrorRate: 1.1,
        wastefulRetryCount: 99,
        wastefulTurnCount: 99999,
        minComparativeSamples: 99,
      }),
    });
    const observation = engine.observe([
      successEpisode("ep-1", "fix login validation bug", { signals: { toolErrorRate: 0.5 } }),
    ]);
    expect(observation.diagnoses).toEqual([]);
    expect(observation.target).toBeNull();
  });
});
