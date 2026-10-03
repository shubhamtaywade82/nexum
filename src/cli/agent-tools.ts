import { Registry } from "../tools/registry.js";
import { Tool } from "../tools/tool.js";
import { connectMcpServer } from "../mcp/client.js";
import { connectMcpServerTools, type McpServerToolsOptions } from "../mcp/adapter/mcp-server-tools.js";
import type { McpToolAdapter } from "../mcp/adapter/mcp-tool-adapter.js";
import type { LocalWorker } from "../models/local-worker.js";
import type { ClarificationRequester } from "../tools/ask-user-tool.js";
import type { LspManager } from "../lsp/manager.js";
import type { BrowserManager } from "../browser/manager.js";
import type { BinanceStreamManager } from "../domains/trading/binance-stream.js";
import type { SemanticIndex } from "../domains/rails/index.js";
import type { DocsStore } from "../docs/store.js";
import type { ToolResult } from "../core/tools/tool-contract.js";
import { DefaultToolGateway } from "../tools/gateway/tool-gateway.js";
import { ToolCatalog } from "../tools/gateway/tool-catalog.js";
import { mountToolPack, ToolPack } from "../tools/gateway/tool-pack.js";
import { parityPosture } from "../core/policy/postures.js";
import {
  agentCorePack,
  browserPack,
  databasePack,
  generalPack,
  dockerPack,
  docsPack,
  filesystemPack,
  gitPack,
  githubPack,
  lspPack,
  memoryPack,
  projectPack,
  railsPack,
  ragPack,
  rubyPack,
  searchPack,
  shellPack,
  tradingPack,
} from "../tools/packs/index.js";
import { createWorkspaceSemanticMemory } from "../memory/semantic/semantic-memory.js";
import type { SemanticMemory } from "../memory/semantic/semantic-memory.js";
import { createWorkspaceRagService } from "../rag/workspace.js";
import type { RagService } from "../rag/rag-service.js";
import { readEnv } from "../platform/environment.js";
import { workspaceStateDir } from "../platform/paths.js";
import { join } from "node:path";
import { WorkspaceGuard, type WorkspaceGuardOptions } from "../core/fs/workspace-guard.js";
import { ShellTool } from "../tools/shell.js";

export type ToolOnOutput = (stream: "stdout" | "stderr", chunk: string) => void;

export type McpRegistrationOptions = McpServerToolsOptions;

/**
 * Tool ownership and registration.
 *
 * Refactored around kernel ToolPacks: every register* method now builds a
 * pack and mounts it into BOTH the legacy Registry (the CLI Agent's
 * execution path during migration) and the kernel ToolCatalog (metadata +
 * ToolGateway enforcement for kernel-native runs). Tool definitions and
 * their risk/side-effect metadata live with the domain packs
 * (src/tools/packs/); this class is becoming a thin composition root.
 */
export class AgentToolManager {
  readonly registry = new Registry();
  /** Kernel-side catalog mirroring the legacy registry (ToolDefinitions). */
  readonly kernelCatalog = new ToolCatalog();
  /**
   * Gateway for kernel-native tool invocation. Since the enforcement flip
   * this runs the parity posture (RulePolicyEngine): destructive shell,
   * git push / PR creation, file deletion, and financial tools require a
   * resolved confirmation — surfaced as a structured ConfirmationRequired
   * outcome that the strategy's resolveConfirmation hook resolves through
   * the ApprovalBroker. Schema validation is strict: malformed tool
   * arguments fail as structured ValidationError observations (after the
   * weak-model repair pass) instead of reaching tool code.
   */
  readonly gateway: DefaultToolGateway;
  /** Packs mounted this session, by id (observability / capability scoping). */
  readonly mountedPacks = new Map<string, ToolPack>();
  /** Lazily-created workspace semantic memory (see registerIntelligenceTools). */
  semanticMemory?: SemanticMemory;
  /** Lazily-created workspace RAG service (see registerIntelligenceTools). */
  ragService?: RagService;

  constructor() {
    this.gateway = new DefaultToolGateway({
      catalog: this.kernelCatalog,
      policyEngine: parityPosture(),
      validation: "strict",
      label: "tool-gateway",
    });
  }

  /**
   * Mount a pack: kernel catalog (definitions + handlers) and legacy
   * registry (execution parity). Later packs win on name collisions, both
   * sides — matching the legacy register() overwrite semantics.
   */
  registerToolPack(pack: ToolPack): void {
    this.mountedPacks.set(pack.id, pack);
    mountToolPack(pack, this.kernelCatalog);
    for (const entry of pack.entries) {
      this.registry.register(entry.tool, entry.category ?? "General");
    }
  }

