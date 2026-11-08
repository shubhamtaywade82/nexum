/**
 * One parallel evolution cycle as a single controlled unit:
 *
 *   N candidate attempts (concurrent, each isolated) → champion selection (once, after all settle)
 *   → release every non-champion workspace → deliver and activate the champion (at most once)
 *   → release the champion workspace.
 *
 * The orchestrator never delivers or activates an attempt itself. It calls `deliverChampion` once,
 * for the one selected run, and nothing else in the cycle reaches delivery or activation. The
 * invariant is structural: one cycle, N candidates, one champion, at most one delivery, at most one
 * activation.
 */

import { ChampionCandidate, ChampionSelection, selectChampion } from "./champion.js";

/** One attempt's result: its summary for selection, plus a caller-owned payload. */
export interface SlotRun<P> {
  candidate: ChampionCandidate;
  /** Opaque to the orchestrator: the caller's outcome, artifact and workspace handles. */
  payload: P | null;
  /** True when the run holds a retained workspace that must be released. */
  holdsWorkspace: boolean;
}

export interface ParallelCycleHooks<P> {
  /**
   * Runs one candidate attempt. It must not deliver or activate. A rejection becomes a failed
   * attempt, so one crashed attempt never aborts the cycle.
   */
  runSlot(slot: number): Promise<SlotRun<P>>;
  /** Releases the workspace a run retained. Errors are swallowed: cleanup must not mask the result. */
  release(run: SlotRun<P>): Promise<void>;
  /** Delivers and activates the champion. Called at most once per cycle. */
  deliverChampion(champion: SlotRun<P>): Promise<{ ok: boolean; detail: string }>;
  /** Optional delay between launching each subsequent slot to avoid burst rate limits. */
  staggerMs?: number;
}

export interface ParallelCycleResult<P> {
  ok: boolean;
  detail: string;
  selection: ChampionSelection;
  runs: SlotRun<P>[];
  /** The champion's delivery outcome; null when no champion was selected. */
  delivery: { ok: boolean; detail: string } | null;
}

function crashedRun<P>(slot: number, error: unknown): SlotRun<P> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    candidate: {
      slot,
      experimentId: `c${slot}-crashed`,
      ok: false,
      eligible: false,
      candidateCommit: null,
      stageB: null,
      heldOutGain: null,
      detail: `attempt crashed: ${message}`,
    },
    payload: null,
    holdsWorkspace: false,
  };
}

async function releaseQuietly<P>(hooks: ParallelCycleHooks<P>, run: SlotRun<P>): Promise<void> {
  try {
    await hooks.release(run);
  } catch {
    // A failed cleanup must never mask the cycle result. The next prepareWorkspace() prunes orphans.
  }
}

export async function runParallelCycle<P>(
  slots: number,
  hooks: ParallelCycleHooks<P>,
): Promise<ParallelCycleResult<P>> {
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error("runParallelCycle needs at least one slot.");
  }

  // Every attempt runs concurrently. Selection happens only after all of them have settled.
  // Stagger launch slightly in production so parallel slots do not flood the API on the exact same millisecond.
  const staggerMs = hooks.staggerMs ?? (process.env.NODE_ENV === "test" ? 0 : 1500);
  const settled = await Promise.allSettled(
    Array.from({ length: slots }, async (_, slot) => {
      if (slot > 0 && staggerMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, slot * staggerMs));
      }
      return hooks.runSlot(slot);
    }),
  );
  const runs: SlotRun<P>[] = settled.map((outcome, slot) =>
    outcome.status === "fulfilled" ? outcome.value : crashedRun<P>(slot, outcome.reason),
  );

  const selection = selectChampion(runs.map((run) => run.candidate));
  const championSlot = selection.kind === "champion" ? selection.slot : null;

  // Losers give their workspaces back now. The champion keeps its own until its branch is delivered.
  for (const run of runs) {
    if (run.holdsWorkspace && run.candidate.slot !== championSlot) {
      await releaseQuietly(hooks, run);
    }
  }

  if (selection.kind === "none") {
    return { ok: false, detail: `no champion: ${selection.reason}`, selection, runs, delivery: null };
  }

  const champion = runs.find((run) => run.candidate.slot === championSlot) as SlotRun<P>;
  let delivery: { ok: boolean; detail: string };
  try {
    delivery = await hooks.deliverChampion(champion);
  } catch (error) {
    delivery = { ok: false, detail: `delivery failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (champion.holdsWorkspace) await releaseQuietly(hooks, champion);
  }

  return {
    ok: delivery.ok,
    detail: `${selection.reason}; ${delivery.detail}`,
    selection,
    runs,
    delivery,
  };
}
