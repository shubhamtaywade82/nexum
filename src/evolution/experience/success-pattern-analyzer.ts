/**
 * SuccessPatternAnalyzer — EVO-003.
 *
 * Identifies repeatable patterns in successful agent executions and converts
 * them into improvement findings. Closes the gap left by
 * `HarnessDiagnoser.diagnoseEpisode`, which returns `null` for clean
 * successes (`diagnoser.ts:77-79`) — meaning successful episodes never fed
 * the target-formation → mutation path before this analyzer existed.
 *
 * The analyzer reads from `ExperienceStore` (populated automatically since
 * EVO-002 by `ExperienceIngestionBridge`). It clusters successful records by
 * `(taskClass, tool-sequence shape)` and surfaces patterns that:
 *   - have enough independent evidence (≥ minSamples, default 3);
 *   - are repeatable (the same shape appears in multiple episodes);
 *   - are NOT yet captured as a promoted skill (the caller passes the set of
 *     known skill signatures so the analyzer can flag "this success pattern
 *     is a candidate skill").
 *
 * A finding is allowed to conclude `no_change` (the report contract rewards
 * accurate negative findings — see docs/evolution/evolution-policy.md §6).
 *
 * Architecture: docs/evolution/architecture.md
 * Catalogue:    EVO-003 (Success Pattern Discovery)
 */

import { ExperienceRecord } from "./types.js";
import { inferTaskClass } from "./trajectory-analyzer.js";

/** A single success pattern, with the evidence backing it. */
export interface SuccessPattern {
  /** Stable id derived from the pattern signature. */
  id: string;
  /** Task class inferred from the episode goal (bugfix, feature, …). */
  taskClass: string;
  /** Canonicalized tool-sequence shape, e.g. "read_file→patch_file→run_tests". */
  toolSequenceShape: string;
  /** Episode ids that exhibited this pattern (de-duplicated). */
  episodeIds: string[];
  /** Number of independent episodes (== episodeIds.length). */
  independentSamples: number;
  /** Mean confidence of the underlying experience records, in [0,1]. */
  meanConfidence: number;
  /** Fraction of the records that were externally verified (tests ran + pass/fail recorded). */
  verifiedShare: number;
  /** Executor models that produced this pattern (for cross-model evidence). */
  executorModels: string[];
  /**
   * True if this pattern's tool-sequence shape is already captured by a
   * promoted skill. When false, the pattern is a candidate skill (EVO-007).
   */
  alreadyCapturedAsSkill: boolean;
}

export interface SuccessPatternAnalysisResult {
  /** All patterns found, sorted by independentSamples desc then meanConfidence desc. */
  patterns: SuccessPattern[];
  /** Total successful records examined. */
  totalSuccesses: number;
  /** Records skipped because they were unverified self-judged successes. */
  skippedUnverified: number;
  /** Whether the analysis had enough data to be meaningful. */
  sufficient: boolean;
}

export interface SuccessPatternAnalyzerOptions {
  /** Minimum independent episodes for a pattern to be reported. Default 3. */
  minSamples?: number;
  /**
   * Whether to include unverified (self-judged) successes. Default false —
   * the S³Gym finding is that self-judged outcomes are poor predictors, so
   * we exclude them unless the caller explicitly opts in.
   */
  includeUnverified?: boolean;
  /** Whether to include patterns already captured as skills. Default true. */
  includeAlreadyCaptured?: boolean;
}

export class SuccessPatternAnalyzer {
  private readonly minSamples: number;
  private readonly includeUnverified: boolean;
  private readonly includeAlreadyCaptured: boolean;

  constructor(opts: SuccessPatternAnalyzerOptions = {}) {
    this.minSamples = opts.minSamples ?? 3;
    this.includeUnverified = opts.includeUnverified ?? false;
    this.includeAlreadyCaptured = opts.includeAlreadyCaptured ?? true;
  }

  /**
   * Analyzes a batch of experience records. Only successful records are
   * considered (the analyzer's whole purpose is success-driven discovery).
   *
   * @param records         The full experience store contents (the analyzer
   *                        filters to successes internally).
   * @param knownSkillShapes Canonicalized tool-sequence shapes of already-
   *                        promoted skills, so the analyzer can flag
   *                        `alreadyCapturedAsSkill`. Pass `new Set()` if no
   *                        skill registry is available.
   */
  analyze(records: ExperienceRecord[], knownSkillShapes: Set<string> = new Set()): SuccessPatternAnalysisResult {
    const successes = records.filter((r) => r.outcome.verdict === "success");
    let skippedUnverified = 0;

    const eligible: ExperienceRecord[] = [];
    for (const r of successes) {
      const verified = r.outcome.externallyVerified;
      if (!verified && !this.includeUnverified) {
        skippedUnverified++;
        continue;
      }
      eligible.push(r);
    }

    // Cluster by (taskClass, toolSequenceShape). The taskClass on the record
    // is authoritative (it was inferred at ingestion time by
    // TrajectoryAnalyzer); we do NOT re-infer here.
    const groups = new Map<string, ExperienceRecord[]>();
    for (const r of eligible) {
      const shape = canonicalToolSequence(r.actionSequence);
      const key = `${r.taskClass}::${shape}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    const patterns: SuccessPattern[] = [];
    for (const [key, group] of groups.entries()) {
      // De-duplicate episode ids (defense in depth — the store is the source
      // of truth, but a re-ingestion bug could produce dupes).
      const episodeIds = [...new Set(group.map((r) => r.episodeId))];
      if (episodeIds.length < this.minSamples) continue;

      const [taskClass, shape] = key.split("::");
      const alreadyCaptured = knownSkillShapes.has(shape);
      if (alreadyCaptured && !this.includeAlreadyCaptured) continue;

      const meanConfidence = group.reduce((acc, r) => acc + r.confidence, 0) / group.length;
      const verifiedCount = group.filter((r) => r.outcome.externallyVerified).length;
      const executorModels = [...new Set(group.map((r) => r.executorModel))];

      patterns.push({
        id: `success-${taskClass}-${shape}`.replace(/[^a-z0-9-]/gi, "_").slice(0, 64),
        taskClass,
        toolSequenceShape: shape,
        episodeIds,
        independentSamples: episodeIds.length,
        meanConfidence,
        verifiedShare: verifiedCount / group.length,
        executorModels,
        alreadyCapturedAsSkill: alreadyCaptured,
      });
    }

    patterns.sort((a, b) => {
      if (b.independentSamples !== a.independentSamples) return b.independentSamples - a.independentSamples;
      return b.meanConfidence - a.meanConfidence;
    });

    return {
      patterns,
      totalSuccesses: successes.length,
      skippedUnverified,
      sufficient: successes.length >= this.minSamples,
    };
  }
}

/**
 * Canonicalizes a tool-sequence into a stable shape string. Adjacent repeats
 * are collapsed (e.g. `read_file, read_file, patch_file` → `read_file→patch_file`)
 * because the S³Gym finding is that the *shape* of the trajectory predicts
 * transfer, not the exact repetition count.
 */
export function canonicalToolSequence(actions: string[]): string {
  const out: string[] = [];
  for (const a of actions) {
    if (out[out.length - 1] !== a) out.push(a);
  }
  return out.join("→") || "(empty)";
}

/**
 * Convenience: infers the task class for a free-form goal string. Re-exports
 * `inferTaskClass` from the trajectory analyzer so callers don't need to
 * import it separately.
 */
export { inferTaskClass };
