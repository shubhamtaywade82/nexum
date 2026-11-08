/**
 * KernelEvolutionAgentRuntime — the Evolution Plane promoted onto the kernel.
 *
 * Roadmap lever (docs/guide/kernel.md §Migration status): move `evolution/`
 * behind the kernel as a separate plane that spawns runs through
 * `AgentRuntime.execute`. The legacy NexumEngineeringAgentRuntime runs a
 * private tool loop straight over the raw Provider surface — outside kernel
 * supervision entirely (no policy engine, no budgets, no concurrency gates,
 * no event stream, no cancellation). This module reimplements the SAME
 * propose-only protocol (list_files / read_file / propose_edit / finish /
 * decline, one shared schema vocabulary exported from the legacy runtime) as
 * a kernel ToolCatalog mounted behind a ToolGateway, and spawns each
 * mutation as ONE ExecutionRequest through `AgentRuntime.execute`:
 *
 *   ClosedLoopEngine (agentRuntime: KernelEvolutionAgentRuntime)
 *     ↓ AgentRuntime.execute — agent gate, budgets, events, abort signal
 *   ReActStrategy over the propose-only pack
 *     ↓ ToolGateway pipeline: validate → policy → concurrency → timeout
 *   proposals only — the mutation executor applies, verifies (actual-diff
 *   audit), commits, benchmarks, and delivers (unchanged safety pipeline)
 *
 * Trust boundary (defense in depth — same layers as the legacy runtime,
 * plus kernel policy): the agent is PROMPTED with the allowed paths;
 * propose_edit rejects out-of-scope paths at queue time with an error the
 * model can read; the final response is re-audited fail-closed via the
 * SHARED scope verdict (mutationScopeViolation, path-scope.ts) so the
 * queue-time and re-audit checks cannot drift; the strategy attributes
 * every edit; the executor audits the actual git diff. The pack is
 * read+propose only — no write, no shell, no network — and runs
 * `unattended` (headless: the gateway's confirmation gate is bypassed by
 * contract, though the pack requests confirmation "never" anyway).
 *
 * Legacy parity notes:
 *   - maxTurns (chat turns) → the kernel ReAct loop's maxToolTurns.
 *   - Turn budget exhausted → terminal "turn_budget" → AgentMutationError
 *     with the same message shape as the legacy loop.
 *   - finish/decline are TERMINAL: the onToolObserved hook ends the run the
 *     moment either is observed (the legacy loop broke out of its for-loop;
 *     here the kernel's ToolObservationAction.abortRun does it).
 *   - A text-only turn is nudged back to the tools: the callModel hook
 *     strips prose-only responses so the kernel strategy's think-nudge
 *     fires and the loop continues — matching the legacy loop's recovery
 *     nudge and making a prose "final answer" unreachable (fail-closed).
 *   - onTurn telemetry: kernel turn numbers are 0-based (legacy was
 *     1-based); the hook fires when the NEXT turn starts (or after the
 *     run), once that turn's tool calls have completed.
 */

import {
  AgentEditProposal,
  AgentMutationError,
  AgentMutationRequest,
  AgentMutationResponse,
  EngineeringAgentRuntime,
} from "./agent-mutation.js";
import { EngineeringChatClient, TOOLS } from "./nexum-agent-runtime.js";
import { mutationScopeViolation } from "./path-scope.js";

import { ToolCatalog } from "../../tools/gateway/tool-catalog.js";
import { DefaultToolGateway } from "../../tools/gateway/tool-gateway.js";
import { ToolDefinition, ToolHandler } from "../../core/tools/tool-contract.js";
import { ModelCapabilityRegistry } from "../../models/profiles/model-capability-registry.js";
import type { ModelGateway } from "../../models/gateway/model-gateway.js";
import { createExecutionContext, TransientContextManager } from "../../runtime/context/execution-context.js";
import { DefaultAgentRuntime } from "../../runtime/agent/agent-runtime.js";
import { extractToolCalls } from "../../runtime/strategies/execution-strategy.js";
import type { AgentId, AgentRuntime, EventSink, ExecutionBudget, ExecutionRequest } from "../../core/types.js";
import type { StrategyHooks } from "../../runtime/strategies/strategy-hooks.js";
import type { Capability } from "../../models/catalog.js";
import type { ChatMessage, OllamaToolSchema } from "../../models/adapters/provider.js";

