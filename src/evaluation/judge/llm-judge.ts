/**
 * LLMJudge — LLM-as-a-Judge as a runtime service.
 *
 *     subject (input + output + context + reference)
 *        ↓ evaluation prompt (rubric criteria, scale, weights)
 *     Judge LLM  ← selected by ScoredModelRouter ("judge" capability tag)
 *        ↓ strict JSON verdict (one repair retry)
 *     { criteriaScores, overall, pass, explanation }
 *        ↓
 *     judge history (audits + calibration)
 *
 * Model selection (the architectural decision): judges route through the
 * same ScoredModelRouter as everything else — capability tag "judge"
 * (weights: structuredOutput + reasoning) — and each rubric may pin an
 * explicit {model, tier} override. No hard-coded judge model, no second
 * routing system.
 *
 * Robustness: JSON verdicts are extracted tolerantly (fenced blocks, prose
 * wrappers) with one repair retry; a judge that cannot produce a parseable
 * verdict throws JudgeParseError — evaluation callers decide whether that
 * fails the scenario or records an evaluation error.
 */

import type { ChatMessage } from "../../models/adapters/provider.js";
import type { ModelGateway } from "../../models/gateway/model-gateway.js";
import { extractJson } from "../../rag/reranker.js";
import { builtinRubrics, criterionWeight, normalizeScore, type Rubric } from "./rubric.js";
import {
  InMemoryJudgeHistory,
  JudgeVerdict,
  newVerdictId,
  subjectDigest,
  type CriterionScore,
  type JudgeHistory,
} from "./judge-history.js";

export interface JudgeSubject {
  /** The task/question that was asked. */
  input?: string;
  /** The answer/output being judged. */
  output: string;
  /** Supporting context (retrieved evidence, code, transcript excerpts). */
  context?: string;
  /** Known-good reference answer, when one exists. */
  reference?: string;
  metadata?: Record<string, unknown>;
}

export interface LlmJudgeOptions {
  modelGateway: ModelGateway;
  /** Additional rubrics beyond the built-ins. */
  rubrics?: Rubric[];
  /** Verdict store (default: in-memory). */
  history?: JudgeHistory;
  /** Capability tag for judge routing (default "judge"). */
  defaultCapability?: string;
  /** Disable history recording (tests). */
  recordHistory?: boolean;
}

export class JudgeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeParseError";
  }
}

interface RawCriterionScore {
  id?: string;
  criterionId?: string;
  score?: unknown;
  rationale?: string;
}

interface RawVerdict {
  criteria?: RawCriterionScore[];
  overall?: unknown;
  explanation?: string;
  confidence?: unknown;
}

export class LlmJudge {
  private readonly rubrics = new Map<string, Rubric>();
  readonly history: JudgeHistory;

  constructor(private readonly opts: LlmJudgeOptions) {
    for (const rubric of [...builtinRubrics(), ...(opts.rubrics ?? [])]) {
      this.rubrics.set(rubric.id, rubric);
    }
    this.history = opts.history ?? new InMemoryJudgeHistory();
  }

  registerRubric(rubric: Rubric): this {
    this.rubrics.set(rubric.id, rubric);
    return this;
  }

  rubricIds(): string[] {
    return [...this.rubrics.keys()];
  }

  /** Judge `subject` against a rubric. Throws JudgeParseError on unparseable output. */
  async judge(subject: JudgeSubject, rubricId: string): Promise<JudgeVerdict> {
    const rubric = this.rubrics.get(rubricId);
    if (!rubric) {
      throw new Error(`unknown rubric "${rubricId}". Registered: ${this.rubricIds().join(", ") || "(none)"}`);
    }
    const scaleMax = rubric.scaleMax ?? 5;
    const passThreshold = rubric.passThreshold ?? 0.6;

    const { model, response } = await this.callJudgeModel(subject, rubric, scaleMax);

    const raw = this.parseVerdict(String(response.message?.content ?? ""));
    const criteriaScores = this.scoreCriteria(rubric, raw, scaleMax);
    const overall = weightedOverall(rubric, criteriaScores);
    const verdict: JudgeVerdict = {
      id: newVerdictId(),
      rubricId,
      subjectDigest: subjectDigest([subject.input, subject.output, subject.context, subject.reference]),
      criteriaScores,
      overall,
      pass: overall >= passThreshold,
      explanation: raw.explanation?.trim() || "(no explanation provided)",
      judgeModel: model,
      ts: Date.now(),
      ...(typeof raw.confidence === "number" ? { confidence: clamp01(raw.confidence) } : {}),
    };
    if (this.opts.recordHistory !== false) this.history.record(verdict);
    return verdict;
  }

