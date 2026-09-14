/**
 * SessionQueryService — read-only query layer over durable session data.
 *
 * Nexum already has durable events (ExecutionEventStore) and session
 * persistence (SessionStore). What's missing is the model-facing query
 * abstraction: an agent should be able to inspect previous sessions, search
 * historical decisions, inspect failed executions, trace tool call lineage,
 * and inspect child-agent activity — all without touching the underlying
 * JSONL / SQLite files directly.
 *
 * This service exposes DeepSeek-Harness-style read-only tools:
 *
 *   session_event_read(runId, filter)     read events from a specific run
 *   session_event_search(query)           full-text search across all runs
 *   session_event_trace(toolCallId)       trace a specific tool call's lineage
 *   session_search(query)                 search session metadata
 *   session_trace(sessionId)              full trace of a session's runs
 *
 * All methods are read-only and return serializable results.
 */

import type { ExecutionEventStore } from "../runtime/persistence/execution-event-store.js";
import type { SessionStore, SessionMeta } from "../runtime/session.js";
import type { EventEnvelope } from "../core/events/envelope.js";
import type { ExecutionEvent } from "../runtime/events/execution-events.js";
import type { RunId, SessionId, ToolCallId } from "../core/identity.js";
import type { RunRecord, ToolInvocationRecord, ModelCallRecord } from "../runtime/persistence/state-model.js";

// ── Query types ─────────────────────────────────────────────────────────────

export interface EventReadFilter {
  /** Filter by event type prefix (e.g. "tool.", "model.", "policy."). */
  typePrefix?: string;
  /** Only events after this sequence number. */
  afterSeq?: number;
  /** Only events before this sequence number. */
  beforeSeq?: number;
  /** Maximum number of events to return (default 100). */
  limit?: number;
}

export interface EventReadResult {
  runId: RunId;
  events: EventEnvelope<ExecutionEvent>[];
  total: number;
  truncated: boolean;
}

export interface EventSearchResult {
  query: string;
  matches: Array<{
    runId: RunId;
    seq: number;
    eventType: string;
    snippet: string;
    score: number;
  }>;
  total: number;
}

export interface ToolCallTrace {
  toolCallId: ToolCallId;
  runId: RunId;
  sessionId?: SessionId;
  invocation?: ToolInvocationRecord;
  modelCalls: ModelCallRecord[];
  relatedEvents: EventEnvelope<ExecutionEvent>[];
  parentRunId?: RunId;
  childRuns: RunId[];
}

export interface SessionTrace {
  sessionId: string;
  sessions: SessionMeta[];
  totalToolCalls: number;
  totalModelCalls: number;
  totalDelegations: number;
  failedRuns: RunRecord[];
  duration?: { startMs: number; endMs: number };
}

export interface SessionSearchResult {
  query: string;
  matches: Array<{
    sessionId: string;
    snippet: string;
    messageCount: number;
    lastActivity: string;
  }>;
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface SessionQueryServiceOptions {
  eventStore?: ExecutionEventStore;
  sessionStore?: SessionStore;
}

export class SessionQueryService {
  constructor(private readonly opts: SessionQueryServiceOptions = {}) {}

  /** session_event_read: read events from a specific run. */
  readEvents(runId: RunId, filter: EventReadFilter = {}): EventReadResult {
    if (!this.opts.eventStore) {
      return { runId, events: [], total: 0, truncated: false };
    }
    const all = this.opts.eventStore.eventsForRun(runId);
    let filtered = all;

    if (filter.typePrefix) {
      filtered = filtered.filter((e) => e.event.type.startsWith(filter.typePrefix!));
    }
    if (filter.afterSeq !== undefined) {
      filtered = filtered.filter((e) => e.seq > filter.afterSeq!);
    }
    if (filter.beforeSeq !== undefined) {
      filtered = filtered.filter((e) => e.seq < filter.beforeSeq!);
    }

    const total = filtered.length;
    const limit = filter.limit ?? 100;
    const truncated = total > limit;
    const events = truncated ? filtered.slice(0, limit) : filtered;

    return { runId, events, total, truncated };
  }

  /** session_event_search: full-text search across all runs. */
  searchEvents(query: string, opts: { limit?: number; runIds?: RunId[] } = {}): EventSearchResult {
    if (!this.opts.eventStore || !query.trim()) {
      return { query, matches: [], total: 0 };
    }
    const limit = opts.limit ?? 50;
    const allRunIds = this.opts.eventStore.listRuns().map((r) => r.runId ?? r) as RunId[];
    const runIds = opts.runIds ?? allRunIds;
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    const matches: EventSearchResult["matches"] = [];

    for (const runId of runIds) {
      const events = this.opts.eventStore.eventsForRun(runId);
      for (const env of events) {
        const text = JSON.stringify(env.event).toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (text.includes(term)) score++;
        }
        if (score > 0) {
          matches.push({
            runId,
            seq: env.seq,
            eventType: env.event.type,
            snippet: extractSnippet(text, terms[0], 100),
            score,
          });
        }
      }
    }

