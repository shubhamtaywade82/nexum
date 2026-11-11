import type { ChatPort } from "../gateway/inference-dispatcher.js";

export interface SelfConsistencyOptions {
  /** Number of samples to draw. Default 3. */
  n?: number;
  /** Agreement score below which the caller should escalate. Default 0.5. */
  threshold?: number;
}

export interface SelfConsistencyResult {
  /** 0.0–1.0. 1.0 = all samples identical. */
  score: number;
  /** The most frequently occurring response (first 200 chars, trimmed). */
  majority?: string;
  /** All raw samples. */
  samples: string[];
  /** True when score < threshold — caller should escalate to cloud. */
  shouldEscalate: boolean;
}

/**
 * Self-consistency is one of the few confidence signals that is actually
 * calibrated on small models. When a model doesn't know something, its
 * samples diverge wildly. When it does know, samples converge.
 *
 * This is deliberately more reliable than asking the model to verbalize
 * its confidence, which is poorly calibrated in sub-3B models.
 *
 * Typical usage: for prompts where HeuristicRouter returns 'unknown',
 * draw 3 samples from the local model and check agreement. If divergent,
 * route to cloud. If convergent, return the majority answer.
 */
export class SelfConsistency {
  private readonly n: number;
  private readonly threshold: number;

  constructor(
    private readonly provider: ChatPort,
    opts: SelfConsistencyOptions = {},
  ) {
    this.n = opts.n ?? 3;
    this.threshold = opts.threshold ?? 0.5;
  }

  /**
   * Draws `n` samples and scores them.
   * Combines `sample()` + `score()` in one call.
   */
  async evaluate(prompt: string): Promise<SelfConsistencyResult> {
    const samples = await this.sample(prompt);
    return this.score(samples);
  }

  /**
   * Draws `n` parallel samples from the local model.
   * Each call is independent — the provider's inherent generation variability
   * is sufficient for meaningful divergence detection at this scale.
   */
  async sample(prompt: string): Promise<string[]> {
    const calls = Array.from({ length: this.n }, () =>
      this.provider
        .chat([{ role: "user", content: prompt }])
        .then((r) => r.message.content.trim())
        .catch(() => ""),
    );
    return Promise.all(calls);
  }

  /**
   * Scores a set of samples by exact-match agreement on the first 200 chars.
   * Returns the majority answer and whether the caller should escalate.
   */
  score(samples: string[]): SelfConsistencyResult {
    const nonEmpty = samples.filter(Boolean);

    if (nonEmpty.length === 0) {
      return { score: 0, majority: undefined, samples, shouldEscalate: true };
    }

    // Normalise: trim + first 200 chars for comparison key
    const normalized = nonEmpty.map((s) => s.slice(0, 200));

    const counts = new Map<string, number>();
    for (const s of normalized) counts.set(s, (counts.get(s) ?? 0) + 1);

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [topKey, topCount] = sorted[0];
    const agreementScore = topCount / nonEmpty.length;

    return {
      score: agreementScore,
      majority: topKey,
      samples,
      shouldEscalate: agreementScore < this.threshold,
    };
  }
}
