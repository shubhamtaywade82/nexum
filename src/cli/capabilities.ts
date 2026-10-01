import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { detectWorkspaceDocSources, detectWorkspaceKinds } from "../docs/workspace-detect.js";

/**
 * active    — running / usable right now
 * available — registered and starts on demand (lazy), prerequisites present
 * degraded  — registered but a prerequisite is missing; `fix` says how to repair it
 * off       — deliberately disabled by configuration
 */
export type CapabilityState = "active" | "available" | "degraded" | "off";

export interface FeatureStatus {
  id: string;
  label: string;
  state: CapabilityState;
  detail: string;
  fix?: string;
}

export interface LspProviderInfo {
  language: string;
  serverCommand: string;
}

export interface CapabilityInputs {
  workspaceRoot: string;
  sandbox: { enabled: boolean; image: string; imageReady: boolean | undefined };
  railsIndexEnabled: boolean;
  lspProviders: LspProviderInfo[];
  /** Cached DevDocs slugs. */
  docsCached: string[];
  mcpServersConfigured: number;
  localWorkerEnabled: boolean;
  dockerToolEnabled: boolean;
  /** Injected for tests; defaults probe PATH / the filesystem. */
  commandExists?: (command: string) => boolean;
  chromiumInstalled?: () => boolean;
  githubRemote?: (root: string) => boolean;
}

/** Workspace kind (from detectWorkspaceKinds) -> LSP provider language it needs. */
const KIND_TO_LSP_LANGUAGE: Record<string, string> = {
  rails: "Ruby",
  ruby: "Ruby",
  typescript: "TypeScript",
  node: "TypeScript",
  react: "TypeScript",
  vue: "TypeScript",
  nextjs: "TypeScript",
  svelte: "TypeScript",
  angular: "TypeScript",
  express: "TypeScript",
  deno: "TypeScript",
  python: "Python",
  django: "Python",
  fastapi: "Python",
  flask: "Python",
  go: "Go",
  rust: "Rust",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  cpp: "C++",
  c: "C++",
  php: "PHP",
  laravel: "PHP",
  symfony: "PHP",
  swift: "Swift",
  dart: "Dart",
};

export function commandOnPath(command: string, pathVar: string | undefined = process.env.PATH): boolean {
  if (!command) return false;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, command + ext), constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

function hasGithubRemote(root: string): boolean {
  try {
    return /github\.com/.test(readFileSync(join(root, ".git", "config"), "utf8"));
  } catch {
    return false;
  }
}

