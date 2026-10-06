/**
 * Bridges the Agent's callback-based AgentEvents (src/cli/agent.ts) onto the
 * wire-level NexumRunEvent stream (src/protocol/types.ts) for one run at a
 * time.
 *
 * Agent.on() has no unsubscribe (review debt, not this module's problem to
 * fix), so instead of attaching/detaching per-run listeners this registers
 * ONE set of listeners for the process lifetime and routes them through
 * whichever run is currently "active". This is sound because src/host
 * serializes runs on a single Agent instance (one ReAct loop in flight at a
 * time) — see src/host/server.ts's busy-run guard.
 *
 * Granularity is deliberately coarser than the raw token stream: thinking
 * deltas are buffered and flushed as one `thought` event per tool call /
 * run end, mirroring the original agentic-chat ReAct loop's one-event-per-
 * iteration shape (src/app/api/agent/route.ts) rather than re-streaming
 * every model chunk over the wire.
 */

import type { Agent } from "../cli/agent.js";
import type { NexumRunEvent, ResolveInteractionRequest } from "../protocol/types.js";
import type { ApprovalRequest, ClarificationRequest } from "../runtime/types.js";

export interface ActiveRunSink {
  runId: string;
  write: (event: NexumRunEvent) => void;
  /** The client can answer approvals/clarifications; otherwise they are denied/skipped. */
  interactive: boolean;
}

const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60_000;

// IntentResolver.refinePrompt ignores ids that match no option, so this answers
// a clarification without changing the user's prompt.
const SKIPPED_CLARIFICATION_ID = "skipped";

export type ResolveOutcome =
  { ok: true } | { ok: false; reason: "not_found" | "already_resolved" | "invalid"; message: string };

interface PendingInteraction {
  kind: "approval" | "clarification";
  optionIds: string[];
  resolved: boolean;
  timer: NodeJS.Timeout;
}

export class RunEventBridge {
  private active: ActiveRunSink | null = null;
  private thinkingBuf: string[] = [];
  private toolCallSeq = 0;
  private lastToolCallId = "";
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(
    private readonly agent: Agent,
    private readonly opts: { interactionTimeoutMs?: number } = {},
  ) {
    agent.on("onThinking", (text) => {
      if (!this.active) return;
      this.thinkingBuf.push(text);
    });

    agent.on("onToolCall", (name, args) => {
      if (!this.active) return;
      this.flushThinking();
      this.toolCallSeq += 1;
      this.lastToolCallId = `call_${this.toolCallSeq}`;
      this.active.write({
        type: "tool.started",
        runId: this.active.runId,
        callId: this.lastToolCallId,
        name,
        args,
        ts: Date.now(),
      });
    });

    agent.on("onToolResult", (name, result) => {
      if (!this.active) return;
      this.active.write({
        type: "tool.completed",
        runId: this.active.runId,
        callId: this.lastToolCallId,
        name,
        result,
        ts: Date.now(),
      });
    });

    agent.on("onModelUsed", (tier, model) => {
      if (!this.active) return;
      this.active.write({ type: "model.used", runId: this.active.runId, tier, model, ts: Date.now() });
    });

    agent.on("onApprovalRequested", (request) => this.requestApproval(request));
    agent.on("onClarificationRequested", (request) => this.requestClarification(request));
  }

  private requestApproval(request: ApprovalRequest): void {
    if (!this.active?.interactive) {
      this.agent.resolveApproval(request.id, false);
      return;
    }
    this.track(request.id, "approval", []);
    this.active.write({
      type: "run.approval.required",
      runId: this.active.runId,
      interactionId: request.id,
      title: request.title,
      summary: request.summary,
      ts: Date.now(),
    });
  }

