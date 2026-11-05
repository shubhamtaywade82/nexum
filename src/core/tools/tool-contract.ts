/**
 * ToolDefinition — the metadata contract every tool exposes to the runtime
 * (review item 5, strengthened).
 *
 * The legacy `Tool` abstract class (tools/tool.ts) answers "what does
 * this tool do?" with name/description/parameters. That is enough for a
 * schema registry, but not for a security boundary: the runtime needs to
 * know how risky a tool is, what it can touch, whether it is idempotent
 * and reversible, how it should run, what network egress it needs, and
 * whether a human must confirm before it fires. ToolDefinition carries
 * that contract; the ToolGateway is the enforcement point.
 *
 * Explicit metadata (review item 5):
 *   risk               severity ladder used by PolicyEngine
 *   capabilities       what the tool can do / needs (discovery + capability check)
 *   sideEffects        what parts of the world it observes or mutates
 *   idempotency        repeating the call has no additional effect
 *   reversibility      effects can be undone
 *   timeout            hard per-call timeout
 *   concurrency        max in-flight calls of this tool
 *   confirmation       human-in-the-loop requirement
 *   network            explicit network egress requirements
 */

/** Severity ladder used by the PolicyEngine's confirmation rules. */
export type ToolRisk = "read" | "low" | "medium" | "high" | "critical";

export const TOOL_RISK_ORDER: readonly ToolRisk[] = ["read", "low", "medium", "high", "critical"];

export function toolRiskAtLeast(risk: ToolRisk, floor: ToolRisk): boolean {
  return TOOL_RISK_ORDER.indexOf(risk) >= TOOL_RISK_ORDER.indexOf(floor);
}

/** What parts of the world a tool can observe or mutate. */
export interface ToolSideEffects {
  /** Creates/updates/deletes files inside the workspace. */
  filesystem: boolean;
  /** Spawns processes or shell commands. */
  process: boolean;
  /** Performs network I/O (HTTP, exchanges, MCP transports). */
  network: boolean;
  /** Mutates state outside the workspace (git push, GitHub PRs, MCP writes). */
  externalMutation: boolean;
  /** Moves or commits money / positions (trading execution). */
  financial: boolean;
}

/**
 * Explicit network requirements (review item 5) — richer than the
 * sideEffects.network boolean: profiles (item 8) and the sandbox decide
 * egress per declared domain, and offline profiles can deny network
 * tools without blacklisting them.
 */
export interface ToolNetworkRequirements {
  /** Does this tool need network access at all? */
  required: boolean;
  /**
   * Egress allowlist (hostnames or domains). Empty = "any host it was
   * configured with" (exchange endpoints, MCP servers). Profiles match
   * against this to approve or deny execution.
   */
  egress?: string[];
  /** Can the call run through a proxy/sandbox with restricted egress? */
  proxyable: boolean;
}

/** How the gateway should schedule and supervise execution. */
export interface ToolExecutionSpec {
  /** Hard per-call timeout; the gateway rejects results that exceed it. */
  timeoutMs: number;
  /** Max concurrent in-flight calls of THIS tool (per gateway instance). */
  concurrency: number;
  /** Repeating the call with the same args has no additional effect. */
  idempotent: boolean;
  /** The effects can be undone (patch → backup, git → reflog, ...). */
  reversible: boolean;
  /**
   * Idempotency-key semantics for side-effecting tools (review item 28):
   * when true, the gateway requires (or mints) an idempotency key and the
   * IdempotencyManager deduplicates retries of the same logical mutation
   * (git commit/push, GitHub mutations, trading, external API mutations).
   */
  idempotencyKey?: "none" | "required" | "auto";
  /**
   * Where a process-spawning tool runs: "sandbox" (isolated container) or
   * "host" (the user's own account). Argument-based "benign command" allows
   * never apply to host execution.
   */
  isolation?: "sandbox" | "host";
}

/** Human-in-the-loop policy attached to the tool itself. */
export interface ToolPolicySpec {
  confirmation: "never" | "optional" | "required";
  /**
   * A rendered UI may call this tool directly, outside any agent run (see host/ui-tools.ts).
   * Separate from `risk`: risk says how dangerous a call is, this says who may make it without
   * an agent in the loop. Opt-in only; a tool that is not marked here is agent-run only.
   */
  uiInvocable?: boolean;
}

