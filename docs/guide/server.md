# Nexum Server Architecture & Runtime Specification

## 1. Overview & System Invariants

Nexum Server is a durable runtime server that acts as the single authoritative execution brain for all clients (Claude-Code-like CLI, Nexum TUI, Agentic Chat Web UI, and future IDE extensions).

### Non-Negotiable Invariants

1. **One Authoritative Brain**: Clients **never** execute an independent agent loop. All LLM calls, tool runs, policy gates, and verification steps are executed exclusively by the Nexum Server runtime.
2. **Canonical State in PostgreSQL**: PostgreSQL is the single source of truth for sessions, message history, runs, and sequenced execution events. The local JSON session store is demoted to standalone legacy CLI fallback.
3. **Redis for Live Fan-out Only**: Redis Pub/Sub distributes live events to active subscribers. Redis is never an authoritative state store and never determines event history.
4. **Monotonic Event Sequencing**: Every durable event possesses a database-assigned monotonic sequence number (`seq`). Live delivery and historical replay use the exact same event envelope.
5. **Lossless, Duplicate-Free Reconnection**: Reconnecting clients using `Last-Event-ID` or `?after=<seq>` receive replayed events from PostgreSQL before transitioning to the live stream with deduplication by sequence.
6. **Session-Level Execution Concurrency**: One session has at most one active interactive run at a time (turn-taking). Independent sessions execute concurrently up to the global server resource limit.
7. **Crash-Safe Reconciliation**: A server crash never leaves active runs permanently in `running`. On startup, orphaned runs are deterministically reconciled and marked as `interrupted`.
8. **Security at the Network Boundary**: Loopback (`127.0.0.1`) permits local development access without authentication. Non-loopback binding (`0.0.0.0`, LAN, public) strictly requires `NEXUM_SERVER_TOKEN` via `Authorization: Bearer <token>`.
9. **Single Workspace per Server Instance (v1)**: One server instance owns one designated workspace root directory (`workspaceRoot`).

---

## 2. Session Lifecycle

```text
POST /sessions
      ↓
PostgreSQL session row created
      ↓
Session Runtime instantiated on demand (lazy)
      ↓
Message history loaded from PostgreSQL
      ↓
AgentConversation.loadMessages(messages)
      ↓
Run executed -> new messages appended to PostgreSQL
```

- **Creation**: `POST /sessions` records `id`, `workspaceRoot`, and timestamps in PostgreSQL.
- **Hydration**: When a session receives a run, the server queries `messages` for that `sessionId` and hydrates the agent's in-memory `AgentConversation`.
- **Eviction**: Inactive session agents are idle-evicted after `idleTtlMs` (default 30 min) to release memory, LSP servers, and plugin hosts, but their full state remains durable in PostgreSQL.

---

## 3. Run Lifecycle & State Machine

Every run represents one goal-driven execution turn:

```text
                      ┌───────────────┐
                      │    queued     │
                      └───────┬───────┘
                              │
                              ▼
                      ┌───────────────┐
                      │    running    │
                      └───────┬───────┘
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
   │  completed  │     │   failed    │     │  cancelled  │
   └─────────────┘     └─────────────┘     └─────────────┘
                              ▲
                              │ (on crash/restart)
                       ┌──────────────┐
                       │ interrupted  │
                       └──────────────┘
```

- `queued`: Run created and registered, waiting for session execution slot.
- `running`: Active agent execution in progress.
- `completed`: Terminal state; goal accomplished successfully.
- `failed`: Terminal state; agent execution crashed or failed.
- `cancelled`: Terminal state; client initiated cooperative cancellation.
- `interrupted`: Terminal state; server restarted or crashed while run was in flight.

---

## 4. Human-in-the-Loop Interaction Protocol

Human interactions (tool approval gates, user clarifications, and MCP parameter elicitations) are first-class network resources:

```text
Agent execution
      ↓
Approval / Clarification / MCP required
      ↓
Interaction recorded (status: "pending")
      ↓
Event emitted (run.approval.required / run.clarification.required / run.elicitation.required)
      ↓
Client answers via POST /runs/:runId/interactions/:interactionId/resolve
      ↓
Interaction resolved -> Agent execution resumes
```

If a client disconnects while an interaction is pending, the interaction remains pending in PostgreSQL, allowing any authorized client to resolve it upon reconnect.

---

## 5. Event Streaming & Reconnection (SSE)

Clients subscribe to run telemetry via `GET /runs/:runId/events` (HTTP Server-Sent Events).

### Reconnection Handshake
1. Client reconnects with header `Last-Event-ID: <seq>` or query `?after=<seq>`.
2. Server queries PostgreSQL: `SELECT * FROM execution_events WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC`.
3. Server streams all historical events.
4. Server binds to Redis live Pub/Sub channel (`nexum:run:<runId>`), filtering out any event where `event.seq <= lastSeenSeq`.
5. Zero events are lost; zero events are duplicated.

---

## 6. Crash Recovery & Shutdown

### Startup Reconciliation
On server boot:
1. Query PostgreSQL: `SELECT * FROM runs WHERE status IN ('queued', 'running')`.
2. For each orphaned run, transition status to `interrupted`.
3. Record `error: "server_restart"` and `finishedAt: now()`.

### Graceful Shutdown (SIGTERM / SIGINT)
1. Mark server state as `draining`.
2. Stop accepting new runs (`POST /sessions/:id/runs` returns 503).
3. Wait up to `NEXUM_SHUTDOWN_GRACE_MS` (default 10,000ms) for active runs to complete.
4. If timeout expires, abort remaining runs and mark them `interrupted`.
5. Cleanly close Redis and PostgreSQL connection pools.
