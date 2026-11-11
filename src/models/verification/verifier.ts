import type { ChatPort } from "../gateway/inference-dispatcher.js";

export type VerifierVerdict = "VERIFIED" | "REJECT";

export interface VerifierResult {
  verdict: VerifierVerdict;
  /** Populated on REJECT — each string is one identified issue. */
  issues?: string[];
}

/**
 * Runs a lightweight critic pass on a local model's draft answer.
 *
 * Critique is easier than generation for small models — they catch
 * inconsistencies they would not have avoided producing. When the critic
 * finds problems, the caller should escalate to the cloud model, optionally
 * passing the critic notes as additional context.
 *
 * The critic model is typically the same local model (critique ≠ generation,
 * so the same model can still catch obvious errors in its own output).
 */
export class Verifier {
  constructor(private readonly provider: ChatPort) {}

  async verify(task: string, draft: string): Promise<VerifierResult> {
    const prompt = [
      "You are a code critic. Review the task and the proposed answer below.",
      "List any incorrect assumptions, logical gaps, or factual errors you find.",
      "",
      "If the answer is correct and complete, output ONLY the word: VERIFIED",
      "If there are problems, output: REJECT",
      "Then list each issue on a new line starting with '- '.",
      "Keep your response short \u2014 no more than 10 bullet points.",
      "",
      `Task: ${task.slice(0, 500)}`,
      "",
      "Proposed Answer:",
      draft.slice(0, 1000),
    ].join("\n");

    const response = await this.provider.chat([{ role: "user", content: prompt }]);
    return this.parseVerdict(response.message.content);
  }

  private parseVerdict(text: string): VerifierResult {
    const trimmed = text.trim();

    // Any response that starts with VERIFIED (case-insensitive, allowing punctuation) is accepted.
    if (/^VERIFIED\b/i.test(trimmed)) {
      return { verdict: "VERIFIED" };
    }

    // Extract bullet-point issues.
    const issues = trimmed
      .split("\n")
      .filter((l) => l.trimStart().startsWith("- "))
      .map((l) => l.trim().slice(2).trim())
      .filter(Boolean);

    return {
      verdict: "REJECT",
      issues: issues.length > 0 ? issues : ["unspecified issue (no bullet points found in critic response)"],
    };
  }
}
