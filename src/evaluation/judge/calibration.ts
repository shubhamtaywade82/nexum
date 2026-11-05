/**
 * JudgeCalibration — measure how much to trust a judge.
 *
 * An LLM judge is itself a model output; before its verdicts gate anything
 * (regression policies, critic loops), compare them against known-good
 * labels:
 *
 *   bias        mean(actual - expected) — systematically harsh or lenient?
 *   mae         mean absolute error
 *   correlation Pearson r between expected and actual
 *   agreement   pass/fail agreement at the rubric's threshold
 *
 * The recommendation is deliberately conservative: adjust the threshold by
 * the bias (a lenient judge needs a higher bar), and flag low correlation
 * rather than pretending calibration fixed it.
 */

import type { JudgeVerdict } from "./judge-history.js";

export interface CalibrationSample {
  /** Known-good overall score, normalized 0..1. */
  expected: number;
  /** The judge's verdict for the same subject. */
  verdict: JudgeVerdict;
}

export interface CalibrationReport {
  count: number;
  /** Mean(actual - expected): > 0 lenient, < 0 harsh. */
  bias: number;
  /** Mean absolute error. */
  mae: number;
  /** Pearson correlation between expected and actual (-1..1). */
  correlation: number;
  /** Pass/fail agreement rate at the threshold. */
  agreement: number;
  /** Recommended threshold adjustment: threshold + bias (clamped 0..1) —
   *  a lenient judge (bias > 0) needs a higher bar, a harsh one a lower. */
  recommendedThreshold: number;
  /** Human-readable assessment. */
  assessment: "well-calibrated" | "usable-with-adjustment" | "needs-attention";
  notes: string[];
}

export interface CalibrationOptions {
  /** Pass threshold used for the agreement computation (default 0.6). */
  passThreshold?: number;
  /** |bias| at or below which the judge counts as unbiased (default 0.05). */
  biasTolerance?: number;
  /** Correlation at or above which the judge counts as tracking (default 0.7). */
  correlationFloor?: number;
}

export function calibrateJudge(samples: CalibrationSample[], opts: CalibrationOptions = {}): CalibrationReport {
  const passThreshold = opts.passThreshold ?? 0.6;
  const biasTolerance = opts.biasTolerance ?? 0.05;
  const correlationFloor = opts.correlationFloor ?? 0.7;
  const notes: string[] = [];

  if (samples.length === 0) {
    return {
      count: 0,
      bias: 0,
      mae: 0,
      correlation: 0,
      agreement: 0,
      recommendedThreshold: passThreshold,
      assessment: "needs-attention",
      notes: ["no calibration samples provided"],
    };
  }

  const expected = samples.map((s) => clamp01(s.expected));
  const actual = samples.map((s) => clamp01(s.verdict.overall));
  const n = samples.length;

  const bias = round3(actual.reduce((s, v, i) => s + v - expected[i], 0) / n);
  const mae = round3(actual.reduce((s, v, i) => s + Math.abs(v - expected[i]), 0) / n);
  const correlation = round3(pearson(expected, actual));
  const expectedPass = expected.map((e) => e >= passThreshold);
  const actualPass = actual.map((a) => a >= passThreshold);
  const agreement = round3(expectedPass.filter((p, i) => p === actualPass[i]).length / n);

  // Lenient judge (bias > 0) scores everything high → raise the cutoff by
  // the bias; harsh judge → lower it. Threshold + bias makes the judge's
  // pass set match the intended one on the labeled distribution.
  const recommendedThreshold = round3(clamp01(passThreshold + bias));

  if (bias > biasTolerance)
    notes.push(`judge is lenient (bias +${bias}) — raise the threshold to ${recommendedThreshold}`);
  else if (bias < -biasTolerance)
    notes.push(`judge is harsh (bias ${bias}) — lower the threshold to ${recommendedThreshold}`);
  else notes.push(`bias within ±${biasTolerance}`);

  if (correlation < correlationFloor)
    notes.push(`correlation ${correlation} below ${correlationFloor} — verdicts do not track labels reliably`);
  if (agreement < 0.8)
    notes.push(
      `pass/fail agreement ${Math.round(agreement * 100)}% — gating decisions will flip on borderline subjects`,
    );

  const assessment: CalibrationReport["assessment"] =
    Math.abs(bias) <= biasTolerance && correlation >= correlationFloor && agreement >= 0.8
      ? "well-calibrated"
      : correlation >= 0.5 && agreement >= 0.6
        ? "usable-with-adjustment"
        : "needs-attention";

  return { count: n, bias, mae, correlation, agreement, recommendedThreshold, assessment, notes };
}

/** Pearson correlation coefficient; 0 for degenerate inputs. */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const meanX = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanY = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return num / (Math.sqrt(denX) * Math.sqrt(denY));
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round3(n: number): number {
  return Math.round(n * 1e3) / 1e3;
}
