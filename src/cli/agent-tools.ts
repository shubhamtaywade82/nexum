import { Registry } from "../tools/registry.js";
import { Tool } from "../tools/tool.js";
import { connectMcpServer } from "../mcp/client.js";
import { connectMcpServerV2 } from "../mcp/adapter/mcp-client-factory.js";
import { McpToolAdapter } from "../mcp/adapter/mcp-tool-adapter.js";
import { mcpSecurityMetadata } from "../mcp/adapter/security-metadata.js";
import type { McpSecurityOverride } from "../mcp/adapter/security-metadata.js";
import { mcpServerFingerprint, type McpTrustPolicy } from "../mcp/trust.js";
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
  dockerPack,
  docsPack,
  filesystemPack,
  gitPack,
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

export type ToolOnOutput = (stream: "stdout" | "stderr", chunk: string) => void;

/** Trust-gated MCP registration options (P2 trust tier). */
export interface McpRegistrationOptions {
  /** Server name used for rule matching + approvals (default: `stdio:<command>`). */
  serverName?: string;
  /** Trust policy; when set, servers/tools must pass it to register. */
  trust?: McpTrustPolicy;
  /** Per-server security overrides applied to every registered tool. */
  security?: McpSecurityOverride;
}

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
  ): void {
    this.registerToolPack(filesystemPack(root));
    this.registerToolPack(shellPack(root, onOutput, shellOpts));
    this.registerToolPack(searchPack(root));
    this.registerToolPack(gitPack(root));
    this.registerToolPack(projectPack(root));
    this.registerToolPack(rubyPack(root));
    this.registerToolPack(dockerPack(root));
    this.registerToolPack(databasePack(root));
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
    if (!opts.trust && !opts.security) {
      // Legacy path — no policy, no overrides; behavior identical to before.
      const tools = await connectMcpServer(command, args);
      for (const tool of tools) this.registerTool(tool, "MCP");
      return tools;
    }

    const serverName = opts.serverName ?? `stdio:${command}`;
    const connection = await connectMcpServerV2({ kind: "stdio", command, args });

    let security: McpSecurityOverride = { ...opts.security };
    if (opts.trust) {
      const fingerprint = mcpServerFingerprint(connection.descriptor);
      const decision = await opts.trust.decideServer(serverName, fingerprint);
      if (!decision.allowed) {
        await connection.close();
        throw new Error(`[mcp-trust] ${decision.reason}`);
      }
      security = { ...security, ...decision.rule?.security };
    }

    const tools: Tool[] = [];
    for (const discovered of connection.tools) {
      // Effective risk first (inference + overrides) so the ceiling sees what
      // the gateway will actually enforce.
      const metadata = mcpSecurityMetadata(discovered, security);
      if (opts.trust) {
        const decision = opts.trust.decideTool(serverName, discovered.name, metadata.risk);
        if (!decision.allowed) continue;
      }
      tools.push(
        new McpToolAdapter(
          {
            callTool: async (request) => {
              const result = await connection.client.callTool({
                name: request.name,
                arguments: request.arguments,
              });
              return result as unknown as Record<string, unknown>;
            },
          },
          {
            name: discovered.name,
            description: discovered.description,
            inputSchema: discovered.inputSchema,
            annotations: discovered.annotations,
          },
          security,
        ),
      );
    }
    for (const tool of tools) this.registerTool(tool, "MCP");
    return tools;
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
