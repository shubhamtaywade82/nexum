import { SuccessPatternAnalyzer } from "../../src/evolution/experience/success-analyzer.js";
import { Episode, Grade } from "../../src/learning/types.js";

function grade(over: Partial<Grade> & { signals: Partial<Grade["signals"]> } = { signals: {} }): Grade {
  return {
    score: 0.9,
    signals: {
      testsRan: true,
      testsPassed: true,
      toolErrorRate: 0,
      pathEscapes: 0,
      patchFailures: 0,
      loopAborted: false,
      turnCount: 4,
      retriedSameToolMax: 0,
      ...over.signals,
    },
    verdict: "success",
    ...over,
  };
}

function successEpisode(id: string, goal: string, g: Grade = grade()): Episode {
  return {
    id,
    goal,
    startedAt: 1,
    endedAt: 2,
    toolEvents: [],
    activatedSkillIds: [],
    terminal: "answered",
    finalAssistantText: "done",
    grade: g,
  };
}

describe("SuccessPatternAnalyzer (success-driven evolution)", () => {
  it("produces nothing for truly clean successful episodes", () => {
    const analyzer = new SuccessPatternAnalyzer();
    const episodes = [
      successEpisode("ep-1", "add feature flag support"),
      successEpisode("ep-2", "add pagination support"),
      successEpisode("ep-3", "add export support"),
    ];
    expect(analyzer.analyzeEpisodes(episodes)).toEqual([]);
  });

  it("diagnoses an efficiency opportunity when a success absorbed tool errors", () => {
    const analyzer = new SuccessPatternAnalyzer();
    const episodes = [
      successEpisode("ep-1", "add feature flag support", grade({ signals: { toolErrorRate: 0.5, turnCount: 6 } })),
    ];
    const diagnoses = analyzer.analyzeEpisodes(episodes);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].failureClass).toBe("efficiency_opportunity");
    expect(diagnoses[0].component).toBe("tools");
    expect(diagnoses[0].evidence[0].detail).toMatchObject({ episodeId: "ep-1", toolErrorRate: 0.5 });
    expect(diagnoses[0].expectedImpact.cost).toBeLessThan(0);
  });

  it("attributes retry waste to lifecycle and turn waste to execution", () => {
    const analyzer = new SuccessPatternAnalyzer();
    const diagnoses = analyzer.analyzeEpisodes([
      successEpisode("ep-retry", "fix login bug", grade({ signals: { retriedSameToolMax: 3 } })),
      successEpisode("ep-turns", "refactor service layer", grade({ signals: { turnCount: 25 } })),
    ]);
    const byEpisode = new Map(diagnoses.map((d) => [d.evidence[0].detail!.episodeId, d]));
    expect(byEpisode.get("ep-retry")!.component).toBe("lifecycle");
    expect(byEpisode.get("ep-turns")!.component).toBe("execution");
    for (const d of diagnoses) expect(d.failureClass).toBe("efficiency_opportunity");
  });

  it("emits a comparative success_pattern when efficient episodes outscore wasteful ones in a class", () => {
    const analyzer = new SuccessPatternAnalyzer();
    const episodes = [
      // Three bugfix successes: two clean and high-scoring, one wasteful and low-scoring.
      successEpisode("ep-1", "fix login bug", grade({ score: 0.95 })),
      successEpisode("ep-2", "fix export bug", grade({ score: 0.9 })),
      successEpisode("ep-3", "fix caching bug", grade({ score: 0.4, signals: { toolErrorRate: 0.6 } })),
    ];
    const diagnoses = analyzer.analyzeEpisodes(episodes);
    const pattern = diagnoses.find((d) => d.failureClass === "success_pattern");
    expect(pattern).toBeDefined();
    expect(pattern!.component).toBe("execution");
    expect(pattern!.evidence[0].detail).toMatchObject({
      taskClass: "bugfix",
      efficientEpisodes: ["ep-1", "ep-2"],
      wastefulEpisodes: ["ep-3"],
    });
    expect(pattern!.proposedFix).toContain("bugfix");
  });

  it("stays silent when a class is uniformly efficient (nothing to compare)", () => {
    const analyzer = new SuccessPatternAnalyzer();
    const episodes = [
      successEpisode("ep-1", "fix login bug"),
      successEpisode("ep-2", "fix export bug"),
      successEpisode("ep-3", "fix caching bug"),
    ];
    expect(analyzer.analyzeEpisodes(episodes)).toEqual([]);
  });

  it("stays silent when a class is uniformly wasteful (no observed better pattern)", () => {
    const analyzer = new SuccessPatternAnalyzer();
    const episodes = [1, 2, 3].map((i) =>
      successEpisode(`ep-${i}`, `fix bug number ${i}`, grade({ signals: { toolErrorRate: 0.5 } })),
    );
    expect(analyzer.analyzeEpisodes(episodes)).toHaveLength(3); // per-episode opportunities only
    expect(analyzer.analyzeEpisodes(episodes).some((d) => d.failureClass === "success_pattern")).toBe(false);
  });

  it("ignores failed episodes (those belong to the failure diagnoser)", () => {
    const analyzer = new SuccessPatternAnalyzer();
    const failure: Episode = {
      ...successEpisode("ep-fail", "fix broken thing"),
      terminal: "error",
      grade: grade({ verdict: "failure", score: 0.2, signals: { testsPassed: false } }),
    };
    expect(analyzer.analyzeEpisodes([failure])).toEqual([]);
  });

  it("treats ungraded answered episodes as successes (mirrors the trajectory analyzer)", () => {
    const analyzer = new SuccessPatternAnalyzer();
    const ungraded: Episode = {
      ...successEpisode("ep-un", "add feature support"),
      grade: undefined,
    };
    const graded = successEpisode(
      "ep-gr",
      "add another feature",
      grade({ score: 0.4, signals: { toolErrorRate: 0.6 } }),
    );
    const diagnoses = analyzer.analyzeEpisodes([ungraded, graded, graded, graded]);
    // No per-episode waste on the ungraded one; comparative pattern over "feature" class.
    expect(diagnoses.every((d) => d.evidence[0].detail!.episodeId !== "ep-un")).toBe(true);
    expect(diagnoses.some((d) => d.failureClass === "success_pattern")).toBe(true);
  });

  it("honors configured thresholds", () => {
    const analyzer = new SuccessPatternAnalyzer({ wastefulToolErrorRate: 0.05 });
    const diagnoses = analyzer.analyzeEpisodes([
      successEpisode("ep-1", "add feature", grade({ signals: { toolErrorRate: 0.08 } })),
    ]);
    expect(diagnoses).toHaveLength(1);
    expect(
      new SuccessPatternAnalyzer({ wastefulToolErrorRate: 0.5 }).analyzeEpisodes([
        successEpisode("ep-1", "add feature", grade({ signals: { toolErrorRate: 0.08 } })),
      ]),
    ).toEqual([]);
  });
});
