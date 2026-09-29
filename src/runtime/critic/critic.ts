/**
 * CriticService — in-loop quality critique of an agent's answer.
 *
 * Nexum's learning plane reflects AFTER a run (episode → grade → lesson).
 * This is the missing IN-LOOP counterpart:
 *
 *     answer → critic → weaknesses? → feedback → retry (same execution)
 *
 * Two layers, deliberately:
 *
 *   model critique    the judge-style JSON critique (verdict, weaknesses
 *                     with severity, suggestions) routed through the model
 *                     gateway under a critique capability (default
 *                     "reasoning")
 *   heuristic critique deterministic fallback (empty answer, placeholder
 *                     text, non-answers, echo of the question) used when
 *                     the model call fails or returns unparseable output —
 *                     a critic outage must never break the run
 */

import type { Capability } from "../../models/catalog.js";
import type { ModelGateway } from "../../models/gateway/model-gateway.js";
import { extractJson } from "../../rag/reranker.js";

export type CriticSeverity = "low" | "medium" | "high";

export const SEVERITY_ORDER: readonly CriticSeverity[] = ["low", "medium", "high"];

export function severityAtLeast(severity: CriticSeverity, floor: CriticSeverity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(floor);
}

export interface CritiqueWeakness {
  description: string;
  severity: CriticSeverity;
  suggestion?: string;
}

export interface Critique {
  verdict: "pass" | "revise";
  weaknesses: CritiqueWeakness[];
  summary: string;
  /** Where the critique came from — model or deterministic fallback. */
  source: "model" | "heuristic";
  /** Token usage of the critique model call, when known. */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface CriticOptions {
  modelGateway: ModelGateway;
  /** Capability used to route the critique call (default "reasoning"). */
  capability?: Capability;
  /** Minimum severity that triggers a revise verdict (default "medium"). */
  minSeverity?: CriticSeverity;
}

interface RawCritique {
  verdict?: unknown;
  weaknesses?: unknown;
  summary?: unknown;
}

const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; weakness: string }> = [
  { pattern: /\bTODO\b|\bFIXME\b|\bXXX\b/, weakness: "the answer contains unresolved TODO/FIXME markers" },
  { pattern: /\[insert[^\]]*\]|\[placeholder[^\]]*\]/i, weakness: "the answer contains unfilled placeholders" },
  { pattern: /lorem ipsum/i, weakness: "the answer contains placeholder filler text" },
  { pattern: /^(i can(?:not|'t)|i'm sorry|as an ai)/i, weakness: "the answer is a refusal rather than a task attempt" },
];

export class CriticService {
  private readonly gateway: ModelGateway;
  readonly capability: Capability;
  readonly minSeverity: CriticSeverity;

  constructor(opts: CriticOptions) {
    this.gateway = opts.modelGateway;
    this.capability = opts.capability ?? "reasoning";
    this.minSeverity = opts.minSeverity ?? "medium";
  }

  /**
   * Critique an answer against its task. Never throws: model failures and
   * unparseable critiques fall back to the deterministic heuristic pass.
   */
  async critique(task: { goal: string; input?: string }, answer: string): Promise<Critique> {
    try {
      const response = await this.gateway.route(this.capability, [this.buildPrompt(task, answer)]);
      const raw = validateCritique(extractJson(String(response.message?.content ?? "")));
      const weaknesses = (Array.isArray(raw.weaknesses) ? raw.weaknesses : [])
        .map((w) => {
          const entry = w as { description?: unknown; severity?: unknown; suggestion?: unknown };
          const severity = SEVERITY_ORDER.includes(entry.severity as CriticSeverity)
            ? (entry.severity as CriticSeverity)
            : "medium";
          return {
            description: String(entry.description ?? "unspecified weakness").slice(0, 400),
            severity,
            ...(entry.suggestion ? { suggestion: String(entry.suggestion).slice(0, 400) } : {}),
          };
        })
        .filter((w) => w.description.length > 0);
      // The verdict is DERIVED from weaknesses × minSeverity, not taken from
      // the model's self-assessment — the policy bar is deterministic even
      // when the model mislabels severities.
      const verdict = this.verdictFor(weaknesses);
      return {
        verdict,
        weaknesses,
        summary:
          String(raw.summary ?? "").slice(0, 500) ||
          (verdict === "pass" ? "Answer meets the bar." : "Answer needs revision."),
        source: "model",
        usage: {
          promptTokens: Number((response as Record<string, unknown>).prompt_eval_count ?? 0),
          completionTokens: Number((response as Record<string, unknown>).eval_count ?? 0),
        },
      };
    } catch {
      return this.heuristicCritique(task, answer);
    }
  }

  /** Deterministic checks — also the fallback when the model is unusable. */
  heuristicCritique(task: { goal: string; input?: string }, answer: string): Critique {
    const weaknesses: CritiqueWeakness[] = [];
    const text = answer.trim();

    if (text.length === 0) {
      weaknesses.push({ description: "the answer is empty", severity: "high" });
    }
    if (text.length > 0 && text.length < 12) {
      weaknesses.push({ description: "the answer is too short to address the task", severity: "medium" });
    }
    for (const { pattern, weakness } of PLACEHOLDER_PATTERNS) {
      if (pattern.test(text)) weaknesses.push({ description: weakness, severity: "high" });
    }
    const question = (task.input ?? task.goal).trim().toLowerCase();
    if (question.length > 10 && text.toLowerCase() === question) {
      weaknesses.push({ description: "the answer merely echoes the question", severity: "high" });
    }

    return {
      verdict: this.verdictFor(weaknesses),
      weaknesses,
      summary:
        weaknesses.length === 0 ? "No deterministic weakness detected." : "Deterministic checks found weaknesses.",
      source: "heuristic",
    };
  }

  private verdictFor(weaknesses: CritiqueWeakness[]): "pass" | "revise" {
    return weaknesses.some((w) => severityAtLeast(w.severity, this.minSeverity)) ? "revise" : "pass";
  }

  private buildPrompt(task: { goal: string; input?: string }, answer: string) {
    return {
      role: "user" as const,
      content: [
        "You are a strict critic reviewing an agent's final answer before it is returned to the user.",
        `Task goal: ${task.goal}`,
        ...(task.input ? [`Task input: ${task.input.slice(0, 2000)}`] : []),
        "",
        "Agent answer:",
        answer.slice(0, 6000),
        "",
        "Identify weaknesses that materially reduce the answer's usefulness (incorrect, incomplete,",
        "ungrounded, unclear). Ignore style nitpicks. Severity: low (cosmetic), medium (degrades",
        "usability), high (wrong or useless answer).",
        "",
        'Respond with ONLY JSON: {"verdict": "pass" | "revise", "weaknesses": [{"description": "...",',
        '"severity": "low"|"medium"|"high", "suggestion": "..."}], "summary": "..."}',
        'Use verdict "revise" only when at least one weakness is medium or high.',
      ].join("\n"),
    };
  }
}

function validateCritique(parsed: unknown): RawCritique {
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  return parsed as RawCritique;
}
