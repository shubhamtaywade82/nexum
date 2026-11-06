/**
 * SuccessPatternAnalyzer — the SUCCESS-DRIVEN half of harness diagnosis.
 *
 * The failure diagnoser deliberately skips clean successful episodes ("nothing
 * to fix"). That bias made Nexum's evolution trigger failure-only: a harness
 * could not learn that a particular execution strategy works BETTER, only that
 * something is broken. This analyzer closes that gap:
 *
 *   1. Efficiency opportunities — successful episodes that succeeded
 *      WASTEFULLY (failed tool calls absorbed by retries, long turn counts,
 *      repeated same-tool retries). The task finished, so nothing "failed",
 *      but the harness burned budget it did not need to burn.
 *
 *   2. Comparative success patterns — across episodes of the same task class,
 *      compare the efficient successes against the wasteful ones. When the
 *      efficient group is meaningfully better (score, turns), the execution
 *      pattern itself is the improvement hypothesis: generalize it.
 *
 * Both signals are emitted as ordinary `HarnessDiagnosis` records so they flow
 * into the existing TargetEngine → planner → mutation-scope pipeline without
 * any special casing. A truly clean success (no waste, no comparative delta)
 * still produces nothing — success frequency alone must never masquerade as
 * an improvement hypothesis.
 */

import { Episode } from "../../learning/types.js";
import { Evidence, ExpectedImpact, HarnessComponent, HarnessDiagnosis } from "../types.js";
import { inferTaskClass } from "./trajectory-analyzer.js";

export interface SuccessAnalyzerOptions {
  /** Tool error rate at/above which a successful episode counts as wasteful. */
  wastefulToolErrorRate?: number;
  /** Same-tool retry count at/above which a successful episode counts as wasteful. */
  wastefulRetryCount?: number;
  /** Turn count at/above which a successful episode counts as wasteful. */
  wastefulTurnCount?: number;
  /** Minimum successful episodes in a task class for comparative analysis. */
  minComparativeSamples?: number;
  /** Minimum mean-score gap (efficient − wasteful) to report a pattern. */
  minComparativeScoreGap?: number;
}

interface SuccessEpisodeStats {
  episode: Episode;
  taskClass: string;
  score: number;
  toolErrorRate: number;
  retriedSameToolMax: number;
  turnCount: number;
  wasteful: boolean;
}

const EFFICIENCY_IMPACT: ExpectedImpact = { capability: 0.03, reliability: 0.08, cost: -0.1 };
const PATTERN_IMPACT: ExpectedImpact = { capability: 0.04, reliability: 0.06, cost: -0.08 };

/** A successful episode, as far as the success analyzer is concerned. */
function isSuccessfulEpisode(episode: Episode): boolean {
  if (episode.grade?.verdict === "success") return true;
  // Ungraded episodes that terminated by answering are treated as successes by
  // the trajectory analyzer; mirror that so both views stay consistent.
  return !episode.grade && episode.terminal === "answered";
}

function statsFor(
  episode: Episode,
  wastefulThresholds: Required<
    Pick<SuccessAnalyzerOptions, "wastefulToolErrorRate" | "wastefulRetryCount" | "wastefulTurnCount">
  >,
): SuccessEpisodeStats {
  const toolErrorRate = episode.grade?.signals.toolErrorRate ?? 0;
  const retriedSameToolMax = episode.grade?.signals.retriedSameToolMax ?? 0;
  const turnCount = episode.grade?.signals.turnCount ?? episode.toolEvents.length;
  const wasteful =
    toolErrorRate >= wastefulThresholds.wastefulToolErrorRate ||
    retriedSameToolMax >= wastefulThresholds.wastefulRetryCount ||
    turnCount >= wastefulThresholds.wastefulTurnCount;
  return {
    episode,
    taskClass: inferTaskClass(episode.goal),
    score: episode.grade?.score ?? 1,
    toolErrorRate,
    retriedSameToolMax,
    turnCount,
    wasteful,
  };
}

export class SuccessPatternAnalyzer {
  private readonly wastefulToolErrorRate: number;
  private readonly wastefulRetryCount: number;
  private readonly wastefulTurnCount: number;
  private readonly minComparativeSamples: number;
  private readonly minComparativeScoreGap: number;

  constructor(opts: SuccessAnalyzerOptions = {}) {
    this.wastefulToolErrorRate = opts.wastefulToolErrorRate ?? 0.2;
    this.wastefulRetryCount = opts.wastefulRetryCount ?? 2;
    this.wastefulTurnCount = opts.wastefulTurnCount ?? 20;
    this.minComparativeSamples = opts.minComparativeSamples ?? 3;
    this.minComparativeScoreGap = opts.minComparativeScoreGap ?? 0.15;
  }

  /**
   * Analyzes a batch of episodes and returns success-driven diagnoses. Pure
   * function of its inputs; no persistence, no side effects.
   */
  analyzeEpisodes(episodes: Episode[]): HarnessDiagnosis[] {
    const thresholds = {
      wastefulToolErrorRate: this.wastefulToolErrorRate,
      wastefulRetryCount: this.wastefulRetryCount,
      wastefulTurnCount: this.wastefulTurnCount,
    };
    const successes = episodes.filter(isSuccessfulEpisode).map((ep) => statsFor(ep, thresholds));
    return [
      ...successes.flatMap((s) => this.diagnoseEfficiencyOpportunity(s)),
      ...this.diagnoseComparativePatterns(successes),
    ];
  }