// ── Model gateway adapter ───────────────────────────────────────────────────

/**
 * Adapts the evolution plane's chat surface (EngineeringChatClient —
 * satisfied by chatClientFromProvider(new Provider(...)) in production and
 * by scripted fakes in tests) onto the kernel's ModelGateway port. The
 * capability tag is advisory here: the chat client already pins its
 * model/tier, so routing is a pass-through that keeps the kernel contract
 * intact (the kernel's ReAct loop calls route() and records usage against
 * the run budget).
 */
export function modelGatewayFromChatClient(chat: EngineeringChatClient): ModelGateway {
  return {
    async route(_capability: Capability, messages, opts) {
      return chat.chat(messages, { tools: opts?.tools });
    },
    async routeToModel(_model, _tier, messages, opts) {
      return chat.chat(messages, { tools: opts?.tools });
    },
    profiles: () => new ModelCapabilityRegistry(),
    // scored selection is a transport-agnostic view; the evolution plane
    // pins its model, so selection returns the pinned "no alternatives"
    // result rather than consulting a registry.
    select: () => [],
  };
}

// ── Agent descriptor ────────────────────────────────────────────────────────

/** Default agent id for evolution runs (auto-registered for DefaultAgentRuntime). */
export const EVOLUTION_AGENT_ID: AgentId = "evolution";

/** Descriptor for the evolution agent: tools-capability ReAct runs, no packs. */
export function evolutionAgentDescriptor() {
  return {
    id: EVOLUTION_AGENT_ID,
    displayName: "Nexum Evolution Agent",
    description: "Self-development plane agent: proposes harness mutations through a read+propose-only pack.",
    defaultCapability: "tools" as Capability,
    defaultStrategy: "react" as const,
  };
}

// ── Runtime ─────────────────────────────────────────────────────────────────

export interface KernelEvolutionAgentRuntimeOptions {
  /** The kernel runtime facade the mutation runs spawn through. */
  runtime: AgentRuntime;
  /** Agent id (default "evolution"; auto-registered on DefaultAgentRuntime). */
  agentId?: AgentId;
  /** Model gateway (production: modelGatewayFromChatClient(chatClientFromProvider(...))). */
  modelGateway: ModelGateway;
  /** Max ReAct turns — mirrors the legacy maxTurns (default 24). */
  maxTurns?: number;
  /** Max queued proposals per mutation (default 25). */
  maxProposals?: number;
  /** Max bytes for one proposed file's content (default 512 KiB). */
  maxEditBytes?: number;
  /** Extra system-prompt guidance (repo conventions, target specifics). */
  systemPromptExtras?: string;
  /** Observability hook: fired once per completed turn (0-based, after its tool calls). */
  onTurn?: (turn: number, toolCalls: string[]) => void;
  /** Transcript hook: every raw model response and every tool call with its args and result. */
  onTrace?: (entry: MutationTraceEntry) => void;
  /** Kernel event sink for the run (execution-family events). */
  events?: EventSink;
  /** Cancellation: aborting unwinds the run → AgentMutationError. */
  signal?: AbortSignal;
  /** Extra budget ceilings (deadline, maxModelCalls, ...) beyond the turn budget. */
  budgets?: ExecutionBudget;
}

export type MutationTraceEntry =
  | { kind: "model"; turn: number; content: string; thinking?: string; toolCalls: unknown[] }
  | { kind: "tool"; turn: number; name: string; args: Record<string, unknown>; ok: boolean; result: unknown };

interface QueuedEdit {
  proposal: AgentEditProposal;
}

