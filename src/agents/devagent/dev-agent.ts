/**
 * DevAgent — the software-engineering PRODUCT agent (review item 40).
 *
 * Target dependency direction:
 *
 *   ollama-sdk
 *      ↓
 *   NEXUM CORE (runtime, tools, orchestration — domain-neutral)
 *      ↓
 *   DevAgent / CryptoAgent / other product agents
 *
 * The product agent composes the runtime + the packs it needs and
 * declares its capabilities (review item 24). It owns NO runtime logic:
 * strategies, budgets, policies, cancellation and persistence live in the
 * core planes below it.
 */

import { DefaultAgentRuntime, AgentRegistry } from "../../runtime/agent/agent-runtime.js";
import type { CriticPolicy } from "../../runtime/strategies/execution-strategy.js";
import { createManagedExecutionContext } from "../../runtime/context/execution-context.js";
import { profilePosture } from "../../core/policy/postures.js";
import { IdempotencyManager } from "../../tools/idempotency.js";
import { DefaultToolGateway, ToolGateway } from "../../tools/gateway/tool-gateway.js";
import { ToolCatalog } from "../../tools/gateway/tool-catalog.js";
import { mountToolPack, type ToolPack } from "../../tools/gateway/tool-pack.js";
import type { ModelGateway } from "../../models/gateway/model-gateway.js";
import type { ExecutionRequest, ExecutionResult, ExecutionContext } from "../../core/types.js";
import type { AgentDescriptor } from "../../runtime/agent/agent-runtime.js";

export interface DevAgentOptions {
  runtime?: DefaultAgentRuntime;
  modelGateway: ModelGateway;
  workspaceRoot: string;
  /** Tool packs to mount (defaults: filesystem, process, git, github). */
  packs?: ToolPack[];
  /** Execution profile (review item 8); default "development". */
  profile?: "readonly" | "development" | "testing" | "devops";
  /** Durable execution history store root (review item 13). */
  stateRoot?: string;
  /**
   * In-loop critic for final answers (default ON — pass `false` to disable,
   * or a CriticPolicy to tune attempts/severity). Weak answers get one
   * bounded revision inside the same execution.
   */
  critic?: boolean | CriticPolicy;
}

export const DEVAGENT_DESCRIPTOR: AgentDescriptor = {
  id: "devagent",
  displayName: "Nexum DevAgent",
  description: "Software-engineering agent: filesystem, git, tests, LSP, browser.",
  defaultCapability: "agentic",
  defaultStrategy: "react",
  capabilities: ["coding", "filesystem", "git", "build", "code-intelligence"],
  requiredTools: ["read_file", "write_file", "apply_patch", "run_shell"],
  allowedPolicies: ["parity", "standard", "restricted"],
  supportedStrategies: ["react", "plan_execute", "graph"],
  allowedPackIds: ["filesystem", "process", "git", "github", "lsp", "docs", "browser"],
};

/**
 * The DevAgent product: a thin composition over Nexum Core. Mount packs,
 * build the gateway with an execution-profile posture, and execute tasks
 * through the kernel runtime.
 */
export class DevAgent {
  readonly runtime: DefaultAgentRuntime;
  readonly toolGateway: ToolGateway;
  readonly descriptor: AgentDescriptor;

  private readonly modelGateway: ModelGateway;
  private readonly catalog: ToolCatalog;
  private readonly idempotency: IdempotencyManager;

  constructor(opts: DevAgentOptions) {
    this.modelGateway = opts.modelGateway;
    this.catalog = new ToolCatalog();
    this.idempotency = new IdempotencyManager();
    this.descriptor = DEVAGENT_DESCRIPTOR;

    // execution-profile posture (review item 8): development by default —
    // sandboxed commands, workspace writes, no external mutation
    const posture = profilePosture(opts.profile ?? "development");
    this.toolGateway = new DefaultToolGateway({
      catalog: this.catalog,
      policyEngine: posture,
      validation: "strict",
      label: `devagent:${opts.profile ?? "development"}`,
      idempotency: this.idempotency,
    });

    // Default-on in-loop critic (product policy): only high-severity
    // weaknesses trigger a revision, one attempt — quality lift without
    // runaway latency on healthy answers. `critic: false` opts out, a
    // CriticPolicy tunes it.
    const criticPolicy: CriticPolicy | undefined =
      opts.critic === false
        ? undefined
        : opts.critic === true || opts.critic === undefined
          ? { maxAttempts: 1, minSeverity: "high" }
          : opts.critic;

    this.runtime =
      opts.runtime ??
      new DefaultAgentRuntime({
        recorder: undefined,
        ...(criticPolicy ? { critic: criticPolicy } : {}),
      });
    if (!(this.runtime.agents as AgentRegistry).get("devagent")) {
      this.runtime.agents.register(DEVAGENT_DESCRIPTOR);
    }

    for (const pack of opts.packs ?? []) {
      mountToolPack(pack, this.catalog);
    }
  }

  /** Execute one task through the kernel (request-scoped context). */
  async execute(
    request: ExecutionRequest,
    context?: Partial<Parameters<typeof createManagedExecutionContext>[1]>,
  ): Promise<ExecutionResult> {
    const ctx: ExecutionContext = createManagedExecutionContext(
      { ...request, agentId: this.descriptor.id },
      {
        modelGateway: this.modelGateway,
        toolGateway: this.toolGateway,
        ...context,
      },
    );
    return this.runtime.execute({ ...request, agentId: this.descriptor.id }, ctx);
  }

  cancel(runId: string): boolean {
    return this.runtime.cancel(runId);
  }
}
