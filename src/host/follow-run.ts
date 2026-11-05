import { runChannel } from "../infrastructure/redis/channels.js";
import type { NexumRunEvent } from "../protocol/types.js";
import type { RunServices } from "./run-starter.js";

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled", "run.interrupted"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const STATUS_CHECK_MS = 2_000;

/**
 * Calls `onEvent` for every event of a run, in order and exactly once, and resolves after the terminal event.
 *
 * Subscribes to the live bus before reading the stored history, then merges the two by sequence number, so an
 * event published while the history is being read is neither lost nor repeated. A periodic status check ends
 * the wait if the run finished but its terminal event never arrived.
 */
export async function followRun(
  services: Pick<RunServices, "eventBus" | "repos">,
  runId: string,
  onEvent: (event: NexumRunEvent) => void,
): Promise<void> {
  const { eventBus, repos } = services;
  let highestSeq = 0;
  let replaying = true;
  let finished = false;
  const buffered: Array<{ seq: number; event: NexumRunEvent }> = [];
  let finish: () => void = () => {};
  const ended = new Promise<void>((resolve) => (finish = resolve));

  const deliver = (seq: number, event: NexumRunEvent): void => {
    if (finished || seq <= highestSeq) return;
    highestSeq = seq;
    onEvent(event);
    if (TERMINAL_EVENTS.has(event.type)) {
      finished = true;
      finish();
    }
  };
  const replayFrom = async (): Promise<void> => {
    for (const past of await repos.events.listByRun(runId, highestSeq)) deliver(past.seq, past.event);
  };

  const unsubscribe = await eventBus.subscribe<{ seq?: number } & NexumRunEvent>(runChannel(runId), (event) => {
    const seq = event.seq ?? 0;
    if (replaying) buffered.push({ seq, event });
    else deliver(seq, event);
  });
  const watchdog = setInterval(() => {
    void repos.runs.get(runId).then(async (row) => {
      if (finished || !row || !TERMINAL_STATUSES.has(row.status)) return;
      await replayFrom();
      if (!finished) {
        finished = true;
        finish();
      }
    });
  }, STATUS_CHECK_MS);
  watchdog.unref();

  try {
    await replayFrom();
    replaying = false;
    for (const { seq, event } of buffered) deliver(seq, event);
    await ended;
  } finally {
    clearInterval(watchdog);
    await unsubscribe();
  }
}
