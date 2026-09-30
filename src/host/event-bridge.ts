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
import type { NexumRunEvent } from "../protocol/types.js";

export interface ActiveRunSink {
  runId: string;
  write: (event: NexumRunEvent) => void;
}

export class RunEventBridge {
  private active: ActiveRunSink | null = null;
  private thinkingBuf: string[] = [];
  private toolCallSeq = 0;
  private lastToolCallId = "";

  constructor(agent: Agent) {
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
  }

  /** Attach a new run's sink; must be paired with `end()`. Only one run may be active at a time. */
  begin(sink: ActiveRunSink): void {
    this.active = sink;
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
    this.active = null;
  }

  get isBusy(): boolean {
    return this.active !== null;
  }
}
