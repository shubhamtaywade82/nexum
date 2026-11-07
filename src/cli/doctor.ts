import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { LspManager } from "../lsp/manager.js";
import type { LspServerState } from "../lsp/protocol.js";
import { activeLegacyEnvVariables } from "../platform/environment.js";
import { WorkspaceManager } from "../platform/workspace.js";
import { BRAND } from "../platform/brand.js";
import { discoverWorkspace } from "../domains/rails/index.js";
import { collectCapabilities, formatCapability } from "./capabilities.js";
import { Provider } from "../models/adapters/provider.js";
import { ModelCatalog } from "../models/catalog.js";
import { DEFAULT_CURATED_PREFERENCES } from "../models/catalog-data.js";

export type DoctorReport = {
  ok: boolean;
  lines: string[];
};

function checkNode(lines: string[]): void {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  const ok = major >= 22;
  lines.push(`node: v${process.versions.node} (${ok ? "ok" : "unsupported — requires >= 22"})`);
}

function checkDocker(lines: string[], image: string): void {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 2500 });
    lines.push(`docker: daemon ok (sandbox: ${image})`);
  } catch {
    lines.push(`docker: not running or not found (sandboxed execution unavailable)`);
  }
}

function checkGitHub(lines: string[]): void {
  try {
    execSync("gh auth status", { stdio: ["ignore", "pipe", "pipe"], timeout: 2500 });
    lines.push("github: gh CLI authenticated");
  } catch {
    try {
      execSync("gh --version", { stdio: "ignore", timeout: 1000 });
      lines.push("github: gh CLI installed (not authenticated — run `gh auth login`)");
    } catch {
      lines.push("github: gh CLI not found on PATH");
    }
  }
}

function checkLsp(lines: string[], root: string): void {
  try {
    const lsp = new LspManager({ workspaceRoot: root });
    const providers = lsp.registry.allProviders();
    const activeStates: LspServerState[] = lsp.getServerStates();
    lines.push(`lsp: ${providers.length} configured language providers`);
    for (const p of providers.slice(0, 5)) {
      lines.push(`  - ${p.id} (${p.language}) -> ${p.serverCommand}`);
    }
    if (activeStates.length > 0) {
      lines.push(`lsp active sessions: ${activeStates.length}`);
      for (const s of activeStates) lines.push(`  - ${s.language}: ${s.status}`);
    }
  } catch (err) {
    lines.push(`lsp: check failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function checkCapabilities(lines: string[], config: ReturnType<typeof loadConfig>): Promise<void> {
  try {
    const lsp = new LspManager({ workspaceRoot: config.workspaceRoot });
    const caps = await collectCapabilities({
      workspaceRoot: config.workspaceRoot,
      sandbox: {
        enabled: config.sandbox !== false,
        image: config.shellImage ?? BRAND.sandboxImage,
        imageReady: undefined,
      },
      railsIndexEnabled: discoverWorkspace(config.workspaceRoot).isRails,
      lspProviders: lsp.registry.allProviders(),
      docsCached: [],
      mcpServersConfigured: (config.mcpServers ?? []).length,
      localWorkerEnabled: !!config.enableLocalWorker,
      dockerToolEnabled: !!config.dockerTool,
    });
    lines.push("capabilities (relevant to this workspace):");
    // Sandbox and docs state come from the daemon / store, which doctor reports separately above.
    for (const c of caps.filter((c) => c.id !== "sandbox" && c.id !== "docs")) lines.push(`  - ${formatCapability(c)}`);
  } catch (err) {
    lines.push(`capabilities: check failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * quickModel diagnostic. A hardcoded default would be wrong — it would
 * demand a model download the user never asked for, and a missing model
 * means a failed round-trip before every fallback. Instead, doctor makes
 * the hybrid fast path DISCOVERABLE: when a curated quick model is already
 * installed locally, it names it and the one-line config that activates it
 * (which, since the verifier graduation, also turns the critic pass on).
 */
async function checkQuickModel(lines: string[], config: ReturnType<typeof loadConfig>): Promise<void> {
  if (config.quickModel) {
    lines.push(`quickModel: ${config.quickModel} (verifier: ${config.enableVerifier ? "on" : "off"})`);
    return;
  }
  try {
    const local = new Provider({
      tier: "local",
      model: config.model,
      host: config.tier === "local" ? config.host : undefined,
    });
    const catalog = new ModelCatalog(local, undefined);
    const installed = await catalog.refresh();
    const quickPrefs = DEFAULT_CURATED_PREFERENCES.quick ?? [];
    const found = quickPrefs
      .map((pref) => installed.find((m) => m.tier === "local" && m.name.toLowerCase().includes(pref.toLowerCase())))
      .find(Boolean);
    if (found) {
      lines.push(
        `quickModel: unset — ${found.name} is installed; set quickModel (or NEXUM_QUICK_MODEL) to "${found.name}" to activate the hybrid fast path and the verifier default`,
      );
    } else {
      lines.push(
        `quickModel: unset (hybrid fast path falls back to ${config.model}; pull a small model, e.g. \`ollama pull ${quickPrefs[0]}\`, then set quickModel to enable it)`,
      );
    }
  } catch {
    lines.push(`quickModel: unset (local catalog unreachable — hybrid fast path falls back to ${config.model})`);
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const lines: string[] = [];
  const config = loadConfig();

  checkNode(lines);
  lines.push(`workspaceRoot: ${config.workspaceRoot}`);
  lines.push(`model: ${config.model} (tier: ${config.tier})`);
  lines.push(`host: ${config.host ?? "http://localhost:11434"}`);
  lines.push(`apiKeysCount: ${(config.apiKeys || []).length}`);
  await checkQuickModel(lines, config);

  const ws = new WorkspaceManager(config.workspaceRoot);
  const detection = ws.detect();
  lines.push(`workspaceState: ${ws.dir}${detection.hasCurrent ? "" : " (uninitialized)"}`);
  if (detection.hasLegacy) {
    lines.push(`legacyState: ${ws.legacyDir} present (run \`nexum migrate\`)`);
  }
  const legacyEnv = activeLegacyEnvVariables();
  if (legacyEnv.length > 0) {
    lines.push(`legacyEnv: ${legacyEnv.length} deprecated DEVAGENT_* variable(s)`);
  }

  checkDocker(lines, config.shellImage ?? BRAND.sandboxImage);
  checkGitHub(lines);
  checkLsp(lines, config.workspaceRoot);
  await checkCapabilities(lines, config);

  return { ok: true, lines };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  runDoctor().then((r) => {
    console.log(`=== ${BRAND.name} Doctor ===`);
    console.log(r.lines.join("\n"));
  });
}