  private requestClarification(request: ClarificationRequest): void {
    if (!this.active?.interactive) {
      this.agent.resolveClarification({ id: request.id, selectedId: SKIPPED_CLARIFICATION_ID });
      return;
    }
    // Custom free-text answers can't be carried by the protocol, so don't offer that choice.
    const options = request.options.filter((o) => !o.isCustom);
    this.track(
      request.id,
      "clarification",
      options.map((o) => o.id),
    );
    this.active.write({
      type: "run.clarification.required",
      runId: this.active.runId,
      interactionId: request.id,
      question: request.question,
      options: options.map((o) => ({ id: o.id, label: o.label, description: o.detail })),
      ts: Date.now(),
    });
  }

  /** Registers a pending interaction that fails closed (deny / skip) if nobody answers in time. */
  private track(id: string, kind: PendingInteraction["kind"], optionIds: string[]): void {
    const timer = setTimeout(
      () => this.settle(id, kind === "approval" ? { approved: false } : { selectedId: SKIPPED_CLARIFICATION_ID }),
      this.opts.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS,
    );
    timer.unref();
    this.pending.set(id, { kind, optionIds, resolved: false, timer });
  }

  /** Applies a client's answer to a pending interaction, validating it against what was asked. */
  resolve(interactionId: string, resolution: ResolveInteractionRequest): ResolveOutcome {
    const interaction = this.pending.get(interactionId);
    if (!interaction) return rejected("not_found", `no pending interaction "${interactionId}"`);
    if (interaction.resolved)
      return rejected("already_resolved", `interaction "${interactionId}" was already resolved`);

    // An approval is never inferred: a missing `approved` must not default to yes.
    if (interaction.kind === "approval" && typeof resolution.approved !== "boolean") {
      return rejected("invalid", "an approval requires a boolean `approved`");
    }
    if (interaction.kind === "clarification" && !interaction.optionIds.includes(resolution.selectedId ?? "")) {
      return rejected("invalid", `selectedId must be one of: ${interaction.optionIds.join(", ")}`);
    }
    this.settle(interactionId, resolution);
    return { ok: true };
  }

  private settle(id: string, answer: { approved?: boolean; selectedId?: string }): void {
    const interaction = this.pending.get(id);
    if (!interaction || interaction.resolved) return;
    interaction.resolved = true;
    clearTimeout(interaction.timer);

    const runId = this.active?.runId ?? "";
    if (interaction.kind === "approval") {
      const approved = answer.approved === true;
      this.agent.resolveApproval(id, approved);
      this.active?.write({ type: "run.approval.resolved", runId, interactionId: id, approved, ts: Date.now() });
      return;
    }
    const selectedId = answer.selectedId ?? SKIPPED_CLARIFICATION_ID;
    this.agent.resolveClarification({ id, selectedId });
    this.active?.write({ type: "run.clarification.resolved", runId, interactionId: id, selectedId, ts: Date.now() });
  }

  /** Denies/skips everything still waiting, so a cancelled or finished run can't stay blocked on a client. */
  denyPending(): void {
    for (const [id, interaction] of this.pending) {
      if (interaction.resolved) continue;
      interaction.resolved = true;
      clearTimeout(interaction.timer);
      if (interaction.kind === "approval") this.agent.resolveApproval(id, false);
      else this.agent.resolveClarification({ id, selectedId: SKIPPED_CLARIFICATION_ID });
    }
  }

  /** Attach a new run's sink; must be paired with `end()`. Only one run may be active at a time. */
  begin(sink: ActiveRunSink): void {
    this.active = sink;
    this.pending.clear();
    this.thinkingBuf = [];
    this.toolCallSeq = 0;
  }

  /** Flush any buffered thinking (call before emitting the terminal run event). */
  flushThinking(): void {
    if (!this.active || this.thinkingBuf.length === 0) return;
    const text = this.thinkingBuf.join("");
    this.thinkingBuf = [];
    this.active.write({ type: "thought", runId: this.active.runId, text, ts: Date.now() });
  }

  end(): void {
    this.flushThinking();
    this.denyPending();
    this.pending.clear();
    this.active = null;
  }

  get isBusy(): boolean {
    return this.active !== null;
  }
}

function rejected(reason: "not_found" | "already_resolved" | "invalid", message: string): ResolveOutcome {
  return { ok: false, reason, message };
}