  /**
   * One diagnosis per wasteful success. The component follows the dominant
   * waste signal: tools (error rate), lifecycle (retries), execution (turns).
   */
  private diagnoseEfficiencyOpportunity(stats: SuccessEpisodeStats): HarnessDiagnosis[] {
    if (!stats.wasteful) return [];

    const signals: string[] = [];
    let dominant: "tools" | "lifecycle" | "execution" = "execution";

    if (stats.toolErrorRate >= this.wastefulToolErrorRate) {
      signals.push(
        `tool error rate ${(stats.toolErrorRate * 100).toFixed(0)}% absorbed before the task still succeeded`,
      );
      dominant = "tools";
    }
    if (stats.retriedSameToolMax >= this.wastefulRetryCount) {
      signals.push(`${stats.retriedSameToolMax} consecutive retries of the same tool before success`);
      if (dominant === "execution") dominant = "lifecycle";
    }
    if (stats.turnCount >= this.wastefulTurnCount) {
      signals.push(`${stats.turnCount} turns consumed to reach a successful outcome`);
    }
    const component: HarnessComponent =
      dominant === "tools" ? "tools" : dominant === "lifecycle" ? "lifecycle" : "execution";

    const evidence: Evidence[] = [
      {
        type: "wasteful_success",
        summary: `Episode ${stats.episode.id} (${stats.taskClass}) succeeded with wasted execution budget`,
        detail: {
          episodeId: stats.episode.id,
          goal: stats.episode.goal.slice(0, 160),
          toolErrorRate: stats.toolErrorRate,
          retriedSameToolMax: stats.retriedSameToolMax,
          turnCount: stats.turnCount,
          score: stats.score,
        },
      },
    ];

    // Confidence scales with waste severity: more waste signals → more certain
    // the harness is leaving efficiency on the table.
    const confidence = Math.min(0.75, 0.5 + 0.12 * signals.length);

    return [
      {
        failureClass: "efficiency_opportunity",
        component,
        evidence,
        confidence,
        rootCause: `Successful episode wasted execution budget: ${signals.join("; ")}`,
        proposedFix:
          "Prevent the wasted work upstream (tighter tool-argument feedback, earlier retry escalation, or leaner turn planning) so the same outcome costs fewer calls and turns.",
        expectedImpact: EFFICIENCY_IMPACT,
      },
    ];
  }

  /**
   * Cross-episode comparative analysis: within one task class, do the
   * efficient successes outscore the wasteful ones? Only emits when both
   * groups exist and the gap clears the threshold, so a uniformly efficient
   * class (nothing to compare) and a uniformly wasteful class (no observed
   * better pattern) both stay silent.
   */
  private diagnoseComparativePatterns(successes: SuccessEpisodeStats[]): HarnessDiagnosis[] {
    const byClass = new Map<string, SuccessEpisodeStats[]>();
    for (const s of successes) {
      const list = byClass.get(s.taskClass) ?? [];
      list.push(s);
      byClass.set(s.taskClass, list);
    }

    const diagnoses: HarnessDiagnosis[] = [];
    for (const [taskClass, list] of byClass.entries()) {
      if (list.length < this.minComparativeSamples) continue;
      const efficient = list.filter((s) => !s.wasteful);
      const wasteful = list.filter((s) => s.wasteful);
      if (efficient.length === 0 || wasteful.length === 0) continue;

      const mean = (xs: SuccessEpisodeStats[]) => xs.reduce((acc, s) => acc + s.score, 0) / xs.length;
      const efficientScore = mean(efficient);
      const wastefulScore = mean(wasteful);
      const gap = efficientScore - wastefulScore;
      if (gap < this.minComparativeScoreGap) continue;

      const meanTurns = (xs: SuccessEpisodeStats[]) => xs.reduce((acc, s) => acc + s.turnCount, 0) / xs.length;
      const confidence = Math.min(0.8, 0.45 + 0.07 * list.length);

      diagnoses.push({
        failureClass: "success_pattern",
        component: "execution",
        evidence: [
          {
            type: "comparative_success_pattern",
            summary: `In task class "${taskClass}", efficient executions outscore wasteful ones by ${(gap * 100).toFixed(0)}%`,
            detail: {
              taskClass,
              efficientEpisodes: efficient.map((s) => s.episode.id),
              wastefulEpisodes: wasteful.map((s) => s.episode.id),
              efficientMeanScore: efficientScore,
              wastefulMeanScore: wastefulScore,
              efficientMeanTurns: meanTurns(efficient),
              wastefulMeanTurns: meanTurns(wasteful),
            },
          },
        ],
        confidence,
        rootCause: `Efficient ${taskClass} episodes (no wasted tool calls or retries) complete with materially better outcomes than wasteful ones, but the harness does not prefer that strategy`,
        proposedFix: `Promote the execution pattern observed in the efficient ${taskClass} episodes into the default strategy for that task class, and normalize by task difficulty and verification strength before adopting it.`,
        expectedImpact: PATTERN_IMPACT,
      });
    }
    return diagnoses;
  }
}
