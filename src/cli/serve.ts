/**
 * `nexum serve` — the Nexum Local Host over HTTP + SSE (see src/host).
 *
 * This is the network-transport sibling of `nexum rpc` (stdio JSON-RPC):
 * same Agent composition root, different wire. It's the entry point that
 * lets a separate process (a web app's server-side API route, a CLI in
 * "connect" mode, another agent runtime) drive this workspace's agent over
 * the Session/Run/Event API in src/protocol/types.ts.
 *
 * PostgreSQL and Redis are first-class infrastructure for this host, not a
 * later migration (docs/plan: "PostgreSQL is the durable source of truth,
 * Redis is the real-time coordination layer") — DATABASE_URL and REDIS_URL
 * are required; there is no in-memory/SQLite fallback. Run `nexum up` (or
 * `docker compose -f deploy/local/docker-compose.yml up`) to provision
 * both locally, or point them at any reachable instance.
 *
 * Usage:
 *   nexum serve                              # listen on 127.0.0.1:3777
 *   nexum serve --port 4000                  # custom port
 *   nexum serve --host 0.0.0.0               # bind beyond localhost (opt-in)
 *   nexum serve --workspace /path/to/repo    # explicit workspace root
 *
 * Binds to 127.0.0.1 by default — this is a local dev host, not a service
 * meant to be exposed to a network. There is no auth layer yet (see
 * docs/plan): don't bind --host beyond localhost on a shared machine.
 */

import { CliConfig, loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { createNexumHost } from "../host/index.js";
import { readEnv } from "../platform/environment.js";
import { openDatabase, type NexumDatabase } from "../persistence/database.js";
import { createRedisClient } from "../infrastructure/redis/client.js";
import { RedisEventBus } from "../infrastructure/redis/pubsub.js";

export interface ServeCliOptions {
  workspaceRoot?: string;
  config?: Partial<CliConfig>;
  host?: string;
  port?: number;
  databaseUrl?: string;
  redisUrl?: string;
}

export async function startNexumServer(opts: ServeCliOptions = {}): Promise<{ stop: () => Promise<void> }> {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const redisUrl = opts.redisUrl ?? process.env.REDIS_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required — `nexum serve` needs PostgreSQL as its durable store. " +
        "Run `nexum up` (deploy/local/docker-compose.yml) or set DATABASE_URL to a reachable Postgres instance.",
    );
  }
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL is required — `nexum serve` needs Redis for live event fan-out. " +
        "Run `nexum up` (deploy/local/docker-compose.yml) or set REDIS_URL to a reachable Redis instance.",
    );
  }

  const cfg = {
    ...loadConfig(),
    ...(opts.config ?? {}),
    ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
  };
  // One Agent per active session (src/host/agent-registry.ts), all built
  // from this same host-wide config — only the loaded conversation differs.
  const createAgent = (): Agent => new Agent({ config: cfg });

  let database: NexumDatabase;
  try {
    database = await openDatabase(databaseUrl);
  } catch (err) {
    throw new Error(`failed to connect/migrate PostgreSQL at ${redactUrl(databaseUrl)}: ${describeError(err)}`, {
      cause: err,
    });
  }

  const redisPublisher = createRedisClient(redisUrl);
  const redisSubscriber = createRedisClient(redisUrl);
  const eventBus = new RedisEventBus(redisPublisher, redisSubscriber);
  try {
    await redisPublisher.ping();
  } catch (err) {
    await eventBus.close();
    await database.close();
    throw new Error(`failed to connect to Redis at ${redactUrl(redisUrl)}: ${describeError(err)}`, { cause: err });
  }

  const host = opts.host ?? readEnv("HOST_BIND") ?? "127.0.0.1";
  const portRaw = opts.port ?? Number(readEnv("HOST_PORT") ?? "3777");
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 3777;

  const nexumHost = createNexumHost({
    createAgent,
    workspaceRoot: cfg.workspaceRoot,
    db: database.db,
    eventBus,
    host,
    port,
  });
  const bound = await nexumHost.start();
  process.stderr.write(`Nexum host listening on http://${bound.host}:${bound.port}\n`);
  process.stderr.write(`  postgres: ${redactUrl(databaseUrl)}\n`);
  process.stderr.write(`  redis:    ${redactUrl(redisUrl)}\n`);

  const stop = async (): Promise<void> => {
    await nexumHost.stop(); // also tears down every session's Agent (AgentRegistry.stopAll)
    await eventBus.close();
    await database.close();
  };

  return { stop };
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(argv: string[] = process.argv.slice(3)): Promise<void> {
  const opts: ServeCliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") {
      opts.workspaceRoot = argv[++i];
    } else if (arg === "--host") {
      opts.host = argv[++i];
    } else if (arg === "--port" || arg === "-p") {
      opts.port = Number(argv[++i]);
    } else if (arg === "--database-url") {
      opts.databaseUrl = argv[++i];
    } else if (arg === "--redis-url") {
      opts.redisUrl = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      process.stderr.write(
        `nexum serve — Nexum Local Host over HTTP + SSE\n\n` +
          `Usage:\n` +
          `  nexum serve                              Listen on 127.0.0.1:3777\n` +
          `  nexum serve --port 4000                  Custom port\n` +
          `  nexum serve --host 0.0.0.0               Bind beyond localhost (opt-in)\n` +
          `  nexum serve --workspace /path/to/repo    Explicit workspace root\n\n` +
          `Requires PostgreSQL + Redis (docs/plan): set DATABASE_URL and REDIS_URL,\n` +
          `or --database-url / --redis-url, or run \`nexum up\` first.\n\n` +
          `Routes: see src/host/server.ts (GET /health, /capabilities, /sessions; POST /sessions,\n` +
          `/sessions/:id/runs [SSE], /runs/:id/cancel).\n`,
      );
      process.exit(0);
    }
  }

  let stop: () => Promise<void>;
  try {
    ({ stop } = await startNexumServer(opts));
  } catch (err) {
    process.stderr.write(`[nexum serve] ${describeError(err)}\n`);
    process.exit(1);
  }

  const cleanup = async (): Promise<void> => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());

  // Keep the process alive; the HTTP server's open handle already does this,
  // but be explicit so intent is obvious from the entry point.
  await new Promise<void>(() => {});
}
