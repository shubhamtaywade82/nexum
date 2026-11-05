import type { Agent } from "../cli/agent.js";
import type { RedisEventBus } from "../infrastructure/redis/pubsub.js";
import { runChannel } from "../infrastructure/redis/channels.js";
import type { EventRepository } from "../persistence/repositories/event-repository.js";
import type { MessageRepository } from "../persistence/repositories/message-repository.js";
import type { RunRepository } from "../persistence/repositories/run-repository.js";
import type { SessionRepository } from "../persistence/repositories/session-repository.js";
import type { RunRow } from "../persistence/schema/run.js";
import type { CreateRunRequest, NexumRunEvent, NexumRunOutput } from "../protocol/types.js";
import type { AgentEntry, HostAgentRegistry } from "./agent-registry.js";
import type { RunEventBridge } from "./event-bridge.js";
import { describeError } from "./http.js";
import { openUiProblems, presentationInstructions, presentOutput } from "./presentation.js";

const LIVE_ONLY_EVENTS: ReadonlySet<string> = new Set(["answer.delta", "thought.delta"]);

export interface Repos {
  sessions: SessionRepository;
  messages: MessageRepository;
  runs: RunRepository;
  events: EventRepository;
}

/** What starting a run needs from the host: the registry, storage, the live bus and the bookkeeping sets. */
export interface RunServices {
  registry: HostAgentRegistry;
  repos: Repos;
  eventBus: RedisEventBus;
  runOwners: Map<string, string>;
  activeRuns: Set<Promise<void>>;
  busySessions: Set<string>;
}

export type StartRunResult = { ok: true; run: RunRow; done: Promise<void> } | { ok: false; activeRunId?: string };

/**
 * Starts a run on a session unless it already has one in progress. `done` settles once the run has finished
 * and its events, output and messages are persisted; it never rejects.
 */
export async function startRun(
  services: RunServices,
  sessionId: string,
  request: CreateRunRequest,
): Promise<StartRunResult> {
  const { agent, bridge } = await services.registry.getOrCreate(sessionId);
  if (bridge.isBusy || services.busySessions.has(sessionId)) {
    return { ok: false, activeRunId: [...services.runOwners].find(([, owner]) => owner === sessionId)?.[0] };
  }

  services.busySessions.add(sessionId);
  const runId = agent.startExecutionRun();
  services.runOwners.set(runId, sessionId);
  const run = await services.repos.runs.create(runId, sessionId, request.goal, "running");

  const done = runAgentInBackground(agent, bridge, request, {
    repos: services.repos,
    eventBus: services.eventBus,
    sessionId,
    runId,
    runOwners: services.runOwners,
    busySessions: services.busySessions,
  });
  services.activeRuns.add(done);
  void done.finally(() => services.activeRuns.delete(done));
  return { ok: true, run, done };
}

/** Aborts the run and releases anything it is blocked on, so cancel can't be stranded behind a prompt. */
/** One repair turn for an invalid OpenUI program; if that fails too, the answer is shown as Markdown. */
function openUiRepairPrompt(problems: string[]): string {
  return [
    "[system] Your last answer was meant to be an OpenUI Lang program but it failed validation:",
    ...problems.slice(0, 10).map((p) => `- ${p}`),
    "Rewrite the whole answer as one valid program using only the components and positional arguments from the",
    "OpenUI specification you were given (no named arguments like `label:`), or answer in plain Markdown instead.",
  ].join("\n");
}

export function cancelRun({ agent, bridge }: AgentEntry): boolean {
  const cancelled = agent.cancelExecutionRun();
  bridge.denyPending();
  return cancelled;
}

async function runAgentInBackground(
  agent: Agent,
  bridge: RunEventBridge,
  { goal, presentation, interactive, approvalMode, modelTier }: CreateRunRequest,
  ctx: {
    repos: Repos;
    eventBus: RedisEventBus;
    sessionId: string;
    runId: string;
    runOwners: Map<string, string>;
    busySessions: Set<string>;
  },
): Promise<void> {
  const channel = runChannel(ctx.runId);
  let publishChain: Promise<void> = Promise.resolve();

  const publish = (event: NexumRunEvent): void => {
    publishChain = publishChain
      .then(async () => {
        // Deltas are a live preview: persisting one row per token chunk would dwarf the real history.
        const seq = LIVE_ONLY_EVENTS.has(event.type) ? 0 : await ctx.repos.events.append(event);
        await ctx.eventBus.publish(channel, { seq, ...event });
      })
      .catch((err) => {
        process.stderr.write(
          `[nexum host] failed to persist/publish ${event.type} for ${ctx.runId}: ${describeError(err)}\n`,
        );
      });
  };

  bridge.begin({ runId: ctx.runId, write: publish, interactive });
  publish({ type: "run.started", runId: ctx.runId, sessionId: ctx.sessionId, goal, ts: Date.now() });

  const messageCountBefore = agent.conversation.getMessages().length;
  agent.conversation.presentationInstructions = presentationInstructions(presentation);
  agent.approvalMode = approvalMode;

  try {
    // Generated UI is beyond the quick local models: they write invalid programs slowly, so go to the primary.
    const escalate = modelTier === "primary" || presentation.mode === "openui";
    const answer = await agent.runUserMessage(goal, undefined, { escalate });
    const problems = openUiProblems(answer, presentation);
    const output: NexumRunOutput = presentOutput(
      problems ? await agent.runUserMessage(openUiRepairPrompt(problems), undefined, { escalate: true }) : answer,
      presentation,
    );
    bridge.flushThinking();
    publish({ type: "run.completed", runId: ctx.runId, output, ts: Date.now() });
    await publishChain;
    await ctx.repos.runs.complete(ctx.runId, "completed", { output });
  } catch (err) {
    bridge.flushThinking();
    const cancelled = agent.execution.signal?.aborted ?? false;
    const message = describeError(err);
    publish(
      cancelled
        ? { type: "run.cancelled", runId: ctx.runId, ts: Date.now() }
        : { type: "run.failed", runId: ctx.runId, error: message, ts: Date.now() },
    );
    await publishChain;
    await ctx.repos.runs.complete(ctx.runId, cancelled ? "cancelled" : "failed", { error: message });
  } finally {
    agent.conversation.presentationInstructions = "";
    bridge.end();
    agent.endExecutionRun();
    ctx.runOwners.delete(ctx.runId);
    ctx.busySessions.delete(ctx.sessionId);

    const allMessages = agent.conversation.getMessages();
    const newMessages = allMessages.slice(messageCountBefore);
    if (newMessages.length > 0) {
      await ctx.repos.messages
        .append(
          ctx.sessionId,
          newMessages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          })),
        )
        .catch((err) =>
          process.stderr.write(`[nexum host] failed to persist messages for ${ctx.sessionId}: ${describeError(err)}\n`),
        );
    }
    await ctx.repos.sessions.touch(ctx.sessionId, allMessages.length).catch(() => {});
  }
}
