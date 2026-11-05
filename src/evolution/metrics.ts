/**
 * First-class metrics for the self-development loop.
 *
 * The Self-Developing Agents results show what must be measured to know
 * whether a self-improving system is actually improving:
 *
 *  - Visible / held-out / transfer gains per version switch
 *  - Retention rate of improvements over subsequent versions
 *  - Regression rate of accepted versions
 *  - Rollback rate
 *  - False promotion rate and PROMOTION PRECISION — the single most
 *    important health metric of the loop:
 *
 *        promotion precision = # candidates actually better on held-out
 *                              ------------------------------------------
 *                              # candidates promoted
 *
 *  - Experience → improvement correlation (does stored experience predict
 *    which experiments succeed?)
 *  - Executor sensitivity (do results survive a frozen executor change?)
 */

export interface VersionSwitchRecord {
  versionId: string;
  parentVersionId: string | null;
  /** Metrics on the visible split at decision time (null = not measured). */
  visibleGain: number | null;
  /** Metrics on the held-out split at decision time (null = not measured). */
  heldOutGain: number | null;
  /** Cross-model transfer gain at decision time (null = not measured). */
  transferGain: number | null;
  /** Was this version promoted (eligible → delivered)? */
  promoted: boolean;
  /** Was this version later found genuinely better on held-out evaluation? */
  genuinelyBetterOnHeldOut: boolean | "unknown";
  /** Was this version accepted into ACTIVE? */
  accepted: boolean;
  /** Was this version rolled back after post-deployment regression? */
  rolledBack: boolean;
  /** Did the next version retain this version's gains? */
  retainedBySuccessor: boolean | "unknown";
  executorModels: string[];
  /** Held-out delta spread across executors; null unless ≥2 executors were evaluated. */
  executorSensitivity: number | null;
  /** Confidence of the prior experience that seeded this experiment (null/absent = none recorded). */
  experienceConfidence?: number | null;
}

export interface EvolutionHealthReport {
  totalVersions: number;
  promotedCount: number;
  /** Promotion precision: genuinely-better-on-held-out ÷ promoted. */
  promotionPrecision: number | null;
  falsePromotionRate: number | null;
  retentionRate: number | null;
  regressionRate: number | null;
  rollbackRate: number | null;
  /** Means over switches where the quantity was measured; null when none were. */
  meanVisibleGain: number | null;
  meanHeldOutGain: number | null;
  meanTransferGain: number | null;
  /** Mean executor sensitivity across version switches (null when never measured). */
  meanExecutorSensitivity: number | null;
  /** Pearson correlation between recorded experience confidence and promotion (null without ≥3 recorded). */
  experienceImprovementCorrelation: number | null;
  /** Human-readable interpretation of promotion precision. */
  promotionPrecisionVerdict: string;
}

export class EvolutionMetricsTracker {
  private switches: VersionSwitchRecord[] = [];

  record(record: VersionSwitchRecord): void {
    this.switches.push(record);
  }

  records(): readonly VersionSwitchRecord[] {
    return this.switches;
  }

  /** Aggregates the full health report for the loop so far. */
  report(): EvolutionHealthReport {
    const total = this.switches.length;
    const promoted = this.switches.filter((s) => s.promoted);
    const decided = promoted.filter((s) => s.genuinelyBetterOnHeldOut !== "unknown");
    const genuinelyBetter = decided.filter((s) => s.genuinelyBetterOnHeldOut === true);
    const falsePromotions = decided.filter((s) => s.genuinelyBetterOnHeldOut === false);

    const retainedDecided = promoted.filter((s) => s.retainedBySuccessor !== "unknown");
    const retained = retainedDecided.filter((s) => s.retainedBySuccessor === true);

    const accepted = this.switches.filter((s) => s.accepted);
    const regressedDecided = accepted.filter((s) => s.retainedBySuccessor !== "unknown");
    const regressed = accepted.filter((s) => s.retainedBySuccessor === false);
    const rolledBack = accepted.filter((s) => s.rolledBack);

    const mean = (xs: Array<number | null | undefined>): number | null => {
      const measured = xs.filter((x): x is number => typeof x === "number");
      return measured.length > 0 ? measured.reduce((a, b) => a + b, 0) / measured.length : null;
    };

    const promotionPrecision = decided.length > 0 ? genuinelyBetter.length / decided.length : null;
    const falsePromotionRate = decided.length > 0 ? falsePromotions.length / decided.length : null;

    return {
      totalVersions: total,
      promotedCount: promoted.length,
      promotionPrecision,
      falsePromotionRate,
      retentionRate: retainedDecided.length > 0 ? retained.length / retainedDecided.length : null,
      regressionRate: regressedDecided.length > 0 ? regressed.length / regressedDecided.length : null,
      rollbackRate: accepted.length > 0 ? rolledBack.length / accepted.length : null,
      meanVisibleGain: mean(this.switches.map((s) => s.visibleGain)),
      meanHeldOutGain: mean(this.switches.map((s) => s.heldOutGain)),
      meanTransferGain: mean(this.switches.map((s) => s.transferGain)),
      meanExecutorSensitivity: mean(this.switches.map((s) => s.executorSensitivity)),
      experienceImprovementCorrelation: this.experienceImprovementCorrelation(),
      promotionPrecisionVerdict: promotionPrecisionVerdict(promotionPrecision),
    };
  }

  /**
   * Pearson correlation between prior experience confidence (fed into the
   * experiment) and experiment outcome — answers "is stored experience
   * predictive of improvement?". Without explicit arrays, only switches that
   * recorded an experienceConfidence participate.
   */
  experienceImprovementCorrelation(experienceConfidence?: number[], experimentOutcomes?: number[]): number | null {
    const withExperience = this.switches.filter((s) => typeof s.experienceConfidence === "number");
    const xs = experienceConfidence ?? withExperience.map((s) => s.experienceConfidence as number);
    const ys = experimentOutcomes ?? withExperience.map((s) => (s.promoted ? 1 : 0));
    if (xs.length !== ys.length || xs.length < 3) return null;
    return pearson(xs, ys);
  }
}

/** Promotion precision interpretation banding. */
export function promotionPrecisionVerdict(p: number | null): string {
  if (p === null) return "Insufficient decided promotions to compute promotion precision.";
  const pctVal = (p * 100).toFixed(0);
  if (p >= 0.75)
    return `Promotion precision ${pctVal}% — the loop is trustworthy: most promotions replicate on held-out evaluation.`;
  if (p >= 0.5)
    return `Promotion precision ${pctVal}% — moderate: tighten Stage B thresholds before trusting promotions.`;
  if (p >= 0.25)
    return `Promotion precision ${pctVal}% — poor: visible gains are not generalizing; raise held-out weight in promotion.`;
  return `Promotion precision ${pctVal}% — critical: promotions mostly fail to replicate; halt autonomous promotion and re-calibrate.`;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}