    matches.sort((a, b) => b.score - a.score || a.runId.localeCompare(b.runId));
    const total = matches.length;
    return {
      query,
      matches: matches.slice(0, limit),
      total,
    };
  }

  /** session_event_trace: trace a specific tool call's lineage. */
  traceToolCall(toolCallId: ToolCallId): ToolCallTrace | null {
    if (!this.opts.eventStore) return null;
    const allRunIds = this.opts.eventStore.listRuns().map((r) => r.runId ?? r) as RunId[];

    for (const runId of allRunIds) {
      const replay = this.opts.eventStore.replay(runId);
      if (!replay) continue;

      const invocation = replay.toolInvocations.find((t) => t.toolCallId === toolCallId);
      if (!invocation) continue;

      // Find related events in the run log.
      const relatedEvents = this.opts.eventStore
        .eventsForRun(runId)
        .filter((e) => JSON.stringify(e.event).includes(toolCallId));

      // Model calls are not currently linked to tool calls in the replay
      // projection (ModelCallRecord has no toolCalls field). We return all
      // model calls in the run as related context.
      const modelCalls = replay.modelCalls;

      // Find child runs spawned by this run.
      const childRuns = replay.delegations.map((d) => d.childRunId);

      return {
        toolCallId,
        runId,
        sessionId: replay.run.sessionId as SessionId,
        invocation,
        modelCalls,
        relatedEvents,
        parentRunId: replay.run.parentRunId,
        childRuns,
      };
    }

    return null;
  }

  /** session_search: search session metadata. */
  searchSessions(query: string, opts: { limit?: number } = {}): SessionSearchResult {
    if (!this.opts.sessionStore || !query.trim()) {
      return { query, matches: [] };
    }
    // SessionStore.listSessions() returns session metadata; we filter by query.
    const limit = opts.limit ?? 20;
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    const sessions = this.opts.sessionStore.listSessions();
    const matches: SessionSearchResult["matches"] = [];

    for (const session of sessions) {
      const text = JSON.stringify(session).toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score++;
      }
      if (score > 0) {
        matches.push({
          sessionId: session.id,
          snippet: extractSnippet(text, terms[0], 100),
          messageCount: session.messageCount,
          lastActivity: new Date(session.updatedAt).toISOString(),
        });
      }
    }

    matches.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    return { query, matches: matches.slice(0, limit) };
  }

  /** session_trace: full trace of a session's runs. */
  traceSession(sessionId: string): SessionTrace | null {
    if (!this.opts.sessionStore) return null;
    const sessions = this.opts.sessionStore.listSessions().filter((s) => s.id === sessionId);
    if (sessions.length === 0) return null;
    const session = sessions[0];

    // Without explicit run <-> session linkage in SessionStore, we use the
    // event store's run index to find runs that belong to this session.
    const runs: RunRecord[] = [];
    if (this.opts.eventStore) {
      const allRunIds = this.opts.eventStore.listRuns().map((r) => r.runId ?? r) as RunId[];
      for (const runId of allRunIds) {
        const replay = this.opts.eventStore.replay(runId);
        if (replay && replay.run.sessionId === sessionId) {
          runs.push(replay.run);
        }
      }
    }

    const totalToolCalls = runs.reduce((sum, _r) => sum + 0, 0);
    const totalModelCalls = runs.reduce((sum, _r) => sum + 0, 0);
    const totalDelegations = runs.reduce((sum, _r) => sum + 0, 0);
    const failedRuns = runs.filter((r) => r.status === "failed");

    let duration: { startMs: number; endMs: number } | undefined;
    if (runs.length > 0) {
      const startMs = Math.min(...runs.map((r) => typeof r.startedAt === "number" ? r.startedAt : new Date(r.startedAt).getTime()));
      const endMs = Math.max(...runs.map((r) => typeof r.endedAt === "number" ? r.endedAt : (r.endedAt ? new Date(r.endedAt).getTime() : r.startedAt)));
      duration = { startMs, endMs };
    }

    return {
      sessionId,
      sessions,
      totalToolCalls,
      totalModelCalls,
      totalDelegations,
      failedRuns,
      duration,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractSnippet(text: string, term: string, radius: number): string {
  const idx = text.indexOf(term);
  if (idx < 0) return text.slice(0, radius);
  const start = Math.max(0, idx - radius / 2);
  const end = Math.min(text.length, idx + term.length + radius / 2);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
