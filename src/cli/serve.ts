/**
 * `nexum serve` — the Nexum Local Host over HTTP + SSE (see src/host).
 *
 * This is the network-transport sibling of `nexum rpc` (stdio JSON-RPC):
 * same Agent composition root, different wire. It's the entry point that
 * lets a separate process (a web app's server-side API route, a CLI in
 * "connect" mode, another agent runtime) drive this workspace's agent over
 * the Session/Run/Event API in src/protocol/types.ts.
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

export interface ServeCliOptions {
  workspaceRoot?: string;
  config?: Partial<CliConfig>;
  host?: string;
  port?: number;
}

export async function startNexumServer(opts: ServeCliOptions = {}): Promise<{ agent: Agent; stop: () => Promise<void> }> {
  const cfg = {
    ...loadConfig(),
    ...(opts.config ?? {}),
    ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
  };
  const agent = new Agent({ config: cfg });

  try {
    await agent.startHost();
  } catch (err) {
    process.stderr.write(
      `[nexum serve] plugin host start failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const host = opts.host ?? readEnv("HOST_BIND") ?? "127.0.0.1";
  const portRaw = opts.port ?? Number(readEnv("HOST_PORT") ?? "3777");
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 3777;

  const nexumHost = createNexumHost({ agent, host, port });
  const bound = await nexumHost.start();
  process.stderr.write(`Nexum host listening on http://${bound.host}:${bound.port}\n`);

  const stop = async (): Promise<void> => {
    await nexumHost.stop();
    await agent.stopHost();
  };

  return { agent, stop };
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
    } else if (arg === "--help" || arg === "-h") {
      process.stderr.write(
        `nexum serve — Nexum Local Host over HTTP + SSE\n\n` +
          `Usage:\n` +
          `  nexum serve                              Listen on 127.0.0.1:3777\n` +
          `  nexum serve --port 4000                  Custom port\n` +
          `  nexum serve --host 0.0.0.0               Bind beyond localhost (opt-in)\n` +
          `  nexum serve --workspace /path/to/repo    Explicit workspace root\n\n` +
          `Routes: see src/host/server.ts (GET /health, /capabilities, /sessions; POST /sessions,\n` +
          `/sessions/:id/runs [SSE], /runs/:id/cancel).\n`,
      );
      process.exit(0);
    }
  }

  const { stop } = await startNexumServer(opts);

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
