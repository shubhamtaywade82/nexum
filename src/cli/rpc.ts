/**
 * `nexum rpc` — newline-delimited JSON-RPC 2.0 agent server over stdio.
 *
 * This is the host-side counterpart to ProcessSubagentProvider: an external
 * client (a parent Nexum process, an IDE plugin, a CI runner, another agent
 * runtime) spawns `nexum rpc` and drives the local agent through JSON-RPC
 * method calls.
 *
 * The server:
 *   1. Constructs an Agent (with the standard config + plugin profile)
 *   2. Calls agent.startHost() to mount plugins + start the control plane
 *   3. Registers all RPC method handlers via registerAllServiceMethods()
 *   4. Reads newline-delimited JSON-RPC requests from stdin, dispatches
 *      them to the registered handlers, and writes responses to stdout
 *   5. On EOF / SIGINT, calls agent.stopHost() and exits cleanly
 *
 * Available methods (registered in src/rpc/index.ts):
 *   plugins.list           — list mounted plugins
 *   agent.execute          — run a user message through the agent
 *   jobs.*                 — submit/status/output/cancel/kill/list/counts
 *   subagents.*            — spawn/inspect/list/cancel
 *   workflows.*            — register/createInstance/start/pause/cancel/
 *                            resume/get/list/events
 *   webhooks.*             — registerEndpoint/listEndpoints/addRule/receive/
 *                            listEvents/counts
 *   control.*              — status/health/metrics/control/phase
 *
 * Usage:
 *   nexum rpc                              # stdio JSON-RPC server
 *   nexum rpc --workspace /path/to/repo    # explicit workspace root
 *
 * Wire protocol (one JSON object per line):
 *   client → server:  {"jsonrpc":"2.0","id":1,"method":"agent.execute","params":{"goal":"..."}}
 *   server → client:  {"jsonrpc":"2.0","id":1,"result":{"status":"completed","output":"..."}}
 */

import { CliConfig, loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import {
  RpcServer,
  registerAllServiceMethods,
  type RpcServerOptions,
} from "../rpc/index.js";

export interface RpcCliOptions {
  /** Override the workspace root (default: loadConfig().workspaceRoot). */
  workspaceRoot?: string;
  /** Override config (default: loadConfig()). */
  config?: Partial<CliConfig>;
  /** Custom RpcServer options (for tests). Default: stdin/stdout. */
  rpcOptions?: Partial<RpcServerOptions>;
}

/**
 * Start the JSON-RPC agent server. Blocks until EOF on stdin or SIGINT.
 * Returns the Agent instance so callers (tests) can interact with it
 * after the server stops.
 */
export async function startRpcServer(opts: RpcCliOptions = {}): Promise<Agent> {
  const cfg = { ...loadConfig(), ...(opts.config ?? {}), ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}) };
  const agent = new Agent({ config: cfg });

  // Start the plugin host + control plane.
  try {
    await agent.startHost();
  } catch (err) {
    // Failure here is non-fatal: the agent still works with the kernel
    // service plane; plugins just won't be active. Log to stderr so
    // stdout JSON-RPC stream stays clean.
    process.stderr.write(
      `[nexum rpc] plugin host start failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Register the agent.execute method (the primary method external clients call).
  // This is the bridge between JSON-RPC and the agent's runUserMessage().
  // We register it on the RpcServer before registerAllServiceMethods so the
  // latter doesn't overwrite it.
  const rpcServer = new RpcServer({
    input: opts.rpcOptions?.input ?? process.stdin,
    output: opts.rpcOptions?.output ?? process.stdout,
    autostart: false,
  });

  rpcServer.method("agent.execute", async (params) => {
    const p = params as { goal?: string; maxToolTurns?: number } | undefined;
    if (!p || typeof p.goal !== "string") {
      throw new Error("agent.execute requires { goal: string }");
    }
    try {
      const output = await agent.runUserMessage(p.goal);
      return {
        status: "completed" as const,
        output,
        metadata: { agent: "devagent" },
      };
    } catch (err) {
      return {
        status: "failed" as const,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  rpcServer.method("agent.cancel", () => {
    // Cancel any in-flight agent execution. Today, agent.runUserMessage is
    // synchronous from the caller's perspective; future versions will add
    // a cancellation registry. For now, this is a no-op ack.
    return { cancelled: true };
  });

  // Register the rest of the service-exposing methods (jobs, subagents,
  // workflows, webhooks, control plane, plugins.list).
  // registerAllServiceMethods already calls registerCoreMethods for
  // plugins.list — we add agent.list here directly to avoid duplicating
  // the plugins.list registration.
  rpcServer.method("agent.list", () => {
    return agent.runtime.agents.ids();
  });
  registerAllServiceMethods(rpcServer, {
    jobs: agent.jobs,
    subagents: agent.subagents,
    workflows: agent.workflows,
    webhooks: agent.webhooks,
    controlPlane: agent.controlPlane,
    pluginHost: agent.pluginHost,
  });

  // Start the RPC server (begins reading from stdin).
  rpcServer.start();

  // On EOF or SIGINT, drain services and exit cleanly.
  const cleanup = async (): Promise<void> => {
    try {
      await agent.stopHost();
    } catch {
      // best-effort
    }
    rpcServer.stop();
  };

  process.stdin.on("end", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });

  return agent;
}

/**
 * CLI entry point: parse argv and start the server.
 * Exported so bin/cli.js can call it via `await import('../dist/cli/rpc.js')`.
 */
export async function main(argv: string[] = process.argv.slice(3)): Promise<void> {
  // Parse simple flags. We don't use a full flag parser here to keep the
  // dependency surface minimal — `nexum rpc` is a server, not a complex CLI.
  const opts: RpcCliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") {
      opts.workspaceRoot = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      process.stderr.write(
        `nexum rpc — newline-delimited JSON-RPC 2.0 agent server over stdio\n\n` +
          `Usage:\n` +
          `  nexum rpc                              Start the JSON-RPC server\n` +
          `  nexum rpc --workspace /path/to/repo    Explicit workspace root\n\n` +
          `Methods:\n` +
          `  agent.execute, agent.cancel\n` +
          `  plugins.list, jobs.*, subagents.*, workflows.*, webhooks.*, control.*\n` +
          `  (see src/rpc/index.ts for the full list)\n`,
      );
      process.exit(0);
    }
  }

  await startRpcServer(opts);
}
