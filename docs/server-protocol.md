# Nexum Server Protocol v1 Specification

Protocol Version: `1.0.0`

## 1. System Endpoints

### `GET /`
Basic server identification.
- **Status**: 200 OK
- **Response**:
  ```json
  {
    "name": "nexum-server",
    "version": "2.0.0-alpha.2",
    "protocolVersion": "1.0.0",
    "instanceId": "inst-182390"
  }
  ```

### `GET /health`
Process-level liveness probe.
- **Status**: 200 OK
- **Response**:
  ```json
  {
    "status": "ok",
    "uptime": 128.4
  }
  ```

### `GET /ready`
Deep dependency readiness check (PostgreSQL, Redis, Runtime).
- **Status**: 200 OK (or 503 Service Unavailable if degraded)
- **Response**:
  ```json
  {
    "status": "ready",
    "checks": {
      "postgres": "ok",
      "redis": "ok",
      "runtime": "ok"
    }
  }
  ```

### `GET /capabilities`
What this server can do, so clients discover it instead of assuming. Requires the auth token when one is configured.
Metadata only: no file paths, commands, arguments, environment or keys.
- **Status**: 200 OK
- **Response**:
  ```json
  {
    "protocolVersion": "1.0.0",
    "agents": ["devagent"],
    "strategies": ["react", "plan_execute", "graph"],
    "presentations": [
      { "format": "markdown" },
      { "format": "openui", "schemaVersion": "0.3.0" }
    ],
    "tools": [
      { "id": "read_file", "description": "...", "pack": "Filesystem", "risk": "medium", "uiInvocable": true },
      { "id": "run_shell", "description": "...", "pack": "Shell", "risk": "high", "uiInvocable": false }
    ],
    "skills": [{ "id": "deploy", "name": "Deploy", "description": "...", "tags": ["ops"], "scope": "workspace" }],
    "models": [{ "name": "qwen3:4b", "capabilities": ["tools", "quick", "coding"] }],
    "mcp": [{ "name": "github", "trust": "trusted", "status": "connected", "tools": 26 }]
  }
  ```
