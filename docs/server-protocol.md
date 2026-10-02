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
Advertises supported agents, execution strategies, and features.
- **Status**: 200 OK
- **Response**:
  ```json
  {
    "protocolVersion": "1.0.0",
    "serverVersion": "2.0.0-alpha.2",
    "agents": ["dev-agent"],
    "strategies": ["react", "plan-execute"],
    "features": {
      "streaming": true,
      "replay": true,
      "approvals": true,
      "clarifications": true,
      "mcpElicitation": true
    }
  }
  ```

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
    "goal": "Refactor auth_service.rb to use token revocation list"
  }
  ```
- **Status**:
  - `201 Created` — Run accepted and started.
  - `409 Conflict` — Session is currently executing an active run.
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

### `POST /runs/:runId/cancel`
Cooperatively cancels an in-flight run via the agent's `AbortController`.
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
data: {"type":"run.completed","runId":"run-98a72b","output":"Refactoring complete.","ts":1727900065000}
```

---

## 5. Human-in-the-Loop Interaction Endpoints

### `POST /runs/:runId/interactions/:interactionId/resolve`
Resolves a pending human interaction (approval, clarification, or MCP input).
- **Request Body**:
  ```json
  {
    "approved": true,
    "reason": "Verified safe to execute"
  }
  ```
  Or for clarification:
  ```json
  {
    "selectedId": "opt-2"
  }
  ```
- **Status**: 200 OK (or 404 Not Found, 409 Conflict if already resolved)
- **Response**:
  ```json
  {
    "resolved": true,
    "interactionId": "appr-1892"
  }
  ```

---

## 6. Standardized Error Contract

All error responses return a structured JSON envelope:
```json
{
  "error": {
    "code": "SESSION_BUSY",
    "message": "Session \"sess-4fa9b2\" already has a run in progress",
    "requestId": "req-981240"
  }
}
```

Standard Error Codes:
- `NOT_FOUND`
- `SESSION_BUSY` (409)
- `INVALID_REQUEST` (400)
- `UNAUTHORIZED` (401)
- `SERVER_NOT_READY` (503)
- `INTERNAL_ERROR` (500)
