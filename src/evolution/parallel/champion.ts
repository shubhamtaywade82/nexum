/**
 * Champion selection for one parallel evolution cycle: N candidates in, at most one champion out.
 *
 * Pure and deterministic. The same evidence always names the same champion, and every
 * outcome is explained in the returned reason.
 *
 *   - Eligibility is the engine's own gate. A candidate with no delivery report did not pass the
 *     two-stage decision and the generalization policy, so it can never be the champion.
 *   - Development deltas rank the eligible candidates (capability, then reliability, then
 *     efficiency, higher is better; the slot index breaks any remaining tie).
 *   - Held-out results are a VETO only, never a ranking input. The engine reports held-out tasks
 *     beside each decision and never decides on them. Ranking by them would leak the held-out set
 *     into selection.
 */

/** Stage-B deltas, candidate minus baseline. Higher is better on all three. */
export interface StageBDeltas {
  capability: number;
  reliability: number;
  efficiency: number;
}

/** One candidate attempt, summarized for selection. */
export interface ChampionCandidate {
  slot: number;
  experimentId: string;
  /** The attempt produced an outcome (the candidate was built, verified and benchmarked). */
  ok: boolean;
  /** The engine's eligibility: a delivery report exists. */
  eligible: boolean;
  /** Full commit of the candidate, or null when no commit was produced. */
  candidateCommit: string | null;
  /** Null when stage B did not run. */
  stageB: StageBDeltas | null;
  /** Candidate minus baseline on held-out tasks; null when none ran. Used as a veto only. */
  heldOutGain: number | null;
  detail: string;
}

export type ChampionSelection =
  | { kind: "champion"; slot: number; experimentId: string; ranking: number[]; reason: string }
  | { kind: "none"; ranking: number[]; reason: string };

/** Why a candidate cannot be champion, or null when it is admissible. */
export function championRejection(candidate: ChampionCandidate): string | null {
  if (!candidate.ok) return "attempt did not produce an outcome";
  if (!candidate.eligible) return "not eligible (failed the two-stage decision or generalization policy)";
  if (!candidate.candidateCommit || !/^[0-9a-f]{40}$/.test(candidate.candidateCommit)) {
    return "no full candidate commit";
  }
  if (!candidate.stageB) return "stage B did not run";
  if (candidate.heldOutGain !== null && candidate.heldOutGain < 0) {
    return `held-out regression (${candidate.heldOutGain.toFixed(3)})`;
  }
  return null;
}

function compareAdmissible(a: ChampionCandidate, b: ChampionCandidate): number {
  const da = a.stageB as StageBDeltas;
  const db = b.stageB as StageBDeltas;
  return (
    db.capability - da.capability || db.reliability - da.reliability || db.efficiency - da.efficiency || a.slot - b.slot
  );
}

/** Chooses at most one champion from the attempts. Never mutates its input. */
export function selectChampion(candidates: readonly ChampionCandidate[]): ChampionSelection {
  const admissible: ChampionCandidate[] = [];
  const rejected: string[] = [];
  for (const candidate of [...candidates].sort((a, b) => a.slot - b.slot)) {
    const reason = championRejection(candidate);
    if (reason === null) admissible.push(candidate);
    else rejected.push(`c${candidate.slot}: ${reason}`);
  }
  const ranking = [...admissible].sort(compareAdmissible).map((c) => c.slot);
  if (admissible.length === 0) {
    return {
      kind: "none",
      ranking,
      reason: rejected.length > 0 ? rejected.join("; ") : "no attempts ran",
    };
  }
  const champion = admissible.slice().sort(compareAdmissible)[0];
  const d = champion.stageB as StageBDeltas;
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const others = admissible.length - 1;
  const reason =
    `c${champion.slot} selected: capability ${pct(d.capability)}, reliability ${pct(d.reliability)}, ` +
    `efficiency ${pct(d.efficiency)} over ${others} other eligible attempt${others === 1 ? "" : "s"}` +
    (rejected.length > 0 ? `; excluded: ${rejected.join("; ")}` : "");
  return { kind: "champion", slot: champion.slot, experimentId: champion.experimentId, ranking, reason };
}
