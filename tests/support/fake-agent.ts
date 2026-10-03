import { AgentConversation } from "../../src/cli/agent-conversation.js";
import type { Agent } from "../../src/cli/agent.js";
import { ApprovalManager } from "../../src/cli/services/approval-manager.js";
import type { ClarificationRequest, ClarificationResponse } from "../../src/runtime/types.js";
import type { ToolDefinition } from "../../src/core/tools/tool-contract.js";
import type { McpCliServerConfig } from "../../src/cli/config.js";
import type { McpToolAdapter } from "../../src/mcp/adapter/mcp-tool-adapter.js";
import { mcpTrustPolicyFromConfig } from "../../src/mcp/trust.js";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../src/tools/gateway/tool-gateway.js";

/** Records every handler call so tests can prove a refused tool never executed. */
export const fakeToolCalls: string[] = [];

function fakeTool(
  id: string,
  risk: ToolDefinition["risk"],
  { financial = false, uiInvocable = false } = {},
): ToolDefinition {
  return {
    id,
    description: id,
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    capabilities: ["market"],
    pack: "test",
    tags: [],
    risk,
    sideEffects: { filesystem: false, process: false, network: false, externalMutation: financial, financial },
    execution: { timeoutMs: 5_000, concurrency: 1, idempotent: !financial, reversible: !financial },
    policy: { confirmation: "never", uiInvocable },
  };
}

function fakeToolGateway(): DefaultToolGateway {
  const record =
    (id: string, result: Record<string, unknown> = { ok: true }) =>
    async () => {
      fakeToolCalls.push(id);
      return result;
    };
  const catalog = new ToolCatalog()
    .register(fakeTool("fake_quote", "read", { uiInvocable: true }), async (args) => {
      fakeToolCalls.push("fake_quote");
      return { symbol: args.symbol, price: 67000.5 };
    })
    // Read-risk, but never opted in: risk alone must not make a tool callable from a UI.
    .register(fakeTool("fake_unlisted_read", "read"), record("fake_unlisted_read"))
    // Opted in by mistake, but high-risk: still agent-only.
    .register(fakeTool("fake_high_opted_in", "high", { uiInvocable: true }), record("fake_high_opted_in"))
    .register(fakeTool("fake_place_order", "high", { financial: true }), record("fake_place_order", { placed: true }));
  return new DefaultToolGateway({ catalog });
}

type EventHandler = (...args: unknown[]) => void;

export class FakeAgent {
  readonly conversation = new AgentConversation();
  readonly sessions = {
    adopt: (_id: string): void => {},
    resumeSessionById: (_id: string): null => null,
  };
  readonly execution: { signal: AbortSignal | null } = { signal: null };
  readonly tools = {
    gateway: fakeToolGateway(),
    registerMcpTools: (tools: McpToolAdapter[]) => ({ registered: tools, skipped: [] as string[] }),
  };

  constructor(private readonly options: { mcpServers?: McpCliServerConfig[] } = {}) {}

  private abortController: AbortController | null = null;
  private readonly listeners = new Map<string, Set<EventHandler>>();
  // The real manager, so tests see the agent's actual deny-by-default and pending-promise behavior.
  private readonly approvals = new ApprovalManager({
    autoApprove: false,
    onApprovalRequested: (request) => this.emit("onApprovalRequested", request),
    onClarificationRequested: (request) => this.emit("onClarificationRequested", request),
    hasApprovalListener: () => (this.listeners.get("onApprovalRequested")?.size ?? 0) > 0,
    hasClarificationListener: () => (this.listeners.get("onClarificationRequested")?.size ?? 0) > 0,
  });
  private customRunHandler?: (goal: string) => Promise<string>;

  on(event: string, handler: EventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) h(...args);
  }

  setRunHandler(handler: (goal: string) => Promise<string>): void {
    this.customRunHandler = handler;
  }

  getSkillsRegistry(): { list: () => unknown[] } {
    return {
      list: () => [
        {
          id: "deploy",
          name: "Deploy",
          description: "Ship a release",
          tags: ["ops"],
          version: "1.0.0",
          scope: "global",
          dir: "/home/someone/.nexum/skills/deploy",
          path: "/home/someone/.nexum/skills/deploy/SKILL.md",
        },
      ],
    };
  }

  async listModels(): Promise<string[]> {
    return ["fake-model"];
  }

  async modelCapabilities(models: string[]): Promise<Record<string, string[]>> {
    return Object.fromEntries(models.map((m) => [m, ["coding", "tools"]]));
  }

  mcpHostConfig() {
    const servers = this.options.mcpServers ?? [];
    return { servers, trust: mcpTrustPolicyFromConfig(servers) };
  }

  requestApproval(title: string, summary: string): Promise<boolean> {
    return this.approvals.requestApproval(title, summary);
  }

  requestClarification(request: ClarificationRequest): Promise<ClarificationResponse> {
    return this.approvals.requestClarification(request);
  }

  resolveApproval(id: string, approved: boolean): void {
    this.approvals.resolveApproval(id, approved);
  }

  resolveClarification(response: ClarificationResponse): void {
    this.approvals.resolveClarification(response);
  }

  async startHost(): Promise<void> {}
  async stopHost(): Promise<void> {}

  resumeSessionById(_id: string): null {
    return null;
  }

  startExecutionRun(): string {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.abortController = new AbortController();
    this.execution.signal = this.abortController.signal;
    return runId;
  }

  cancelExecutionRun(): boolean {
    if (!this.abortController || this.abortController.signal.aborted) {
      return false;
    }
    this.abortController.abort();
    return true;
  }

  endExecutionRun(): void {
    this.abortController = null;
    this.execution.signal = null;
  }

  async runUserMessage(goal: string): Promise<string> {
    if (this.customRunHandler) {
      return this.customRunHandler(goal);
    }
    this.emit("onThinking", "Analyzing request...");
    this.emit("onModelUsed", "fast", "fake-model");
    this.emit("onToolCall", "read_file", { path: "README.md" });
    this.emit("onToolResult", "read_file", { content: "# Nexum" });
    this.conversation.pushUserMessage(goal);
    this.conversation.pushAssistantMessage(`Finished task: ${goal}`);
    return `Finished task: ${goal}`;
  }

  asAgent(): Agent {
    return this as unknown as Agent;
  }
}