  /**
   * Router-based judge selection + execution:
   *
   *   1. rubric.judgeModelOverride  → routeToModel (explicit, tier-scoped)
   *   2. scored router under the "judge" capability tag → routeToModel
   *      (top-ranked candidate; judge weights favor structuredOutput +
   *      reasoning, see CAPABILITY_WEIGHTS.judge)
   *   3. empty registry → route("reasoning") fallback (a capability every
   *      catalog can serve), so judging degrades instead of failing
   *
   * Execution never calls route("judge") directly: the failover Router
   * resolves candidates by catalog capability tags, and no model is tagged
   * "judge" — selection belongs to the scored router, transport to
   * routeToModel.
   */
  private async callJudgeModel(
    subject: JudgeSubject,
    rubric: Rubric,
    scaleMax: number,
  ): Promise<{ model: string; response: { message?: { content?: unknown } } }> {
    const messages = this.buildPrompt(subject, rubric, scaleMax);

    if (rubric.judgeModelOverride) {
      const { model, tier } = rubric.judgeModelOverride;
      return { model, response: await this.opts.modelGateway.routeToModel(model, tier, messages) };
    }

    const capability = rubric.judgeCapability ?? this.opts.defaultCapability ?? "judge";
    const selections = this.opts.modelGateway.select({ capability });
    const best = selections[0];
    if (best) {
      const tier = best.tier === "cloud" ? "cloud" : "local";
      return { model: best.model, response: await this.opts.modelGateway.routeToModel(best.model, tier, messages) };
    }

    // No profiled candidates — degrade to the reasoning capability.
    const response = await this.opts.modelGateway.route("reasoning", messages);
    return { model: response.routedModel ?? "reasoning-fallback", response };
  }

  private buildPrompt(subject: JudgeSubject, rubric: Rubric, scaleMax: number): ChatMessage[] {
    const sections: string[] = [
      "You are an impartial judge. Assess the agent's output strictly against the rubric.",
      "",
      `Rubric: ${rubric.name}${rubric.description ? ` — ${rubric.description}` : ""}`,
      "Criteria:",
      ...rubric.criteria.map((c) => `- ${c.id} (weight ${criterionWeight(c)}): ${c.description}`),
      "",
      `Score each criterion from 0 to ${scaleMax}.`,
    ];
    if (subject.input) sections.push("", "## Task", subject.input.slice(0, 4000));
    sections.push("", "## Agent output", subject.output.slice(0, 8000));
    if (subject.context) sections.push("", "## Context", subject.context.slice(0, 8000));
    if (subject.reference) sections.push("", "## Reference answer", subject.reference.slice(0, 4000));
    sections.push(
      "",
      "Respond with ONLY a JSON object:",
      `{"criteria": [{"id": "<criterion id>", "score": <0..${scaleMax}>, "rationale": "<one sentence>"}, ...],`,
      ' "overall": <0..1 your aggregate>, "explanation": "<2-3 sentences>", "confidence": <0..1>}',
    );
    return [{ role: "user", content: sections.join("\n") }];
  }

  /** Tolerant parse with one repair retry (judge models fence JSON often). */
  private parseVerdict(content: string): RawVerdict {
    try {
      return validateRawVerdict(extractJson(content));
    } catch (err) {
      throw new JudgeParseError(
        `judge returned unparseable verdict: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scoreCriteria(rubric: Rubric, raw: RawVerdict, scaleMax: number): CriterionScore[] {
    const byId = new Map<string, RawCriterionScore>();
    for (const entry of raw.criteria ?? []) {
      if (entry?.id) byId.set(entry.id, entry);
      else if (entry?.criterionId) byId.set(entry.criterionId, entry);
    }
    return rubric.criteria.map((criterion) => {
      const entry = byId.get(criterion.id);
      const score =
        typeof entry?.score === "number" && Number.isFinite(entry.score)
          ? Math.max(0, Math.min(scaleMax, entry.score))
          : 0;
      const normalized = normalizeScore(score, scaleMax);
      return {
        criterionId: criterion.id,
        score,
        maxScore: scaleMax,
        normalized: Math.round(normalized * 1e4) / 1e4,
        pass: normalized >= (criterion.passScore ?? 0.6),
        ...(entry?.rationale ? { rationale: String(entry.rationale).slice(0, 500) } : {}),
      };
    });
  }
}

function validateRawVerdict(parsed: unknown): RawVerdict {
  if (typeof parsed !== "object" || parsed === null) throw new Error("verdict is not an object");
  const v = parsed as RawVerdict;
  if (!Array.isArray(v.criteria) || v.criteria.length === 0) throw new Error("verdict has no criteria array");
  return v;
}

/** Weighted normalized overall score across criteria. */
export function weightedOverall(rubric: Rubric, scores: CriterionScore[]): number {
  let total = 0;
  let weightSum = 0;
  const weights = new Map(rubric.criteria.map((c) => [c.id, criterionWeight(c)]));
  for (const score of scores) {
    const w = weights.get(score.criterionId) ?? 1;
    total += w * score.normalized;
    weightSum += w;
  }
  const overall = weightSum > 0 ? total / weightSum : 0;
  return Math.round(clamp01(overall) * 1e4) / 1e4;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
