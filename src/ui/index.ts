import "dotenv/config";
import path from "node:path";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import React from "react";
import { render } from "ink";
import { Agent } from "../cli/agent.js";
import { formatCapability, startupWarnings } from "../cli/capabilities.js";
import { checkSandboxImage } from "../cli/sandbox-image.js";
import { loadConfig } from "../cli/config.js";
import { EventBus } from "../runtime/events/bus.js";
import { initialRuntimeState, Store } from "../runtime/store.js";
import { detectProjectInfo } from "../runtime/project-info.js";
import { ClarificationResponse } from "../runtime/types.js";
import type { McpElicitationResponse } from "../core/user-input.js";
import { wireAgentBridge, BridgeableAgent, createRemoteAgentBridge } from "./agent-bridge.js";
import { NexumClient } from "../assistant/client/index.js";
import type { ShellAgent } from "./App.js";
import { App } from "./App.js";
import { validateAsl, generateAslGraph } from "../asl/commands.js";
import { envIs } from "../platform/environment.js";
import { workspaceStateDir } from "../platform/paths.js";
import { BRAND } from "../platform/brand.js";

/** Matches App.tsx double–Ctrl+C window; SIGINT must not restore the terminal on first press. */
const EXIT_CONFIRM_MS = 1500;

function enableTerminalFeatures(): () => void {
  if (!process.stdin.isTTY) return () => {};
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[3J\x1b[H\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h");
  let restored = false;
  const cleanup = () => {
    if (restored) return;
    restored = true;
    process.stdout.write("\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l\x1b[?25h");
  };
  // Restore the primary buffer only on process exit — not on the first SIGINT.
  // A SIGINT handler that resets the terminal before Ink/App unmount leaves the
  // TUI running in a broken screen while Ctrl+C appears to do nothing.
  process.once("exit", cleanup);
  return cleanup;
}

function registerForceQuitHandlers(unmount: () => void, restoreTerminal: () => void): void {
  if (!process.stdin.isTTY) return;
  let lastSigintAt = 0;
  process.on("SIGINT", () => {
    const now = Date.now();
    if (now - lastSigintAt < EXIT_CONFIRM_MS) {
      unmount();
      restoreTerminal();
      process.exit(130);
    }
    lastSigintAt = now;
  });
  process.on("SIGTERM", () => {
    unmount();
    restoreTerminal();
    process.exit(143);
  });
}

function currentBranch(workspaceRoot: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// Debug-only: dump every raw stdin chunk (as JSON-escaped text) to
// .nexum/paste-debug.log when NEXUM_DEBUG_STDIN=1, registered before
// anything else touches stdin so it sees genuinely raw terminal bytes.
// Kept as a standing diagnostic — terminals disagree wildly on how they
// encode paste/line-break bytes (see App.tsx's \r-vs-\n handling), and this
// is the fastest way to root-cause the next one.
if (envIs("DEBUG_STDIN", "1") && process.stdin.isTTY) {
  const debugDir = workspaceStateDir(process.cwd());
  mkdirSync(debugDir, { recursive: true });
  const logPath = path.join(debugDir, "paste-debug.log");
  process.stdin.prependListener("data", (data: Buffer) => {
    appendFileSync(logPath, `${new Date().toISOString()} len=${data.length} ${JSON.stringify(data.toString())}\n`);
  });
}

const cfg = loadConfig();

(async () => {
  const args = process.argv.slice(2);
  let initialTask: string | undefined;
  if (args[0] === "asl") {
    const cmd = args[1];
    if (cmd === "validate") {
      const ok = await validateAsl(cfg.workspaceRoot);
      process.exit(ok ? 0 : 1);
    } else if (cmd === "graph") {
      await generateAslGraph(cfg.workspaceRoot);
      process.exit(0);
    } else {
      console.error(`Unknown ASL command: ${cmd}`);
      console.error("Usage: nexum asl [validate|graph]");
      process.exit(1);
    }
  } else if (args[0] === "fix") {
    const rest = args.slice(1).join(" ").trim();
    initialTask = rest ? `Fix issue: ${rest}` : "Find and fix failing tests or diagnostics";
  } else if (args[0] === "issue" || args[0] === "--issue") {
    const issueNum = args[1]?.replace(/^#/, "");
    initialTask = issueNum
      ? `Investigate GitHub issue #${issueNum}, reproduce and fix the failure, run verification, and prepare a PR.`
      : "Inspect and resolve open GitHub issue";
  } else if (args.length > 0 && !args[0].startsWith("-")) {
    initialTask = args.join(" ").trim();
  }

  const bus = new EventBus();
  const store = new Store(
    initialRuntimeState({
      workspace: path.basename(cfg.workspaceRoot),
      branch: currentBranch(cfg.workspaceRoot),
      model: cfg.model,
      provider: cfg.tier,
      pricing: cfg.pricing,
      theme: cfg.theme,
    }),
  );
  store.attach(bus);
  const detectedProject = detectProjectInfo(cfg.workspaceRoot);
  bus.publish({ type: "project.detected", info: detectedProject });
  let sandboxProbe: Promise<boolean | undefined> = Promise.resolve(undefined);
  if (cfg.sandbox === false) {
    bus.publish({ type: "sandbox.detected", available: false, enabled: false });
  } else {
    const probe = checkSandboxImage(cfg.shellImage ?? BRAND.sandboxImage);
    probe.then((available) => bus.publish({ type: "sandbox.detected", available, enabled: true }));
    sandboxProbe = probe;
  }

  function buildLocalShellAgent(agent: Agent): ShellAgent {
    return {
      runUserMessage: (message: string) => agent.runUserMessage(message),
      setModel: (model: string) => agent.setModel(model),
      setTier: (tier: "local" | "cloud") => agent.setTier(tier),
      resetContext: () => agent.resetContext(),
      resumeSession: () => agent.resumeSession(),
      resumeSessionById: (id: string) => agent.resumeSessionById(id),
      hasResumableSession: () => agent.hasResumableSession(),
      listSessions: () => agent.listSessions(),
      getTools: () =>
        agent
          .getRegistry()
          .getTools()
          .map((t) => ({ name: t.name, description: t.description, category: agent.getRegistry().categoryOf(t.name) })),
      listModels: () => agent.listModels(),
      modelAvailability: (models: string[]) => agent.modelAvailability(models),
      modelCapabilities: (models: string[]) => agent.modelCapabilities(models),
      runPlan: (goal: string) => agent.runPlan(goal),
      hasResumablePlan: () => agent.hasResumablePlan(),
      getCapabilities: () => agent.getCapabilities(),
      buildSandboxImage: () => agent.buildSandboxImage(),
      resolveApproval: (id: string, approved: boolean) => agent.resolveApproval(id, approved),
      resolveClarification: (resp: ClarificationResponse) => agent.resolveClarification(resp),
      resolveMcpElicitation: (resp: McpElicitationResponse) => agent.resolveMcpElicitation(resp),
      validateModel: () => agent.validateModel(),
      getSkillsRegistry: () => agent.getSkillsRegistry(),
      pinSkill: (id: string | null) => agent.pinSkill(id),
      usage: (range?: "24h" | "7d" | "30d") => agent.usage(range),
      balance: () => agent.balance(),
      importGguf: (model: string, path: string) => agent.importGguf(model, path),
    };
  }

  const serverIndex = args.indexOf("--server");
  const serverUrl =
    process.env.NEXUM_SERVER_URL ||
    (serverIndex !== -1
      ? args[serverIndex + 1]?.startsWith("-")
        ? "http://127.0.0.1:3777"
        : (args[serverIndex + 1] ?? "http://127.0.0.1:3777")
      : undefined);

  let shellAgent: ShellAgent;
  let agent: Agent | undefined;

  if (serverUrl) {
    const client = new NexumClient({ baseUrl: serverUrl });
    shellAgent = createRemoteAgentBridge(client, bus);
    bus.publish({
      type: "logs.appended",
      level: "info",
      source: "server",
      message: `Connected to remote Nexum Server at ${client.baseUrl}`,
    });
  } else {
    agent = new Agent({ config: cfg });
    sandboxProbe
      .then((ready) => agent!.getCapabilities(ready))
      .then((caps) => {
        for (const c of startupWarnings(caps)) {
          bus.publish({ type: "logs.appended", level: "warn", source: "capabilities", message: formatCapability(c) });
        }
      })
      .catch(() => {});
    try {
      await agent.startHost();
    } catch (err) {
      bus.publish({
        type: "logs.appended",
        level: "warn",
        source: "plugins",
        message: `plugin host start failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    agent.setProjectInfo(detectedProject);
    wireAgentBridge(agent as unknown as BridgeableAgent, bus, { workspaceRoot: agent.workspaceRoot });
    agent
      .connectConfiguredMcpServers()
      .then((servers) => bus.publish({ type: "mcp.changed", servers }))
      .catch((e) => bus.publish({ type: "logs.appended", level: "error", source: "mcp", message: String(e) }));
    shellAgent = buildLocalShellAgent(agent);
  }

  const disableFeatures = enableTerminalFeatures();
  const instance = render(
    React.createElement(App, { bus, store, agent: shellAgent, workspaceRoot: cfg.workspaceRoot, initialTask }),
    { exitOnCtrlC: false },
  );
  registerForceQuitHandlers(() => instance.unmount(), disableFeatures);
  await instance.waitUntilExit();
  disableFeatures();
  if (agent) {
    try {
      await agent.stopHost();
    } catch {
      // best-effort — process is exiting anyway
    }
  }
  process.exit(0);
})();