  registerBaseTools(
    root: string,
    onOutput?: ToolOnOutput,
    shellOpts?: { sandbox?: boolean; image?: string; timeoutSec?: number },
    fsOpts?: Omit<WorkspaceGuardOptions, "root">,
    opts: { dockerTool?: boolean; dockerEgress?: boolean } = {},
  ): void {
    // One filesystem boundary for every file-touching pack.
    const guard = new WorkspaceGuard({ root, protectSensitiveReads: true, ...fsOpts });
    const writeScope = fsOpts?.writeScope;
    this.registerToolPack(filesystemPack(guard));
    this.registerToolPack(shellPack(root, onOutput, { ...shellOpts, writeScope }));
    this.registerToolPack(searchPack(guard));
    this.registerToolPack(gitPack(root));
    this.registerToolPack(githubPack(root));
    // Project scripts and bundle are code the agent can edit: run them in the same sandbox as run_shell.
    const runner = new ShellTool({ workspaceRoot: root, ...shellOpts, writeScope });
    this.registerToolPack(projectPack(root, runner));
    this.registerToolPack(rubyPack(root, runner));
    // Docker daemon access is root-equivalent on the host: opt-in only.
    if (opts.dockerTool) this.registerToolPack(dockerPack(root, { egress: opts.dockerEgress ?? false }));
    this.registerToolPack(databasePack(guard));
    this.registerToolPack(generalPack());
    // Default-on intelligence layer (semantic memory; RAG joins in the same
    // seam): every product agent gets durable semantic memory unless the
    // operator opts out via NEXUM_SEMANTIC_MEMORY=0.
    this.registerIntelligenceTools(root);
  }

  /**
   * Mount the intelligence plane (semantic memory + hybrid RAG) onto this
   * agent. Default-on via registerBaseTools; safe to call directly for
   * agents that mount custom tool sets. Degrades silently (no tools) when
   * the workspace database cannot be opened.
   */
  registerIntelligenceTools(root: string): void {
    if (readEnv("SEMANTIC_MEMORY") === "0") return;
    try {
      const memory = (this.semanticMemory ??= createWorkspaceSemanticMemory(root));
      if (!this.mountedPacks.has("memory")) this.registerToolPack(memoryPack(memory));
    } catch {
      // Unwritable workspace — run without semantic memory tools rather
      // than breaking tool registration entirely.
      return;
    }
    try {
      const rag = (this.ragService ??= createWorkspaceRagService({
        dbPath: join(workspaceStateDir(root), "memory.db"),
      }));
      if (!this.mountedPacks.has("rag")) this.registerToolPack(ragPack(rag));
    } catch {
      // RAG is additive — semantic memory still works without it.
    }
  }

  registerHybridTools(localWorker: LocalWorker | undefined): void {
    this.registerToolPack(agentCorePack({ localWorker }));
  }

  registerClarificationTool(requester: ClarificationRequester): void {
    this.registerToolPack(agentCorePack({ requester }));
  }

  registerBinanceStreamTools(stream: BinanceStreamManager): void {
    this.registerToolPack(tradingPack({ stream }));
  }

  /** Trading domain pack (canonical name — review item 21). */
  registerTradingTools(stream: BinanceStreamManager): void {
    this.registerToolPack(tradingPack({ stream }));
  }

  registerLspTools(lsp: LspManager): void {
    this.registerToolPack(lspPack(lsp));
  }

  registerBrowserTools(browser: BrowserManager): void {
    this.registerToolPack(browserPack(browser));
  }

  registerRailsTools(rails: SemanticIndex): void {
    this.registerToolPack(railsPack(rails));
  }

  registerDocsTools(store: DocsStore, workspaceRoot: string): void {
    this.registerToolPack(docsPack(store, workspaceRoot));
  }

  registerTool(tool: Tool, category = "General"): void {
    this.registry.register(tool, category);
    this.kernelCatalog.registerLegacy(tool, category);
  }

  /** Options for MCP registration with trust gating (P2 trust tier).
   * Without opts the connect-freely legacy path is used unchanged. */
  async registerMcpServer(command: string, args: string[] = [], opts: McpRegistrationOptions = {}): Promise<Tool[]> {
    if (!opts.trust && !opts.security && !opts.elicitation) {
      // Legacy path — no policy, no overrides, and no protocol callbacks; behavior identical to before.
      const tools = await connectMcpServer(command, args);
      for (const tool of tools) this.registerTool(tool, "MCP");
      return tools;
    }

    const { tools } = await connectMcpServerTools(command, args, opts);
    return this.registerMcpTools(tools).registered;
  }

  /**
   * Registers MCP tools, skipping any whose name is already taken. MCP tools keep the names their
   * server gave them, and registration overwrites by name, so without this a server exposing
   * `read_file` or `run_shell` would silently replace the built-in tool, its workspace guard and
   * its policy metadata.
   *
   * Each adapter's own security metadata (risk from the server's read-only / destructive hints,
   * confirmation, timeout, side effects) is what the gateway enforces. The generic "MCP" category
   * defaults would register every MCP tool, destructive ones included, as read-risk.
   */
  registerMcpTools(tools: McpToolAdapter[]): { registered: McpToolAdapter[]; skipped: string[] } {
    const registered: McpToolAdapter[] = [];
    const skipped: string[] = [];
    for (const tool of tools) {
      if (this.kernelCatalog.get(tool.name)) {
        skipped.push(tool.name);
        continue;
      }
      this.registry.register(tool, "MCP");
      this.kernelCatalog.registerLegacy(tool, "MCP", tool.security);
      registered.push(tool);
    }
    return { registered, skipped };
  }

  /**
   * Kernel gateway invocation: normalize → validate(policy per engine) →
   * per-tool concurrency → timeout → structured ToolResult. `result.data`
   * keeps the exact record shape the legacy Registry.invoke returned, so
   * callers migrate by swapping the call, not the handling code.
   */
  invokeTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: { agentId?: string; runId?: string; signal?: AbortSignal },
  ): Promise<ToolResult> {
    return this.gateway.invoke(name, args, ctx);
  }
}
