# Nexum local platform

Runs the full local stack: PostgreSQL (durable source of truth), Redis
(live event fan-out), the Nexum Host, and Agentic Chat — all on one
Docker network, all on your machine.

```
Browser :3400
   │
   ▼
Agentic Chat (Next.js) :3400
   │  server-side, NEXUM_HOST_URL
   ▼
Nexum Host :3777
   │
   ├── PostgreSQL :5432   (sessions, runs, execution_events — durable)
   └── Redis :6379        (nexum:run:{runId} pub/sub — live fan-out)
```

## Prerequisites

- Docker + Docker Compose
- This directory assumes `agentic-chat` is checked out as a sibling of
  `nexum` on disk (`../../../agentic-chat` relative to this file). If your
  layout differs, edit `agentic-chat.build.context` in `docker-compose.yml`.

## Usage

```bash
cd deploy/local
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD and NEXUM_WORKSPACE_ROOT at minimum

docker compose --env-file .env up
```

First run builds both images (a few minutes — `better-sqlite3` compiles
from source in the Nexum image). Postgres migrations
(`src/persistence/migrations`) run automatically when the Nexum container
starts (`src/persistence/database.ts`'s `openDatabase()`).

- Nexum Host: http://localhost:3777 (`/health`, `/capabilities`)
- Agentic Chat: http://localhost:3400
- Postgres: `localhost:5432` (user `nexum`, db `nexum`) — bound to
  `127.0.0.1` only, for local debugging (`psql`, a GUI client)
- Redis: `localhost:6379` — same, `127.0.0.1` only

## Data persistence

Named volumes (`nexum-postgres`, `nexum-redis`) survive `docker compose down`.
Use `docker compose down -v` to explicitly wipe local state (sessions, runs,
event history) during development.

## Model provider

Defaults to Ollama Cloud (`OLLAMA_API_KEY` in `.env`). To use a local Ollama
running on your host machine instead, set in `.env`:

```
OLLAMA_HOST=http://host.docker.internal:11434
```

No other change needed — `src/models/gateway/model-gateway.ts` is the only
thing that cares, and it reads this the same way whether Nexum runs in
Docker or bare.

## What's not here yet

- `nexum up` / `nexum status` / `nexum down` one-command wrappers around
  this compose file — for now, use `docker compose` directly.
- Docker sandboxing for tool execution (`docker/nexum-sandbox`) is a
  separate image, built and used independently of this stack; it isn't
  wired into `docker-compose.yml` here.
