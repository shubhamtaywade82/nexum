/**
 * `nexum session` — a thin HTTP client over a running `nexum serve` host's
 * Session/Run/Event API (src/protocol/types.ts, src/host/server.ts).
 *
 * This is the CLI half of Phase 5's acceptance test ("Unified Sessions +
 * Runs"): a session created from the Web (agentic-chat) shows up here via
 * `nexum session list`, `nexum session show <id>` renders the exact same
 * durable transcript Postgres holds, and `nexum session attach <id> "<goal>"`
 * starts a real run against that session — the Web UI sees the new run
 * live (it's subscribed to the same Redis channel), proving CLI and Web
 * are peers over one runtime rather than two agents.
 *
 * Deliberately not wired into the Ink TUI (src/ui/) yet — that's a richer,
 * separate integration. This is plain stdout, one CLI process per command,
 * matching `nexum rpc`'s "thin transport client" spirit rather than the
 * TUI's live-rendering one.
 */

import { readEnv } from "../platform/environment.js";
import type { NexumRunEvent } from "../protocol/types.js";

function baseUrl(explicit?: string): string {
  const url = explicit ?? readEnv("HOST_URL") ?? "http://127.0.0.1:3777";
  return url.replace(/\/$/, "");
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as T;
}

interface SessionRow {
  id: string;
  title: string | null;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface MessageRow {
  role: string;
  content: string;
  createdAt: string;
}

async function listSessions(url: string): Promise<void> {
  const { sessions } = await getJson<{ sessions: SessionRow[] }>(`${url}/sessions`);
  if (sessions.length === 0) {
    console.log("(no sessions yet)");
    return;
  }
  for (const s of sessions) {
    const updated = new Date(s.updatedAt).toLocaleString();
    console.log(`${s.id}  ${String(s.messageCount).padStart(3)} msgs  updated ${updated}  ${s.title ?? "(untitled)"}`);
  }
}

async function showSession(url: string, sessionId: string): Promise<void> {
  const { session, messages } = await getJson<{ session: SessionRow; messages: MessageRow[] }>(
    `${url}/sessions/${encodeURIComponent(sessionId)}`,
  );
  console.log(`Session ${session.id} — ${session.messageCount} messages — workspace ${session.workspaceRoot}\n`);
  for (const m of messages) {
    console.log(`[${m.role}] ${m.content}\n`);
  }
}

async function attachAndRun(url: string, sessionId: string, goal: string): Promise<void> {
  const res = await fetch(`${url}/sessions/${encodeURIComponent(sessionId)}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exitCode = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = raw.replace(/^data:\s*/, "").trim();
      if (!line) continue;
      let event: NexumRunEvent;
      try {
        event = JSON.parse(line) as NexumRunEvent;
      } catch {
        continue;
      }
      exitCode = renderEvent(event) || exitCode;
    }
  }

  if (exitCode) process.exitCode = exitCode;
}

/** Prints one line per event, TUI-adjacent but plain text. Returns a non-zero
 * suggested exit code for a failed/cancelled run, 0 otherwise. */
function renderEvent(event: NexumRunEvent): number {
  switch (event.type) {
    case "run.started":
      console.log(`▶ run ${event.runId} started: ${event.goal}`);
      return 0;
    case "thought":
      console.log(`  · ${event.text}`);
      return 0;
    case "tool.started":
      console.log(`  → ${event.name}(${JSON.stringify(event.args)})`);
      return 0;
    case "tool.completed":
      console.log(`  ← ${event.name}: ${JSON.stringify(event.result).slice(0, 200)}`);
      return 0;
    case "model.used":
      console.log(`  [model: ${event.tier}/${event.model}]`);
      return 0;
    case "run.completed":
      console.log(`\n✓ ${event.output}`);
      return 0;
    case "run.failed":
      console.error(`\n✗ run failed: ${event.error}`);
      return 1;
    case "run.cancelled":
      console.error(`\n⚠ run cancelled`);
      return 1;
    default:
      return 0;
  }
}

export async function main(argv: string[] = process.argv.slice(3)): Promise<void> {
  const [subcommand, ...rest] = argv;
  let url: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--url") url = rest[++i];
    else positional.push(rest[i]);
  }
  const resolvedUrl = baseUrl(url);

  try {
    switch (subcommand) {
      case "list":
        await listSessions(resolvedUrl);
        return;
      case "show": {
        const [id] = positional;
        if (!id) throw new Error("usage: nexum session show <id> [--url URL]");
        await showSession(resolvedUrl, id);
        return;
      }
      case "attach": {
        const [id, goal] = positional;
        if (!id || !goal) throw new Error('usage: nexum session attach <id> "<goal>" [--url URL]');
        await attachAndRun(resolvedUrl, id, goal);
        return;
      }
      default:
        process.stderr.write(
          `nexum session — CLI client for a running \`nexum serve\` host\n\n` +
            `Usage:\n` +
            `  nexum session list                         List sessions (Postgres-backed)\n` +
            `  nexum session show <id>                     Print a session's transcript\n` +
            `  nexum session attach <id> "<goal>"          Start a run against an existing\n` +
            `                                               session and stream its events\n\n` +
            `Options:\n` +
            `  --url URL   Nexum host base URL (default: $NEXUM_HOST_URL or http://127.0.0.1:3777)\n`,
        );
        process.exit(subcommand ? 1 : 0);
    }
  } catch (err) {
    process.stderr.write(`[nexum session] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
