/**
 * SelfCorrectionLoop — answer → critique → feedback → retry, bounded.
 *
 * The reusable reflection primitive (distinct from post-run learning):
 * inside ONE execution, a weak answer gets a second chance. The loop owns
 * attempt counting and feedback construction; regeneration is injected so
 * the same loop serves ReAct's final-answer path, product hooks, and
 * standalone use.
 *
 *     answer₀ → critique₀ ─(pass)→ done
 *                    │ (revise)
 *                    ↓
 *              feedback prompt
 *                    ↓
 *              answer₁ → critique₁ ─(pass or attempts exhausted)→ done
 */

import type { CriticService, Critique } from "./critic.js";

export interface SelfCorrectionResult {
  /** The final (possibly revised) answer. */
  answer: string;
  /** Number of regeneration attempts performed (0 = first answer passed). */
  attempts: number;
  /** Every critique, in order — the run's reflection trail. */
  critiques: Critique[];
  /** True when a revision happened and the last critique passed. */
  improved: boolean;
}

export interface SelfCorrectionOptions {
  /** Max regeneration attempts after the first answer (default 1). */
  maxAttempts?: number;
}

export class SelfCorrectionLoop {
  constructor(
    private readonly critic: CriticService,
    private readonly opts: SelfCorrectionOptions = {},
  ) {}

  get maxAttempts(): number {
    return this.opts.maxAttempts ?? 1;
  }

  /**
   * Improve `answer` until the critic passes it or attempts run out.
   * `regenerate` receives the feedback prompt and must return a new answer.
   */
  async improve(
    task: { goal: string; input?: string },
    answer: string,
    regenerate: (feedbackPrompt: string) => Promise<string>,
  ): Promise<SelfCorrectionResult> {
    const critiques: Critique[] = [];
    let current = answer;

    for (let attempt = 0; attempt <= this.maxAttempts; attempt++) {
      const critique = await this.critic.critique(task, current);
      critiques.push(critique);
      if (critique.verdict === "pass" || attempt === this.maxAttempts) {
        return { answer: current, attempts: attempt, critiques, improved: attempt > 0 && critique.verdict === "pass" };
      }
      current = await regenerate(this.buildFeedback(critique));
    }
    // Unreachable — the loop returns from inside; kept for type completeness.
    return { answer: current, attempts: this.maxAttempts, critiques, improved: false };
  }

  /** Render the critique as an actionable revision instruction. */
  buildFeedback(critique: Critique): string {
    const lines = [
      "[system] Your previous answer was reviewed and needs revision. Weaknesses found:",
      ...critique.weaknesses.map(
        (w) => `- (${w.severity}) ${w.description}${w.suggestion ? ` — suggested fix: ${w.suggestion}` : ""}`,
      ),
      "",
      "Rewrite the answer addressing every weakness. Keep what was correct. Answer directly — do not mention this review.",
    ];
    return lines.join("\n");
  }
}