export class KernelEvolutionAgentRuntime implements EngineeringAgentRuntime {
  readonly name = "nexum-engineering-kernel";
  private readonly runtime: AgentRuntime;
  private readonly agentId: AgentId;
  private readonly modelGateway: ModelGateway;
  private readonly maxTurns: number;
  private readonly maxProposals: number;
  private readonly maxEditBytes: number;
  private readonly systemPromptExtras?: string;
  private readonly onTurn?: (turn: number, toolCalls: string[]) => void;
  private readonly onTrace?: (entry: MutationTraceEntry) => void;
  private readonly events?: EventSink;
  private readonly signal?: AbortSignal;
  private readonly budgets?: ExecutionBudget;

  constructor(opts: KernelEvolutionAgentRuntimeOptions) {
    this.runtime = opts.runtime;
    this.agentId = opts.agentId ?? EVOLUTION_AGENT_ID;
    this.modelGateway = opts.modelGateway;
    const envTurns = process.env.NEXUM_MUTATION_MAX_TURNS
      ? parseInt(process.env.NEXUM_MUTATION_MAX_TURNS, 10)
      : undefined;
    this.maxTurns = opts.maxTurns ?? (Number.isFinite(envTurns) && envTurns! > 0 ? envTurns! : 24);
    this.maxProposals = opts.maxProposals ?? 25;
    this.maxEditBytes = opts.maxEditBytes ?? 512 * 1024;
    this.systemPromptExtras = opts.systemPromptExtras;
    this.onTurn = opts.onTurn;
    this.onTrace = opts.onTrace;
    this.events = opts.events;
    this.signal = opts.signal;
    this.budgets = opts.budgets;

    // Out-of-the-box wiring: register the evolution agent descriptor when
    // the runtime exposes the kernel's agent registry (DefaultAgentRuntime
    // does). A registry that already knows the id is left untouched —
    // products may want their own descriptor shape for the same id.
    const registry = (this.runtime as DefaultAgentRuntime).agents;
    if (registry && typeof registry.get === "function" && typeof registry.register === "function") {
      if (!registry.get(this.agentId)) registry.register(evolutionAgentDescriptor());
    }
  }

