/**
 * Session history tools — read-only, model-facing access to past work
 * through SessionQueryService (durable run logs in .nexum/runs + the
 * session index). Lets an agent answer "what did we do last time / why did
 * that run fail" from records instead of guessing.
 *
 *   session_search   find past sessions and run events matching a query
 *   session_events   read one run's execution events (optionally by type)
 *   session_trace    a tool call's lineage: invocation, model calls, events
 */

import { Tool, ToolError } from "./tool.js";
import type { SessionQueryService } from "../session-query/index.js";
import type { RunId, ToolCallId } from "../core/identity.js";

const MAX_LIMIT = 50;

function limitOf(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${key} is required`);
  return value.trim();
}

export class SessionSearchTool extends Tool {
  constructor(private readonly query: SessionQueryService) {
    super();
  }
  get name() {
    return "session_search";
  }
  get description() {
    return "Search past sessions and recorded run events (tool calls, model calls, failures) by keywords. Returns session ids, run ids and snippets to inspect further with session_events / session_trace.";
  }
  override get tags() {
    return ["session", "history", "previous", "past", "search", "run"];
  }
  get parameters() {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for" },
        limit: { type: "integer", description: `Max results per kind (1-${MAX_LIMIT}, default 10)` },
      },
      required: ["query"],
    };
  }
  async call(args: Record<string, unknown>) {
    const q = requireString(args, "query");
    const limit = limitOf(args.limit, 10);
    return {
      query: q,
      sessions: this.query.searchSessions(q, { limit }).matches,
      events: this.query.searchEvents(q, { limit }).matches,
    };
  }
}

export class SessionEventsTool extends Tool {
  constructor(private readonly query: SessionQueryService) {
    super();
  }
  get name() {
    return "session_events";
  }
  get description() {
    return "Read the recorded execution events of one past run (from session_search), optionally filtered by event type prefix such as 'tool.' or 'model.'.";
  }
  override get tags() {
    return ["session", "history", "run", "events", "replay"];
  }
  get parameters() {
    return {
      type: "object",
      properties: {
        run_id: { type: "string" },
        type_prefix: { type: "string", description: "e.g. tool., model., policy." },
        limit: { type: "integer", description: `1-${MAX_LIMIT}, default 30` },
      },
      required: ["run_id"],
    };
  }
  async call(args: Record<string, unknown>) {
    const runId = requireString(args, "run_id") as RunId;
    const result = this.query.readEvents(runId, {
      ...(typeof args.type_prefix === "string" && args.type_prefix ? { typePrefix: args.type_prefix } : {}),
      limit: limitOf(args.limit, 30),
    });
    return {
      run_id: result.runId,
      total: result.total,
      truncated: result.truncated,
      events: result.events.map((e) => ({ seq: e.seq, type: e.event.type, at: e.ts, event: e.event })),
    };
  }
}

export class SessionTraceTool extends Tool {
  constructor(private readonly query: SessionQueryService) {
    super();
  }
  get name() {
    return "session_trace";
  }
  get description() {
    return "Trace one recorded tool call: its invocation record, the model calls around it, related events and child runs.";
  }
  override get tags() {
    return ["session", "history", "trace", "tool call", "lineage"];
  }
  get parameters() {
    return {
      type: "object",
      properties: { tool_call_id: { type: "string" } },
      required: ["tool_call_id"],
    };
  }
  async call(args: Record<string, unknown>) {
    const id = requireString(args, "tool_call_id") as ToolCallId;
    const trace = this.query.traceToolCall(id);
    if (!trace) return { error: "NotFound", message: `no recorded tool call ${id}` };
    return trace as unknown as Record<string, unknown>;
  }
}