- `uiInvocable` means a rendered UI may call the tool directly (see [UI tool calls](#6-ui-tool-calls)). It is a
  separate, opt-in policy flag, not a function of `risk`.
- `mcp` lists the configured MCP servers. The host connects each one once, shared by every session, and closes
  them on shutdown. `status` is `connected`, `failed`, or `denied` (the trust policy refused it, for example an
  `ask` server with no recorded approval). Commands, arguments and error text are never exposed. Connected
  servers' tools appear in `tools` with `pack: "MCP"`, a risk derived from the server's own read-only /
  destructive hints, and are never `uiInvocable`. A server tool whose name matches an existing tool is ignored, so
  a server cannot replace a built-in tool. MCP elicitation requests are declined until the protocol can carry them.
- Model listing is bounded to 5 seconds; an unreachable provider yields an empty `models`.

---

## 2. Session Endpoints

### `POST /sessions`
Creates a new conversation session.
- **Headers**:
  - `Idempotency-Key`: Optional UUID
- **Request Body**:
  ```json
  {
    "title": "Optional session title"
  }
  ```
- **Status**: 201 Created
- **Response**:
  ```json
  {
    "id": "sess-4fa9b2",
    "workspaceRoot": "/path/to/workspace",
    "title": "Optional session title",
    "createdAt": 1727900000000
  }
  ```

### `GET /sessions`
Lists persisted sessions (most recently updated first).
- **Status**: 200 OK
- **Response**:
  ```json
  {
    "sessions": [
      {
        "id": "sess-4fa9b2",
        "workspaceRoot": "/path/to/workspace",
        "title": "Fix authentication bug",
        "messageCount": 6,
        "createdAt": 1727900000000,
        "updatedAt": 1727900050000
      }
    ]
  }
  ```

### `GET /sessions/:id`
Retrieves a session and its durable message history.
- **Status**: 200 OK (or 404 Not Found)
- **Response**:
  ```json
  {
    "session": {
      "id": "sess-4fa9b2",
      "workspaceRoot": "/path/to/workspace",
      "messageCount": 2,
      "createdAt": 1727900000000,
      "updatedAt": 1727900050000
    },
    "messages": [
      {
        "role": "user",
        "content": "Fix the flaky test in session_spec.rb",
        "createdAt": 1727900010000
      },
      {
        "role": "assistant",
        "content": "I identified the race condition and patched the spec.",
        "createdAt": 1727900045000
      }
    ]
  }
  ```

---

## 3. Run Endpoints

### `POST /sessions/:sessionId/runs`
Initiates a new execution turn. Returns immediately with the created run resource.
- **Headers**:
  - `Idempotency-Key`: Optional UUID
- **Request Body**:
  ```json
  {
    "goal": "Refactor auth_service.rb to use token revocation list",
    "presentation": {
      "mode": "auto"
    },
    "interactive": false
  }
  ```
  | Field | Meaning |
  | --- | --- |
  | `goal` | Required. The user's message. |
  | `presentation` | Optional, default `{ "mode": "auto" }`. How the answer should be presented; see below. |
  | `interactive` | `true` if this client will show approvals and clarifications to a user. Default `false`: approvals are denied and clarifications skipped, so a headless client never leaves a run waiting. |
  **Presentation.** `{ mode, openui? }` where `mode` is `auto`, `markdown` or `openui`, and `openui` is the client's offer:
  `{ "schemaVersion", "spec", "schema" }` (`spec` is prompt-ready component documentation, max 32,000 chars; `schema` is
  the library's JSON schema, which Nexum validates the answer against). The client says what it can render; Nexum decides
  the format and reports it in `run.completed`.
  - `markdown`: nothing is injected; the answer is Markdown.
  - `auto`: with an `openui` offer, the spec is added to this run's prompt and the model may answer in OpenUI when the
    content fits; without an offer, Markdown.
  - `openui`: requires an offer; the model is told to answer in OpenUI.
  - An answer is reported as `openui` only if it starts with `root =` (an enclosing code fence is allowed) **and** parses
    against the schema with no errors. Anything else, including prose that contains a program, is returned unchanged as
    `markdown`, so no text is dropped. There is no repair step.
  - An offer whose `schemaVersion` differs from the server's (see `/capabilities`) is refused with
    `400 unsupported_presentation`, unless `mode` is `markdown`.
- **Status**:
  - `201 Created` — Run accepted and started.
  - `400 Bad Request` — Invalid body, or `unsupported_presentation`.
  - `409 Conflict` — Session already has a run in progress. The body carries that run's id:
    `{ "error": "run_in_progress", "message": "...", "runId": "run-98a72b" }`.
- **Response (201)**:
  ```json
  {
    "run": {
      "id": "run-98a72b",
      "sessionId": "sess-4fa9b2",
      "status": "queued",
      "goal": "Refactor auth_service.rb to use token revocation list",
      "createdAt": 1727900060000
    }
  }
  ```

### `GET /runs/:runId`
Retrieves the metadata and current state of a run.
- **Status**: 200 OK (or 404 Not Found)
- **Response**:
  ```json
  {
    "id": "run-98a72b",
    "sessionId": "sess-4fa9b2",
    "status": "running",
    "goal": "Refactor auth_service.rb",
    "waitingOn": null,
    "startedAt": 1727900061000,
    "finishedAt": null,
    "output": null,
    "error": null
  }
  ```
  When finished, `output` is `{ "format": "markdown" | "openui", "content": "...", "schemaVersion"? }`. `format` is
  what the answer actually is, not what was requested: `openui` is reported only for an answer that validated against
  the client's schema (see Presentation above); `content` is then the bare program.

### `POST /runs/:runId/cancel`
Cooperatively cancels an in-flight run via the agent's `AbortController`. Anything the run is waiting on
(an approval or clarification) is denied or skipped so the run can end.
- **Status**: 200 OK
- **Response**:
  ```json
  {
    "cancelled": true
  }
  ```

---

## 4. Event Streaming & SSE

### `GET /runs/:runId/events`
Server-Sent Events endpoint streaming execution telemetry.
- **Headers**:
  - `Accept: text/event-stream`
  - `Last-Event-ID: <seq>` (Optional; resumes replay from sequence `<seq>`)
- **Query Parameter**:
  - `?after=<seq>` (Alternative to `Last-Event-ID`)

#### SSE Wire Format
Each event includes a database monotonic integer `id`:
```http
id: 101
event: run.started
data: {"type":"run.started","runId":"run-98a72b","sessionId":"sess-4fa9b2","goal":"Refactor auth","ts":1727900061000}

id: 102
event: tool.started
data: {"type":"tool.started","runId":"run-98a72b","callId":"call_1","name":"read_file","args":{"path":"app/services/auth_service.rb"},"ts":1727900062000}

id: 103
event: tool.completed
data: {"type":"tool.completed","runId":"run-98a72b","callId":"call_1","name":"read_file","result":{"content":"..."},"ts":1727900063000}

id: 104
event: run.completed
data: {"type":"run.completed","runId":"run-98a72b","output":{"format":"markdown","content":"Refactoring complete."},"ts":1727900065000}
```

---

## 5. Human-in-the-Loop Interactions

A run created with `interactive: true` pauses when the agent needs a decision, emitting an event and waiting:

| Event | Fields |
| --- | --- |
| `run.approval.required` | `interactionId`, `title`, `summary` |
| `run.clarification.required` | `interactionId`, `question`, `options: [{ id, label, description? }]` |

The run continues on the same connection once the interaction is resolved; a `run.approval.resolved` /
`run.clarification.resolved` event follows. Unanswered interactions fail closed after 5 minutes (approval denied,
clarification skipped) and are reported with the same `*.resolved` events. Cancelling or ending the run releases
anything still pending. MCP elicitation is not yet carried by this protocol.

### `POST /runs/:runId/interactions/:interactionId/resolve`
Answers a pending interaction.
- **Request Body** — an approval must say `approved` explicitly; it is never inferred:
  ```json
  { "approved": true }
  ```
  Or, for a clarification, one of the offered option ids:
  ```json
  { "selectedId": "opt-2" }
  ```
- **Status**:
  - `200 OK` — `{ "resolved": true, "interactionId": "appr-1892" }`
  - `400 Bad Request` — `approved` missing for an approval, or `selectedId` not among the offered options.
  - `404 Not Found` — `run_not_found`, or `interaction_not_found` (never requested, or the run has finished).
  - `409 Conflict` — `interaction_already_resolved`.

---

## 6. UI tool calls

### `POST /sessions/:sessionId/tools/:name`
Lets a rendered UI (for example an OpenUI `Query`) call a tool directly, outside any agent run.
- **Request Body**: `{ "args": { ... } }` (`args` defaults to `{}`)
- Only tools whose `/capabilities` entry has `uiInvocable: true` run here. Eligibility is an explicit opt-in on the
  tool's policy and is separate from `risk`; a high-risk tool never qualifies even if mislabelled. Everything else,
  and anything that changes state, must go through an agent run so policy and approvals apply.
- The tool still runs through the gateway: argument validation and policy checks apply.
- **Status**:
  - `200 OK` — `{ "ok": true, "data": { ... } }` or `{ "ok": false, "error": { "code", "message" } }` when the
    gateway rejects the call (for example `ValidationError`). A tool may also return its own `{ "error": ... }`
    inside `data`.
  - `403 Forbidden` — `tool_requires_run`: not UI-invocable. The tool is not executed.
  - `404 Not Found` — `tool_not_found` or unknown session.
  - `400 Bad Request` — `args` is not an object.

---

## 7. Standardized Error Contract

Error responses are a flat JSON object with a lowercase snake_case code, a message, and sometimes extra fields:
```json
{
  "error": "run_in_progress",
  "message": "session \"sess-4fa9b2\" already has a run in progress",
  "runId": "run-98a72b"
}
```

Codes in use: `not_found`, `session_not_found`, `run_not_found`, `run_in_progress` (409), `invalid_request` (400),
`unsupported_presentation` (400), `tool_not_found` (404), `tool_requires_run` (403),
`interaction_not_found` (404), `interaction_already_resolved` (409), `unauthorized` (401),
`server_not_ready` (503), `internal_error` (500).