  async proposeMutation(request: AgentMutationRequest): Promise<AgentMutationResponse> {
    const { worktree } = request;

    // ── Collectors (closures shared by the tool handlers and the hooks) ──
    const proposals: QueuedEdit[] = [];
    const investigation: string[] = [];
    let finishedSummary: string | null = null;
    let declinedReason: string | null = null;

    // ── The propose-only pack, built per mutation ──
    // Handlers close over THIS request's worktree and collectors; the
    // catalog (and therefore the gateway) is fresh per proposeMutation, so
    // two concurrent mutations never share collector state. The schemas are
    // the legacy protocol's TOOLS (single vocabulary, two supervision
    // models) — the descriptions/schemas are re-declared here because the
    // kernel ToolDefinition carries them inline alongside its metadata.
    const schemas = new Map(TOOLS.map((t) => [t.function.name, t.function.parameters]));
    const catalog = new ToolCatalog();
    const register = (name: string, idempotent: boolean, handler: ToolHandler) => {
      const schema = schemas.get(name) ?? { type: "object", properties: {}, required: [] };
      const definition: ToolDefinition = {
        id: name,
        description: TOOLS.find((t) => t.function.name === name)?.function.description ?? name,
        inputSchema: schema as Record<string, unknown>,
        capabilities: ["evolution"],
        pack: "evolution-proposal",
        tags: ["evolution", "propose-only"],
        // read+propose only: nothing here touches disk, processes, network,
        // or money. propose_edit mutates an in-memory queue — nothing else.
        risk: "read",
        sideEffects: { filesystem: false, process: false, network: false, externalMutation: false, financial: false },
        execution: { timeoutMs: 30_000, concurrency: 1, idempotent, reversible: false },
        policy: { confirmation: "never" },
      };
      catalog.register(definition, handler);
    };

    register("list_files", true, async (args) => {
      const prefix = typeof args.prefix === "string" ? args.prefix : undefined;
      const files = await worktree.listFiles(prefix);
      investigation.push(`list_files(${prefix ?? "*"}) → ${files.length} files`);
      return { files };
    });

    register("read_file", true, async (args) => {
      const path = typeof args.path === "string" ? args.path : "";
      const content = await worktree.readFile(path);
      investigation.push(`read_file(${path}) → ${content === null ? "MISSING" : `${content.length} chars`}`);
      return content === null ? { error: `file not found or unreadable: ${path}` } : { path, content };
    });

    register("propose_edit", false, async (args) => {
      const verdict = checkProposal(args, request, proposals.length, this.maxProposals, this.maxEditBytes);
      if (verdict.error !== null) {
        investigation.push(`propose_edit(${verdict.path ?? "?"}) → REJECTED: ${verdict.error}`);
        return { error: verdict.error };
      }
      proposals.push({
        proposal: { path: verdict.path!, content: verdict.content!, rationale: verdict.rationale ?? "" },
      });
      investigation.push(`propose_edit(${verdict.path}) → queued (${proposals.length}/${this.maxProposals})`);
      return { ok: true, path: verdict.path, queued: proposals.length };
    });

    register("finish", true, async (args) => {
      finishedSummary =
        typeof args.summary === "string" && args.summary.length > 0 ? args.summary : "Mutation finished.";
      return { ok: true };
    });

    register("decline", true, async (args) => {
      declinedReason =
        typeof args.reason === "string" && args.reason.length > 0 ? args.reason : "agent declined without a reason";
      return { ok: true };
    });

    // ── Kernel wiring ──
    const toolGateway = new DefaultToolGateway({
      catalog,
      label: "evolution-proposal-gateway",
      validation: "strict",
    });

    const executionRequest: ExecutionRequest = {
      agentId: this.agentId,
      task: {
        goal: this.missionPrompt(request),
        input: this.missionPrompt(request),
        metadata: {
          stepId: "evolution.proposeMutation",
          target: request.target.capability,
          scope: request.scope.components,
        },
      },
      strategy: "react",
      unattended: true,
    };

    // The transcript is seeded with the propose-only contract (system
    // message); the strategy pushes task.input as the user turn — the
    // mission prompt is NOT pushed here (transcript-ownership rule, same as
    // the Agent's preamble).
    const conversation = new TransientContextManager([{ role: "system", content: this.systemPrompt(request) }]);

    const context = createExecutionContext(executionRequest, {
      signal: this.signal,
      events: this.events,
      budget: this.budgets,
      modelGateway: this.modelGateway,
      toolGateway,
      context: conversation,
    });

    let turnInvocations: string[] = [];
    let lastTurnSeen = 0;
    const hooks: StrategyHooks = {
      // Propose-only protocol: a prose turn can NEVER terminate the run (the
      // legacy loop answered any text-only turn with a "Respond only through
      // the provided tools" nudge and kept going). The kernel strategy
      // treats a content-only turn as terminal ("answered"), so the
      // callModel hook strips the content from text-only responses — the
      // strategy then fires its own think-nudge and the loop continues
      // until a terminal TOOL arrives or the turn budget is spent. The
      // "answered" terminal becomes unreachable, which is exactly the
      // legacy fail-closed shape (turn budget → AgentMutationError).
      callModel: async (turnInfo, opts) => {
        const response = await context.modelGateway.route("tools", turnInfo.messages as ChatMessage[], {
          tools: opts.tools as OllamaToolSchema[] | undefined,
        });
        // Traced before the prose strip below, so the transcript shows what the model actually said.
        this.onTrace?.({
          kind: "model",
          turn: turnInfo.turn,
          content: response.message?.content ?? "",
          thinking: (response.message as { thinking?: string } | undefined)?.thinking,
          toolCalls: response.message?.tool_calls ?? [],
        });
        if (extractToolCalls(response).length === 0 && (response.message?.content ?? "").length > 0) {
          return { ...response, message: { ...response.message, content: "" } };
        }
        return response;
      },
      // Telemetry parity: report each completed turn's tool calls. The
      // strategy's turn counter is 0-based (legacy was 1-based).
      onTurnStart: (info) => {
        lastTurnSeen = info.turn;
        if (info.turn > 0 && turnInvocations.length > 0) {
          this.onTurn?.(info.turn - 1, turnInvocations);
          turnInvocations = [];
        }
        const remaining = this.maxTurns - info.turn;
        if (this.maxTurns > 4 && remaining <= 4 && remaining > 0) {
          conversation.pushSystem(
            `[Notice] You have ${remaining} turn(s) remaining before turn budget is exhausted. You must call propose_edit to queue your edits and finish() to complete the mutation, or decline() if no safe mutation exists.`,
          );
        }
      },
      // With onToolObserved installed, the hook OWNS the observation push.
      onToolObserved: (obs) => {
        turnInvocations.push(obs.name);
        this.onTrace?.({
          kind: "tool",
          turn: obs.turn,
          name: obs.name,
          args: obs.args,
          ok: obs.result.ok,
          result: obs.result.ok ? obs.result.data : obs.result,
        });
        conversation.pushToolResult(JSON.stringify(obs.result.data, null, 2));
        // finish/decline are the protocol's terminal tools: end the kernel
        // run right here (the legacy loop broke out of its for-loop).
        if (obs.name === "finish" && obs.result.ok) {
          return { abortRun: true, terminal: "finished", output: finishedSummary ?? "Mutation finished." };
        }
        if (obs.name === "decline" && obs.result.ok) {
          return { abortRun: true, terminal: "declined", output: "Declined." };
        }
        return undefined;
      },
    };

    const result = await this.runtime.execute(executionRequest, context, {
      hooks,
      maxToolTurns: this.maxTurns,
    });

    // Flush the final turn's telemetry (onTurnStart only fires per NEW turn).
    if (turnInvocations.length > 0) {
      this.onTurn?.(lastTurnSeen, turnInvocations);
      turnInvocations = [];
    }

    // ── Map the ExecutionResult back onto the AgentMutationResponse ──
    if (result.status !== "completed") {
      throw new AgentMutationError(`Engineering agent run ${result.status}: ${result.error ?? "no error recorded"}`);
    }

    if (declinedReason !== null) {
      return { edits: [], investigation, summary: "Declined.", declined: { reason: declinedReason } };
    }

    if (finishedSummary === null) {
      // The run ended without the protocol's terminal tool: turn budget
      // (kernel "turn_budget"), a prose answer after nudges ("answered"), or
      // a model/tool loop abort. All are fail-closed cycle aborts — the
      // legacy loop threw the same error class in these cases.
      const terminal = result.metadata?.terminal as string | undefined;
      if (terminal === "turn_budget") {
        throw new AgentMutationError(
          `Engineering agent exceeded the ${this.maxTurns}-turn budget without calling finish/decline.`,
        );
      }
      throw new AgentMutationError(
        `Engineering agent ended without calling finish/decline (terminal: ${terminal ?? "unknown"}).`,
      );
    }

    // Fail-closed re-audit of everything actually queued: the queue-time
    // check and this audit share ONE verdict function (mutationScopeViolation),
    // so a drift between them is impossible by construction — the audit
    // keeps the invariant explicit and catches collector tampering.
    for (const queued of proposals) {
      const violation = mutationScopeViolation(queued.proposal.path, request.allowedPaths);
      if (violation) {
        throw new AgentMutationError(
          `Queued proposal ${queued.proposal.path} is outside the allowed mutation paths (${violation}); aborting fail-closed.`,
        );
      }
    }

    if (proposals.length === 0) {
      // Honest outcome: the agent investigated but found nothing to change.
      return {
        edits: [],
        investigation,
        summary: finishedSummary,
        declined: { reason: `investigation finished without any proposed edit: ${finishedSummary}` },
      };
    }

    return {
      edits: proposals.map((p) => p.proposal),
      investigation,
      summary: finishedSummary,
    };
  }