async function chromiumPresent(): Promise<boolean> {
  try {
    const { resolveChromiumExecutablePath } = await import("../browser/manager.js");
    const override = resolveChromiumExecutablePath();
    if (override) return existsSync(override);
    const { chromium } = await import("playwright");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/**
 * Cheap, offline snapshot of which features work and which are degraded.
 * Only features relevant to this workspace are reported: LSP servers for the
 * languages actually detected, Rails only for a Rails app, GitHub only when
 * the repo has a github.com remote. Nothing here starts a server, spawns a
 * browser or touches the network.
 */
export async function collectCapabilities(input: CapabilityInputs): Promise<FeatureStatus[]> {
  const exists = input.commandExists ?? ((c: string) => commandOnPath(c));
  const caps: FeatureStatus[] = [];

  // Sandbox
  if (!input.sandbox.enabled) {
    caps.push({
      id: "sandbox",
      label: "Docker sandbox",
      state: "off",
      detail: "sandbox disabled: shell commands run on the host and each call needs confirmation",
    });
  } else if (input.sandbox.imageReady === false) {
    caps.push({
      id: "sandbox",
      label: "Docker sandbox",
      state: "degraded",
      detail: `shell/test/lint tools cannot run: Docker or image ${input.sandbox.image} is unavailable`,
      fix: "docker build -t nexum-sandbox:latest docker/nexum-sandbox/",
    });
  } else {
    caps.push({
      id: "sandbox",
      label: "Docker sandbox",
      state: input.sandbox.imageReady ? "active" : "available",
      detail: input.sandbox.imageReady ? `image ${input.sandbox.image} ready` : "image check pending",
    });
  }

  // LSP: only the languages this workspace uses
  const kinds = detectWorkspaceKinds(input.workspaceRoot);
  const wanted = new Set(kinds.map((k) => KIND_TO_LSP_LANGUAGE[k]).filter((l): l is string => !!l));
  for (const provider of input.lspProviders) {
    if (!wanted.has(provider.language)) continue;
    const installed = exists(provider.serverCommand);
    caps.push({
      id: `lsp:${provider.language}`,
      label: `${provider.language} language server`,
      state: installed ? "available" : "degraded",
      detail: installed
        ? `${provider.serverCommand} found; starts on first use`
        : `${provider.serverCommand} not found; code intelligence falls back to text search`,
      ...(installed ? {} : { fix: `install ${provider.serverCommand} and put it on PATH` }),
    });
  }

  if (input.railsIndexEnabled) {
    caps.push({
      id: "rails",
      label: "Rails semantic index",
      state: "active",
      detail: "Rails workspace detected; index builds in the background and updates on file writes",
    });
  }

  // Docs: report scoping, not everything in the catalog
  const docIds = detectWorkspaceDocSources(input.workspaceRoot);
  caps.push({
    id: "docs",
    label: "Documentation search",
    state: "available",
    detail:
      docIds.length > 0
        ? `${input.docsCached.length} source(s) cached; downloads only what a query needs from: ${docIds.join(", ")}`
        : `${input.docsCached.length} source(s) cached; no framework detected, searches the cache only`,
  });

  if (hasGithubRemoteFor(input)) {
    const hasGh = exists("gh");
    caps.push({
      id: "github",
      label: "GitHub tool",
      state: hasGh ? "available" : "degraded",
      detail: hasGh ? "gh CLI found; every call asks for confirmation" : "gh CLI not found on PATH",
      ...(hasGh ? {} : { fix: "install the GitHub CLI and run `gh auth login`" }),
    });
  }

  const chromium = await (input.chromiumInstalled ?? chromiumPresent)();
  caps.push({
    id: "browser",
    label: "Browser automation",
    state: chromium ? "available" : "degraded",
    detail: chromium ? "launches lazily on first browser_* call" : "Chromium not installed; browser_* tools will fail",
    ...(chromium ? {} : { fix: "npx playwright install chromium" }),
  });

  caps.push({
    id: "mcp",
    label: "MCP servers",
    state: input.mcpServersConfigured > 0 ? "available" : "off",
    detail:
      input.mcpServersConfigured > 0
        ? `${input.mcpServersConfigured} configured, subject to workspace trust`
        : "none configured",
  });

  caps.push({
    id: "local-worker",
    label: "Local worker/verifier",
    state: input.localWorkerEnabled ? "active" : "off",
    detail: input.localWorkerEnabled ? "enabled" : "disabled (enableLocalWorker)",
  });

  caps.push({
    id: "docker-tool",
    label: "Docker tool",
    state: input.dockerToolEnabled ? "active" : "off",
    detail: input.dockerToolEnabled
      ? "enabled (root-equivalent host access)"
      : "opt-in: dockerTool / NEXUM_DOCKER_TOOL=1",
  });

  return caps;
}

function hasGithubRemoteFor(input: CapabilityInputs): boolean {
  return (input.githubRemote ?? hasGithubRemote)(input.workspaceRoot);
}

/** Capabilities a user should hear about at startup: something registered but broken. */
export function startupWarnings(caps: FeatureStatus[]): FeatureStatus[] {
  // Browser is only needed for browser tasks, so its absence is shown on request, not at every launch.
  return caps.filter((c) => c.state === "degraded" && c.id !== "browser");
}

export function formatCapability(c: FeatureStatus): string {
  return `${c.label}: ${c.state} — ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ""}`;
}