export interface ToolDefinition {
  /** Canonical id — the tool name exposed to models (authoritative, review item 36). */
  id: string;
  description: string;
  /** JSON-Schema (Ollama/OpenAI function-parameters shape). */
  inputSchema: Record<string, unknown>;
  /** Capability tags for discovery filtering + capability checks (coding, market, docs, ...). */
  capabilities: string[];
  /** Legacy category string kept for the TUI tool palette grouping. */
  pack: string;
  tags: string[];

  risk: ToolRisk;
  sideEffects: ToolSideEffects;
  execution: ToolExecutionSpec;
  policy: ToolPolicySpec;
  /** Network egress contract (review item 5). Default: no network. */
  network?: ToolNetworkRequirements;
}

/** Gateway-visible execution result. Domain payloads stay opaque. */
export interface ToolResult {
  ok: boolean;
  /** Tool payload on success; error detail record on failure. */
  data: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** A tool call request as issued by a model or a strategy. */
export interface ToolInvocation {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Everything a tool handler may need about the call being executed
 * (review item 16 — cancellation reaches tool code).
 */
export interface ToolCallContext {
  /** Abort signal for this call (chained from the run's signal). */
  signal?: AbortSignal;
  /** The invocation (id + name + canonical args). */
  invocation: ToolInvocation;
  /** Correlation ids (traceId/runId/taskId/toolCallId — review item 33). */
  runId?: string;
  agentId?: string;
  /** Idempotency key when the tool declared idempotency-key semantics. */
  idempotencyKey?: string;
  /** Redacted call metadata for logging. */
  startedAt: number;
}

/**
 * The callable behind a ToolDefinition. The optional second parameter is
 * the call context: cancellation signal + correlation. Legacy tools that
 * take only args keep working — the gateway always passes it.
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  callCtx?: ToolCallContext,
) => Promise<Record<string, unknown>>;

/** No side effects anywhere — the default for pure read tools. */
export const NO_SIDE_EFFECTS: ToolSideEffects = {
  filesystem: false,
  process: false,
  network: false,
  externalMutation: false,
  financial: false,
};

export const NO_NETWORK: ToolNetworkRequirements = { required: false, proxyable: false };

export const DEFAULT_EXECUTION_SPEC: ToolExecutionSpec = {
  timeoutMs: 120_000,
  concurrency: 4,
  idempotent: false,
  reversible: false,
  idempotencyKey: "none",
};

export const DEFAULT_POLICY_SPEC: ToolPolicySpec = { confirmation: "optional" };

/** Merge partial overrides over safe defaults. */
export function defineToolMetadata(overrides: {
  risk?: ToolRisk;
  sideEffects?: Partial<ToolSideEffects>;
  execution?: Partial<ToolExecutionSpec>;
  policy?: Partial<ToolPolicySpec>;
  network?: Partial<ToolNetworkRequirements>;
}): Pick<ToolDefinition, "risk" | "sideEffects" | "execution" | "policy" | "network"> {
  return {
    risk: overrides.risk ?? "medium",
    sideEffects: { ...NO_SIDE_EFFECTS, ...(overrides.sideEffects ?? {}) },
    execution: { ...DEFAULT_EXECUTION_SPEC, ...(overrides.execution ?? {}) },
    policy: { ...DEFAULT_POLICY_SPEC, ...(overrides.policy ?? {}) },
    network: { ...NO_NETWORK, ...(overrides.network ?? {}) },
  };
}

/**
 * Does this tool mutate state? (Used by read-only profiles and mode
 * restrictions — the widest definition of "mutating".)
 */
export function toolIsMutating(def: Pick<ToolDefinition, "sideEffects" | "risk">): boolean {
  const { sideEffects } = def;
  return (
    sideEffects.filesystem ||
    sideEffects.process ||
    sideEffects.externalMutation ||
    sideEffects.financial ||
    def.risk === "critical"
  );
}