  // ── Prompting (byte-compatible with the legacy runtime) ─────────────────

  private systemPrompt(request: AgentMutationRequest): string {
    const lines = [
      "You are Nexum's engineering agent executing a SELF-DEVELOPMENT mutation:",
      "you inspect the candidate worktree of the Nexum repository itself and propose",
      "concrete source edits that move the improvement target's must-move metrics.",
      "",
      "Contract:",
      "- You have NO direct write or shell access. Use propose_edit to queue the FULL",
      "  new content of a file; the executor applies, verifies, and commits it.",
      `- Allowed mutation paths (prefixes): ${request.allowedPaths.join(", ")}`,
      "- Proposing outside them is rejected; repeated violations abort the cycle.",
      "- Read before proposing: understand the existing implementation first.",
      "- Prefer the smallest in-scope change with a clear causal path to the target.",
      `- You have a budget of up to ${this.maxTurns} turns. Conclude with finish (edits queued) or decline (no safe mutation exists).`,
      "",
      `Scope components: ${request.scope.components.join(", ")}.`,
      `Worktree parent commit: ${request.worktree.parentCommit}.`,
    ];
    if (request.experienceDigest) {
      lines.push("", "Relevant experience (evidence-grounded digests):", request.experienceDigest);
    }
    if (request.telemetryDigest) {
      lines.push("", "Operational telemetry of the active harness:", request.telemetryDigest);
    }
    if (this.systemPromptExtras) {
      lines.push("", this.systemPromptExtras);
    }
    return lines.join("\n");
  }

