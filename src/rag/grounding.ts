/**
 * GroundingService — the hallucination-prevention layer.
 *
 * The coding agent already verifies its work with real tools (shell, LSP,
 * tests). Generic answer-producing agents need the equivalent for TEXT:
 * every claim in an answer must trace to retrieved evidence or be flagged.
 *
 *     answer → claims → evidence matching → citation + verdict
 *
 * A claim is an assertive sentence. Support is the share of the claim's
 * content tokens present in the best evidence chunk. Verdicts:
 *
 *     supported    support ≥ 0.5    cited
 *     partial      support ≥ 0.25   cited, flagged weak
 *     unsupported  support < 0.25   UNVERIFIED — surfaced to the caller
 *
 * The report carries an overall confidence so strategies can gate on it
 * (e.g. the critic loop refuses to pass answers below a threshold).
 */

import type { RetrievedChunk } from "./types.js";
import { tokenize } from "./retrievers.js";

export type ClaimVerdict = "supported" | "partial" | "unsupported";

export interface Evidence {
  /** Citation number (1-based) into the evidence list. */
  citation: number;
  chunk: RetrievedChunk;
}

export interface GroundedClaim {
  /** Claim index in the original answer. */
  index: number;
  text: string;
  verdict: ClaimVerdict;
  /** 0..1 token support from the best evidence. */
  support: number;
  /** Citation number of the best evidence (undefined when unsupported). */
  citation?: number;
}

export interface GroundingReport {
  claims: GroundedClaim[];
  confidence: number;
  supported: number;
  partial: number;
  unsupported: number;
  sources: Array<{ citation: number; ref: string; kind: string; excerpt: string }>;
}

export interface GroundingOptions {
  /** Support ratio for "supported" (default 0.5). */
  supportedThreshold?: number;
  /** Support ratio for "partial" (default 0.25). */
  partialThreshold?: number;
  /** Skip claims shorter than this many tokens (default 4). */
  minClaimTokens?: number;
}

export class GroundingService {
  private readonly supportedThreshold: number;
  private readonly partialThreshold: number;
  private readonly minClaimTokens: number;

  constructor(opts: GroundingOptions = {}) {
    this.supportedThreshold = opts.supportedThreshold ?? 0.5;
    this.partialThreshold = opts.partialThreshold ?? 0.25;
    this.minClaimTokens = opts.minClaimTokens ?? 4;
  }

  /**
   * Ground an answer against evidence chunks. Claims with no matching
   * evidence are reported as unsupported — never silently dropped.
   */
  ground(answer: string, evidence: RetrievedChunk[]): GroundingReport {
    const sources = evidence.map((chunk, i) => ({
      citation: i + 1,
      ref: chunk.source.ref,
      kind: chunk.source.kind,
      excerpt: chunk.content.slice(0, 160),
    }));
    const tokenizedEvidence = evidence.map((chunk) => new Set(tokenize(chunk.content)));

    const claims: GroundedClaim[] = [];
    let supported = 0;
    let partial = 0;
    let unsupported = 0;

    extractClaims(answer).forEach((text, index) => {
      const claimTokens = tokenize(text);
      if (claimTokens.length < this.minClaimTokens) return; // not a substantive claim

      let bestSupport = 0;
      let bestCitation: number | undefined;
      tokenizedEvidence.forEach((tokens, i) => {
        let hit = 0;
        for (const t of claimTokens) if (tokens.has(t)) hit++;
        const support = hit / claimTokens.length;
        if (support > bestSupport) {
          bestSupport = support;
          bestCitation = i + 1;
        }
      });

      let verdict: ClaimVerdict;
      if (bestSupport >= this.supportedThreshold) {
        verdict = "supported";
        supported++;
      } else if (bestSupport >= this.partialThreshold) {
        verdict = "partial";
        partial++;
      } else {
        verdict = "unsupported";
        unsupported++;
        bestCitation = undefined;
      }
      claims.push({
        index,
        text,
        verdict,
        support: Math.round(bestSupport * 1e3) / 1e3,
        ...(bestCitation !== undefined ? { citation: bestCitation } : {}),
      });
    });

    const total = claims.length;
    const confidence = total === 0 ? 0 : Math.round(((supported + 0.5 * partial) / total) * 1e3) / 1e3;
    return { claims, confidence, supported, partial, unsupported, sources };
  }

  /**
   * Render the answer with a sources block, e.g.
   *
   *   <answer>
   *
   *   Sources:
   *   [1] docs/architecture.md (vector)
   *   [2] rails-graph:app/models/user.rb (graph)
   *
   * Unsupported claims are never rewritten — the report is the signal.
   */
  renderWithSources(answer: string, report: GroundingReport): string {
    if (report.sources.length === 0) return answer;
    const lines = [answer.trim(), "", "Sources:"];
    for (const source of report.sources) {
      lines.push(`[${source.citation}] ${source.ref} (${source.kind})`);
    }
    return lines.join("\n");
  }
}

/** Split text into candidate assertive sentences. */
export function extractClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/)
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length < 20) return false; // too short to be a substantive claim
      if (s.endsWith("?")) return false; // questions claim nothing
      if (/^(please|you should|let me|note that|tip:|warning:|caution:)/i.test(s)) return false; // directives
      return true;
    });
}