  private missionPrompt(request: AgentMutationRequest): string {
    const t = request.target;
    const lines = [
      `Improvement target: ${t.capability} — ${t.desiredOutcome}`,
      t.observableSymptoms.length ? `Symptoms: ${t.observableSymptoms.join("; ")}` : null,
      `Must-move metrics: ${t.measurableMetrics.join(", ")}`,
      t.affectedComponents.length ? `Affected components: ${t.affectedComponents.join(", ")}` : null,
      request.diagnosis
        ? `Diagnosis: ${request.diagnosis.failureClass} at ${request.diagnosis.component} (confidence ${request.diagnosis.confidence}). Root cause: ${request.diagnosis.rootCause} Proposed fix: ${request.diagnosis.proposedFix}`
        : null,
      "",
      "Investigate the worktree (list_files/read_file), then queue your edits with",
      "propose_edit and end with finish — or decline with a concrete reason.",
    ].filter((l): l is string => l !== null);
    return lines.join("\n");
  }
}

// ── Proposal verdict (legacy checkProposal, parameterized) ────────────────

function checkProposal(
  args: Record<string, unknown>,
  request: AgentMutationRequest,
  queuedCount: number,
  maxProposals: number,
  maxEditBytes: number,
): { path: string | null; content: string | null; rationale: string | null; error: string | null } {
  const path = typeof args.path === "string" ? args.path : null;
  const content = typeof args.content === "string" ? args.content : null;
  const rationale = typeof args.rationale === "string" ? args.rationale : null;

  if (!path || !content) return { path, content, rationale, error: "propose_edit requires path and content strings" };
  if (queuedCount >= maxProposals) {
    return { path, content, rationale, error: `proposal budget exhausted (${maxProposals})` };
  }
  if (Buffer.byteLength(content, "utf8") > maxEditBytes) {
    return {
      path,
      content,
      rationale,
      error: `content exceeds the ${maxEditBytes}-byte per-edit cap; split the change`,
    };
  }
  const violation = mutationScopeViolation(path, request.allowedPaths);
  if (violation) return { path, content, rationale, error: `rejected: ${violation}` };
  return { path, content, rationale, error: null };
}
