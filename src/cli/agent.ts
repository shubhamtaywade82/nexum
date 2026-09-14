import { CliConfig, loadConfig } from "./config.js";
import { WorkspaceManager } from "../platform/workspace.js";
import { ChatMessage, ChatOptions, ChatResponse } from "../models/adapters/provider.js";
import { Capability } from "../models/catalog.js";
import { ModelStack } from "./services/model-stack.js";
import { SessionManager } from "./services/session-manager.js";
import { ApprovalManager } from "./services/approval-manager.js";
import { ExecutionManager } from "./services/execution-manager.js";
import { CheckpointStore } from "../runtime/checkpoint.js";
import { SessionStore, SessionMeta } from "../runtime/session.js";
import { LoopDetector } from "../orchestration/loop-detector.js";
import { PlanStep, Planner } from "../orchestration/types.js";
import { generatePlan, replanSteps } from "../ui/plan-generator.js";
import { SkillMeta } from "../skills/types.js";
import { LspServerState } from "../lsp/protocol.js";
import {
  ApprovalRequest,
  ClarificationRequest,
  ClarificationResponse,
  McpServerState,
  MissionPhase,
  MissionPhaseId,
  ProjectInfo,
} from "../runtime/types.js";
import { IntentResolver } from "../intent/intent-resolver.js";
import { MemoryStore } from "../memory/store.js";
import { DocsStore } from "../docs/store.js";
import { AgentConversation } from "./agent-conversation.js";
import { AgentToolManager } from "./agent-tools.js";
import { AgentIntelligence } from "./agent-intelligence.js";
import { AgentLearning } from "./agent-learning.js";
import { DynamicToolSelector } from "../tools/discovery.js";
import { BrowserManager } from "../browser/manager.js";
import { BinanceStreamManager } from "../domains/trading/binance-stream.js";

import { LOCAL_DELEGATION_SYSTEM_ADDENDUM } from "../tools/delegate-tool.js";
import { detectEscalationHint, isLookupPrompt } from "./agent-escalation.js";
// ── Kernel (agent execution kernel) ───────────────────────────────────
import { ApprovalBroker, describeConfirmation } from "../core/policy/approval-broker.js";
import { DefaultModelGateway } from "../models/gateway/model-gateway.js";
import { ModelCapabilityRegistry } from "../models/profiles/model-capability-registry.js";
import { DefaultAgentRuntime, devAgentDescriptor } from "../runtime/agent/agent-runtime.js";
import { createExecutionContext } from "../runtime/context/execution-context.js";
import type { ExecutionRequest } from "../core/types.js";
import type { StrategyHooks } from "../runtime/strategies/strategy-hooks.js";
import { AgentConversationContext } from "./agent-conversation-context.js";

// Confirmation gate for irreversible actions lives in the kernel now
// (src/kernel/policy/approval-broker.ts): the classification table and the
// ApprovalBroker are shared across CLI, TUI, API, and future agent products.
// (UX safety net, not a security boundary — Docker sandboxing already
// bounds worst-case blast radius for run_shell.)

export interface AgentEvents {
  onAssistantText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
  onStatus?: (status: string) => void;
  onShellOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  onMemorySummary?: (summary: string) => void;
  onSkillsActivated?: (skills: SkillMeta[]) => void;
  onLspStateChange?: (servers: LspServerState[]) => void;
  onUsage?: (info: {
    promptTokens: number;
    completionTokens: number;
    tokensPerSecond: number;
    latencyMs: number;
  }) => void;
  onPlanUpdate?: (goal: string, steps: PlanStep[], status: "running" | "completed" | "failed") => void;
  onApprovalRequested?: (request: ApprovalRequest) => void;
  onClarificationRequested?: (request: ClarificationRequest) => void;
  onModelUsed?: (tier: string, model: string) => void;
  /** Whole-mission phase system (see runtime/mission-derive.ts): a new mission
   * begins, a phase's status changes, or a live plan step transitions. */
  onMissionStarted?: (goal: string) => void;
  onMissionPhase?: (id: MissionPhaseId, status: MissionPhase["status"]) => void;
  onMissionStep?: (step: PlanStep) => void;
}

type AgentEventName = keyof AgentEvents;
type AgentEventHandler<E extends AgentEventName> = NonNullable<AgentEvents[E]>;

export interface AgentOptions {
  config?: Partial<CliConfig>;
  events?: AgentEvents;
  skillsHomeDir?: string;
}

export class Agent {
  readonly conversation: AgentConversation;
  readonly tools: AgentToolManager;
  readonly intelligence: AgentIntelligence;
  readonly learning: AgentLearning;
  readonly memory: MemoryStore;
  readonly docs: DocsStore;
  readonly lspManager: AgentIntelligence["lspManager"];
  readonly railsIndex: AgentIntelligence["railsIndex"];
  readonly browser: BrowserManager;
  readonly binanceStream: BinanceStreamManager;
  private readonly toolSelector: DynamicToolSelector;

  // ── services (review item 1): the god class's extracted concerns ──────
  /** Model plane: providers, catalog, routing, hybrid components. */
  readonly stack: ModelStack;
  /** Conversation persistence + background summarization. */
  readonly sessions: SessionManager;
  /** Human-in-the-loop gates: approvals + clarifications. */
  readonly approvals: ApprovalManager;
  /** Run scopes, cancellation, planned missions. */
  readonly execution: ExecutionManager;

  private readonly planCheckpoint: CheckpointStore;
  private readonly loopDetector = new LoopDetector();
  private readonly maxToolTurns = 128;
  readonly events: AgentEvents;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  readonly workspaceRoot: string;
  private readonly mcpServerConfigs: Array<{ name: string; command: string; args?: string[] }>;
  private readonly autoApproveFlag: boolean;
  readonly intentResolver = new IntentResolver();
  projectInfo?: ProjectInfo;

  // ── Kernel (agent execution kernel) ─────────────────────────────────
  /** Human-in-the-loop resolver (owned by the ApprovalManager service). */
  get approvalBroker(): ApprovalBroker {
    return this.approvals.broker;
  }
  /** Model gateway over the existing Router/Catalog (kernel port). */
  readonly modelGateway: DefaultModelGateway;
  /** Kernel runtime: agent registry + strategy registry + agent gate. */
  readonly runtime: DefaultAgentRuntime;
  /** Capability profiles synced from every catalog refresh (ModelStack). */
  get modelProfiles(): ModelCapabilityRegistry {
    return this.stack.modelProfiles;
  }

  constructor(opts: AgentOptions = {}) {
    const cfg = { ...loadConfig(), ...(opts.config ?? {}) };
    this.workspaceRoot = cfg.workspaceRoot;
    this.mcpServerConfigs = cfg.mcpServers ?? [];
    this.autoApproveFlag = cfg.autoApprove ?? false;

    this.events = opts.events ?? {};

    // ── services (review item 1) ─────────────────────────────────────────
    // ModelStack owns the providers/catalog/router/hybrid composition that
    // used to be 80 lines of constructor here.
    this.stack = new ModelStack(cfg, (msg) => this.emit("onStatus", msg));

    // ApprovalManager owns the human-in-the-loop gates (approvals +
    // clarifications) that used to be pending-promise maps here.
    this.approvals = new ApprovalManager({
      autoApprove: cfg.autoApprove ?? false,
      onApprovalRequested: (request) => this.emit("onApprovalRequested", request),
      onClarificationRequested: (request) => this.emit("onClarificationRequested", request),
      hasApprovalListener: () => !!this.events.onApprovalRequested || !!this.listeners.get("onApprovalRequested")?.size,
      hasClarificationListener: () =>
        !!this.events.onClarificationRequested || !!this.listeners.get("onClarificationRequested")?.size,
    });

    this.conversation = new AgentConversation();

    this.tools = new AgentToolManager();
    this.tools.registerBaseTools(
      cfg.workspaceRoot,
      (stream, chunk) => this.emit("onShellOutput", stream, chunk),
      { sandbox: cfg.sandbox, image: cfg.shellImage, timeoutSec: cfg.shellTimeoutSec },
    );
    this.tools.registerHybridTools(this.stack.localWorker);
    this.tools.registerClarificationTool(this);

    this.intelligence = new AgentIntelligence({
      workspaceRoot: cfg.workspaceRoot,
      languages: cfg.languages as
        Record<string, Partial<import("../lsp/registry.js").LanguageProviderConfig>> | undefined,
      lspConfig: cfg.lsp as import("../lsp/config.js").LspGlobalConfig | undefined,
      prewarm: (cfg.lsp as { prewarm?: string[] } | undefined)?.prewarm,
      onDiagnostics: (filePath, diagnostics) => {
        this.emit("onStatus", `diagnostics: ${filePath} (${diagnostics.length})`);
      },
      onServerStateChange: (servers) => {
        this.emit("onLspStateChange", servers);
      },
    });

    this.tools.registerLspTools(this.intelligence.lspManager);
    this.tools.registerRailsTools(this.intelligence.railsIndex);

    this.browser = new BrowserManager();
    this.tools.registerBrowserTools(this.browser);
    this.binanceStream = new BinanceStreamManager();
    this.tools.registerBinanceStreamTools(this.binanceStream);

    this.lspManager = this.intelligence.lspManager;
    this.railsIndex = this.intelligence.railsIndex;

    // Workspace state (memory/checkpoint/sessions/docs) lives under .nexum —
    // resolved (and migrated from legacy .devagent when present) by the
    // WorkspaceManager, the single owner of that decision (docs/REBRANDING.md §4).
    const statePaths = new WorkspaceManager(cfg.workspaceRoot).ensure();

    this.memory = new MemoryStore(statePaths.memoryDb);
    this.planCheckpoint = new CheckpointStore(statePaths.checkpoint);

    // SessionManager owns conversation persistence + summarization.
    this.sessions = new SessionManager({
      store: new SessionStore(statePaths.sessionsDir),
      memory: this.memory,
      stack: this.stack,
      onMemorySummary: (summary) => this.emit("onMemorySummary", summary),
      onError: (e) => this.emit("onError", e),
    });

    this.docs = new DocsStore(statePaths.docsDb);
    this.tools.registerDocsTools(this.docs, cfg.workspaceRoot);

    const projectLanguage = this.intelligence.railsIndex.enabled
      ? this.intelligence.railsIndex.workspace.isRails
        ? "ruby"
        : this.intelligence.railsIndex.workspace.isRuby
          ? "ruby"
          : undefined
      : undefined;

    this.learning = new AgentLearning({
      workspaceRoot: cfg.workspaceRoot,
      provider: this.stack.provider,
      memory: this.memory,
      skillsHomeDir: opts.skillsHomeDir,
      projectLanguage,
    });

    this.toolSelector = new DynamicToolSelector({
      mode: cfg.toolSelectionMode,
      maxActiveTools: cfg.maxActiveTools,
      provider: this.stack.provider,
      // LLM-mode tool selection is a classification task, not a coding one — route it
      // through the "quick" capability (an always-resident local model, falling back
      // to cloud per Router.route/routeWithFallback) instead of the primary model.
      chat: async (messages) => {
        await this.stack.ensureCatalog();
        const candidates = this.stack.catalog.modelsFor("quick");
        if (candidates.length) {
          this.emit("onStatus", `delegating task to ${candidates[0].tier}/${candidates[0].name} (tool selection)`);
        }
        return this.stack.routeWithFallback("quick", messages, { stream: false });
      },
    });

    // ── Kernel wiring: gateways, broker, runtime ────────────────────────
    this.modelGateway = new DefaultModelGateway({
      router: this.stack.router,
      catalog: this.stack.catalog,
      registry: this.stack.modelProfiles,
    });

    this.runtime = new DefaultAgentRuntime();
    this.runtime.agents.register(devAgentDescriptor());

    // ExecutionManager owns run scopes + planned missions (needs runtime
    // for its gate registry + the step runner delegating back to this Agent).
    this.execution = new ExecutionManager({
      runtime: this.runtime,
      checkpoint: this.planCheckpoint,
      runStep: (message) => this.runUserMessage(message),
      onStepChange: (step) => this.emit("onMissionStep", step),
    });
  }

  on<E extends AgentEventName>(event: E, handler: AgentEventHandler<E>): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler as (...args: unknown[]) => void);
    this.listeners.set(event, set);
    return this;
  }

  private emit<E extends AgentEventName>(event: E, ...args: Parameters<AgentEventHandler<E>>): void {
    if (event === "onToolCall") {
      this.learning.learning.recorder.onToolCall(args[0] as string, args[1] as Record<string, unknown>);
    } else if (event === "onToolResult") {
      this.learning.learning.recorder.onToolResult(args[0] as string, args[1] as Record<string, unknown>);
    } else if (event === "onError") {
      this.learning.learning.recorder.onError(args[0] as Error);
    }

    (this.events[event] as ((...a: typeof args) => void) | undefined)?.(...args);
    this.listeners.get(event)?.forEach((h) => h(...args));
  }

  async runUserMessage(userMessage: string, _priority?: PlanStep["priority"]): Promise<string> {
    const clarificationReq = this.intentResolver.checkAmbiguity(userMessage, this.projectInfo);
    if (
      clarificationReq &&
      (this.events.onClarificationRequested || this.listeners.get("onClarificationRequested")?.size)
    ) {
      const resp = await this.approvals.requestClarification(clarificationReq);
      userMessage = this.intentResolver.refinePrompt(userMessage, resp, clarificationReq.options);
      this.emit("onStatus", `refined intent: "${userMessage}"`);
    }

    const learnings = this.learning.getLearnings();
    const activatedSkills = this.learning.resolveForPrompt(userMessage);

    if (this.conversation.isEmpty()) {
      const cfg = loadConfig();
      this.conversation.init(cfg, learnings, activatedSkills);
    } else {
      const cfg = loadConfig();
      this.conversation.refreshSystemPrompt(cfg, learnings, activatedSkills);
    }

    for (const skill of activatedSkills) {
      this.conversation.injectSkill(skill);
    }
    if (activatedSkills.length) {
      this.emit(
        "onSkillsActivated",
        activatedSkills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          tags: s.tags,
          version: s.version,
          scope: s.scope,
          dir: s.dir,
          path: s.path,
        })),
      );
    }

    this.learning.learning.recorder.begin(
      userMessage,
      activatedSkills.map((skill) => skill.id),
    );

    this.conversation.pushUserMessage(userMessage);
    this.learning.appendMessage("user", userMessage);

    let lastAssistantText = "";
    let success = true;
    let episodeEnded = false;
    const finish = (terminal: Parameters<typeof this.learning.learning.onEpisodeEnd>[0], text: string): string => {
      if (!episodeEnded) {
        this.learning.learning.onEpisodeEnd(terminal, text);
        episodeEnded = true;
      }
      // Persist the transcript after every turn (not just success) so a
      // killed/restarted process can resume with the model still remembering
      // this turn — mirrors the plan checkpoint's "save progress as you go".
      this.sessions.save(this.conversation.getMessages());
      return text;
    };

    // priority no longer feeds routing (every turn now attempts "quick" first
    // unless the configured primary is cloud, see below) — kept as a
    // runUserMessage param for AgentStepRunner/Orchestrator interface
    // compatibility.
    const escalationHint = detectEscalationHint(userMessage);
    // Lookup-style prompts ("where is X defined?") NEED a tool call (search/read)
    // to answer correctly; a small model that just prose-answers instead is wrong,
    // not merely low-quality. Verified below: escalate once if that happens.
    const requiresToolEvidence = isLookupPrompt(userMessage);
    // Local to this call, not a class field: AgentStepRunner reuses the same Agent
    // across plan steps and retries, each via a fresh runUserMessage call — a class
    // field would leak escalation state across unrelated steps/retries.
    // Hybrid local+cloud routing: turns attempt the quick model first
    // (local-preferred) unless the heuristic pre-filter, self-consistency
    // divergence, or explicit hints escalate to the primary model.
    let escalated = false;
    let delegationAddendumInjected = false;
    const injectDelegationAddendum = () => {
      if (this.stack.localWorker && !delegationAddendumInjected) {
        this.conversation.pushSystemMessage(LOCAL_DELEGATION_SYSTEM_ADDENDUM);
        delegationAddendumInjected = true;
      }
    };

    // Layer-1 heuristic gate: an explicit complexity trigger (debug/architecture/
    // proof/multi-step/etc.) skips the quick-model attempt entirely instead of
    // waiting for the quick model to discover it's out of its depth and call
    // escalate_task.
    if (this.stack.heuristicRouter && !escalated) {
      const heuristic = this.stack.heuristicRouter.classify(userMessage);
      if (heuristic.decision === "cloud") {
        escalated = true;
        injectDelegationAddendum();
        this.emit("onStatus", `escalating to primary model: heuristic pre-filter matched "${heuristic.trigger}"`);
      } else if (heuristic.decision === "unknown" && !requiresToolEvidence && this.stack.selfConsistency) {
        // Self-consistency, not verbalized self-confidence: measures agreement
        // across independent samples rather than asking the model to judge its
        // own output (that approach was tried and rejected — see the comment
        // above requiresToolEvidence's verifyingLookup/verifyingRecovery usage).
        const sc = await this.stack.selfConsistency.evaluate(userMessage);
        if (sc.shouldEscalate) {
          escalated = true;
          injectDelegationAddendum();
          this.emit("onStatus", `escalating to primary model: low self-consistency agreement (${sc.score.toFixed(2)})`);
        }
      }
    }

    // Needed regardless of which capability answers this turn — e.g. a
    // direct this.provider.chat call (capability null) never goes through
    // routeWithFallback's own ensureCatalog, but DynamicToolSelector's
    // hybrid-mode tool-selection classification (line ~284) still reads
    // this.catalog.modelsFor("quick").
    await this.stack.ensureCatalog();

    // Set at the end of a turn's tool dispatch when any tool call in that turn
    // errored; read at the top of the NEXT turn's buffering decision, then reset —
    // see the "recoveredFromError"/verifying logic below.
    let previousTurnHadToolError = false;

    // ── Kernel-native execution: the think→act→observe loop itself lives in
    // the kernel's ReActStrategy now (roadmap step 1, docs/guide/kernel.md).
    // What remains here is product policy, plugged in through StrategyHooks:
    // escalation (quick→cloud), buffered verification, dynamic tool
    // selection, human approvals, and learning telemetry. Behavior parity
    // with the previously hard-coded loop is the design constraint — the
    // legacy reasoning is preserved verbatim inside the hooks.
    const hooks: StrategyHooks = {
      onTurnStart: (turnInfo) => {
        this.conversation.pruneContext();
        this.emit("onStatus", `turn ${turnInfo.turn + 1}`);
      },

      selectTools: async () => {
        const activeTools = await this.toolSelector.selectTools(
          userMessage,
          this.conversation.getMessages(),
          this.tools.registry.getTools(),
        );
        // escalate_task must always be offered while still on the local model —
        // heuristic/LLM tool-selection scoring could otherwise leave it out.
        if (!escalated && !activeTools.some((t) => t.name === "escalate_task")) {
          const escalateTool = this.tools.registry.getTools().find((t) => t.name === "escalate_task");
          if (escalateTool) activeTools.push(escalateTool);
        }
        // Symmetric: delegate_to_local must always be offered once escalated —
        // it's the primary model's way to push boilerplate back down instead of
        // spending its own tokens on it.
        if (escalated && this.stack.localWorker && !activeTools.some((t) => t.name === "delegate_to_local")) {
          const delegateTool = this.tools.registry.getTools().find((t) => t.name === "delegate_to_local");
          if (delegateTool) activeTools.push(delegateTool);
        }
        return activeTools.map((t) => t.schema);
      },

      callModel: async (turnInfo, opts) => {
        const capability: Capability | null = escalated ? escalationHint : "quick";

        // Buffer the attempt's streamed text instead of emitting it live, so a bad
        // quick-model answer can be discarded and re-run on the primary model
        // without ever hitting the UI. Two triggers: (1) a lookup-phrased question
        // answered without the required tool call, turn 0 only; (2) the PREVIOUS
        // turn's tool call errored and the quick model — instead of retrying or
        // calling escalate_task — is about to answer anyway (observed in practice:
        // a 1B model inventing an unrelated "fix" or apologizing instead of
        // escalating). Only while still unescalated; the recovery check consumes
        // and resets previousTurnHadToolError so it never leaks past this turn.
        //
        // Deliberately NOT extended to a general "self-confidence probe" for
        // plain wrong-but-confident final answers (e.g. a hard task answered
        // wrong in one shot, no error, no loop) — tried it, tested it live
        // against real minicpm5-1b: the model just says "yes I'm confident" to
        // its own garbage. A weak model's self-assessment of its own output
        // isn't trustworthy, so there's no cheap fix for that failure mode here;
        // it's an accepted residual risk (see escalate-on-hard-task benchmark
        // case in src/benchmark/cases-agentic.ts, which stays red on purpose).
        const verifyingLookup = requiresToolEvidence && turnInfo.turn === 0 && !escalated;
        const verifyingRecovery = !escalated && previousTurnHadToolError;
        previousTurnHadToolError = false;
        const verifying = verifyingLookup || verifyingRecovery;
        let buffered: string[] | null = verifying ? [] : null;
        const makeChatOpts = (): ChatOptions => ({
          stream: true,
          tools: opts.tools as ChatOptions["tools"],
          onChunk: (chunk: ChatResponse) => {
            const delta = chunk.message?.content;
            if (typeof delta === "string" && delta) {
              if (buffered) buffered.push(delta);
              else {
                lastAssistantText += delta;
                this.emit("onAssistantText", delta);
              }
            }
            const thinking = (
              chunk.message as { role: string; content: string; thinking?: string; tool_calls?: unknown[] }
            )?.thinking;
            if (typeof thinking === "string" && thinking) {
              this.emit("onThinking", thinking);
            }
          },
        });
        let chatOpts = makeChatOpts();
        let chatResponse = capability
          ? await this.stack.routeWithFallback(capability, this.conversation.getMessages(), chatOpts)
          : await this.stack.provider.chat(this.conversation.getMessages(), chatOpts);

        let assistantMessage = chatResponse.message as {
          content?: string;
          tool_calls?: Array<{ function: { name: string; arguments: any } }>;
        };

        if (verifying && !(assistantMessage.tool_calls ?? []).length) {
          this.emit(
            "onStatus",
            verifyingRecovery
              ? "escalating to primary model: previous tool call failed and the quick model answered instead of retrying or escalating"
              : "escalating to primary model: quick model answered a lookup query without calling a tool",
          );
          escalated = true;
          injectDelegationAddendum();
          buffered = null;
          chatOpts = makeChatOpts();
          chatResponse = await this.stack.provider.chat(this.conversation.getMessages(), chatOpts);
        } else if (buffered) {
          for (const delta of buffered) {
            lastAssistantText += delta;
            this.emit("onAssistantText", delta);
          }
        }

        return chatResponse;
      },

      onModelUsed: ({ response, elapsedMs }) => {
        // Router.route can silently widen its candidate pool past whatever
        // capability was requested (e.g. "quick" resolving to a cloud model
        // when no local model reports tool support) — routedTier/routedModel
        // reflect what actually answered; the direct this.provider.chat path
        // (capability null) has no Router involved, so fall back to the
        // provider's own current tier/model there.
        const routedTier = (response.routedTier as string | undefined) ?? this.stack.provider.currentTier;
        const routedModel = (response.routedModel as string | undefined) ?? this.stack.provider.currentModel;
        this.emit("onModelUsed", routedTier, routedModel);
        this.emitUsage(response, elapsedMs);
      },

      prepareToolCall: (call) => {
        const name = call.name;
        const rawArguments = call.rawArguments;
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;

        if (typeof rawArguments === "object" && rawArguments !== null) {
          args = rawArguments as Record<string, unknown>;
        } else if (typeof rawArguments === "string" && rawArguments) {
          try {
            args = JSON.parse(rawArguments);
          } catch (err) {
            parseError = err instanceof Error ? err.message : String(err);
            const parts = rawArguments.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
            args = parts as unknown as Record<string, unknown>;
          }
        }

        if (parseError) {
          return {
            args,
            guidance: `[system] Argument parsing error for tool "${name}": ${parseError}. Ensure JSON arguments match the tool schema.`,
          };
        }
        return { args };
      },

      beforeToolCall: async (call) => {
        this.emit("onToolCall", call.name, call.args);
        return true;
      },

      // Confirmation decisions originate in the gateway's policy engine
      // (parity posture: destructive shell, git push / PR creation, file
      // deletion, financial tools). This hook resolves them through the
      // existing emit-based approval UX — same titles, same deny-on-no-
      // listener default, same AUTO_APPROVE bypass — via describeConfirmation.
      resolveConfirmation: async ({ name, args, reason }) => {
        const spec = describeConfirmation(name, args, reason);
        return this.approvals.requestApproval(spec.title, spec.summary);
      },

      onToolObserved: (obs) => {
        const { name, args, result } = obs;
        const data = result.data;
        const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};

        if (record.error === "PathEscapeError") {
          this.conversation.pushToolResult(
            JSON.stringify({ error: "PathEscapeError", message: record.message }, null, 2),
          );
          this.emit("onToolResult", name, record);
          this.conversation.pushSystemMessage(
            "[system] The previous tool call escaped the workspace root. Retry with a path under the current workspace root.",
          );
          previousTurnHadToolError = true;

          if (this.loopDetector.record(name, args, "PathEscapeError")) {
            return {
              abortRun: true,
              terminal: "loop_abort",
              output: `${lastAssistantText}\n[aborted] tool loop detected after repeated escapes.`,
            };
          }
          return;
        }

        this.emit("onToolResult", name, record);
        this.intelligence.feedRailsIndex(name, args, record);
        this.conversation.pushToolResult(typeof data === "string" ? data : JSON.stringify(data, null, 2));

        if (name === "escalate_task" && record.escalate === true) {
          escalated = true;
          injectDelegationAddendum();
          this.emit("onStatus", `escalating to ${escalationHint ?? "the primary model"}: ${record.reason}`);
        }

        if (typeof record.error === "string") {
          previousTurnHadToolError = true;
          if (this.loopDetector.record(name, args, record.error)) {
            return {
              abortRun: true,
              terminal: "loop_abort",
              output: `${lastAssistantText}\n[aborted] tool loop detected after repeated: ${name}`,
            };
          }
        }
      },

      onToolFailed: ({ error }) => {
        this.emit("onError", error);
        previousTurnHadToolError = true;
      },

      finalAnswer: () => lastAssistantText,
    };

    // One kernel run per user message: the runtime applies the agent
    // concurrency gate, tracks the run for cancellation, and resolves the
    // strategy. The conversation is adapted onto the kernel's ContextManager
    // port, so the strategy reads/writes the exact same transcript.
    // NOTE: task.input stays unset on purpose — the preamble above already
    // pushed the user message (pushUserMessage keeps pruneContext's
    // current-turn bookkeeping), and a strategy-side re-push would duplicate
    // it and skew history-window heuristics (e.g. the tool selector's
    // last-3-message lookback).
    const request: ExecutionRequest = {
      agentId: "devagent",
      task: { goal: userMessage },
      strategy: "react",
      unattended: this.autoApproveFlag,
    };
    const context = createExecutionContext(request, {
      runId: this.sessions.sessionId,
      sessionId: this.sessions.sessionId,
      signal: this.execution.signal,
      context: new AgentConversationContext(this.conversation),
      modelGateway: this.modelGateway,
      toolGateway: this.tools.gateway,
    });

    try {
      const result = await this.runtime.execute(request, context, {
        hooks,
        maxToolTurns: this.maxToolTurns,
      });

      if (result.status !== "completed") {
        success = false;
        finish("error", result.output);
        const original = result.metadata?.error;
        throw original instanceof Error ? original : new Error(result.error ?? `execution ${result.status}`);
      }

      const terminal = (result.metadata?.terminal as string | undefined) ?? "answered";
      const output = result.output;
      if (terminal === "answered") {
        this.learning.appendMessage("assistant", output);
        this.sessions.triggerSummarization();
      }
      return finish(terminal as Parameters<typeof finish>[0], output);
    } catch (e) {
      success = false;
      finish("error", lastAssistantText);
      throw e;
    } finally {
      for (const skill of activatedSkills) this.learning.recordSkillUse(skill.id, success);
    }
  }

  pinSkill(id: string | null): void {
    this.learning.pinSkill(id);
  }

  getSkillsRegistry() {
    return this.learning.getSkillsRegistry();
  }

  flushLearning(): Promise<void> {
    return this.learning.flushLearning();
  }

  async runPlannedTask(steps: PlanStep[], planner: Planner): Promise<PlanStep[]> {
    // Delegated to the ExecutionManager service (review item 1): the plan's
    // concurrency gate comes from the runtime's GateRegistry, the run-scope
    // abort signal cancels cooperatively, and the checkpoint is kept for resume.
    return this.execution.runPlannedTask(steps, planner);
  }

  /**
   * Resume a plan interrupted by a crash or kill. Returns null if no
   * checkpoint exists (nothing to resume). Non-terminal step statuses are
   * reset to "pending" — the process died mid-step, so its outcome is unknown.
   */
  async resumePlannedTask(planner: Planner): Promise<PlanStep[] | null> {
    return this.execution.resumePlannedTask(planner);
  }

  hasResumablePlan(): boolean {
    return this.execution.hasResumablePlan();
  }

  /** Pauses until the TUI resolves an approval (delegates to ApprovalManager). */
  private async requestApproval(title: string, summary: string): Promise<boolean> {
    return this.approvals.requestApproval(title, summary);
  }

  /** Called by the TUI when the user presses approve/reject on a pending request. */
  resolveApproval(id: string, approved: boolean): void {
    this.approvals.resolveApproval(id, approved);
  }

  setProjectInfo(info: ProjectInfo): void {
    this.projectInfo = info;
  }

  async requestClarification(request: ClarificationRequest): Promise<ClarificationResponse> {
    return this.approvals.requestClarification(request);
  }

  resolveClarification(response: ClarificationResponse): void {
    this.approvals.resolveClarification(response);
  }

  /** Entry point for /plan: decomposes `goal` into steps via the model, then
   * runs them through the real Orchestrator (topological + concurrent
   * execution, retry, model-driven replan on failure, rollback) — not a
   * canned "write me a plan" chat message. Resumes an interrupted plan
   * instead of starting a new one when `goal` is empty and a checkpoint
   * exists. */
  async runPlan(goal: string): Promise<PlanStep[]> {
    const planner: Planner = { replan: (remaining, history) => replanSteps(remaining, history, this.stack.provider) };

    if (!goal.trim() && this.hasResumablePlan()) {
      // Understand/Inspect have no distinct signal of their own (both happen
      // inside ordinary tool-call exploration before /plan is invoked) — mark
      // them completed the instant Plan starts rather than fabricate a fake
      // boundary between them. See runtime/types.ts's MissionState doc comment.
      this.emit("onMissionStarted", "(resumed plan)");
      this.emit("onMissionPhase", "understand", "completed");
      this.emit("onMissionPhase", "inspect", "completed");
      this.emit("onMissionPhase", "plan", "completed");
      this.emit("onMissionPhase", "execute", "running");
      const resumed = await this.resumePlannedTask(planner);
      if (resumed) {
        const failed = resumed.some((s) => s.status === "failed");
        this.emit("onMissionPhase", "execute", failed ? "failed" : "completed");
        this.emit("onMissionPhase", "complete", failed ? "failed" : "completed");
        this.emit("onPlanUpdate", "(resumed plan)", resumed, failed ? "failed" : "completed");
        return resumed;
      }
    }

    this.emit("onMissionStarted", goal);
    this.emit("onMissionPhase", "understand", "completed");
    this.emit("onMissionPhase", "inspect", "completed");
    this.emit("onMissionPhase", "plan", "running");
    const steps = await generatePlan(goal, this.stack.provider);
    this.emit("onMissionPhase", "plan", "completed");
    this.emit("onPlanUpdate", goal, steps, "running");
    this.emit("onMissionPhase", "execute", "running");
    const finalSteps = await this.runPlannedTask(steps, planner);
    const failed = finalSteps.some((s) => s.status === "failed");
    this.emit("onMissionPhase", "execute", failed ? "failed" : "completed");
    this.emit("onMissionPhase", "complete", failed ? "failed" : "completed");
    this.emit("onPlanUpdate", goal, finalSteps, failed ? "failed" : "completed");
    return finalSteps;
  }

  setModel(model: string): void {
    this.stack.setModel(model);
    this.conversation.reset();
  }

  setModelWithoutReset(model: string): void {
    this.stack.setModel(model);
  }

  // ponytail: keyword classification, not an LLM intent classifier — cheap and
  // deterministic. These patterns pick the ESCALATION TARGET for when the model
  // self-escalates via the escalate_task tool, reusing Router's existing vision/reasoning routing.
  private static readonly VISION_PATTERN = /\b(screenshot|diagram|image|photo|picture)\b|\.(png|jpe?g|gif|webp)\b/;
  private static readonly REASONING_PATTERN =
    /\b(architecture|trade-?offs?|root cause|design decision|why does|why is|think through|deep dive)\b/;
  // Read-only lookup/classification phrasing — still used below to require tool
  // evidence on quick-routed lookup turns (a prose-only answer is wrong, not
  // just low quality).
  private static readonly LOOKUP_PATTERN =
    /\b(where is|where's|find the|show me|list the|which file|how many|what does .* do)\b/;

  private detectEscalationHint(text: string): "vision" | "reasoning" | null {
    const desc = text.toLowerCase();
    if (Agent.VISION_PATTERN.test(desc)) return "vision";
    if (Agent.REASONING_PATTERN.test(desc)) return "reasoning";
    return null;
  }

  addLearning(category: string, context: string, lesson: string): void {
    this.learning.addLearning(category, context, lesson);
  }

  async validateModel(): Promise<true | string> {
    return this.stack.validateModel();
  }

  setTier(tier: "local" | "cloud"): void {
    this.stack.setTier(tier);
  }

  setRuntimeHost(host: string): void {
    this.stack.setRuntimeHost(host);
  }

  get currentModel(): string {
    return this.stack.currentModel;
  }

  get currentTier(): string {
    return this.stack.currentTier;
  }

  async listModels(): Promise<string[]> {
    return this.stack.listModels();
  }

  modelAvailability(models: string[]): Record<string, boolean> {
    return this.stack.modelAvailability(models);
  }

  async modelCapabilities(models: string[]): Promise<Record<string, Capability[]>> {
    return this.stack.modelCapabilities(models);
  }

  resetContext(): void {
    this.conversation.reset();
    this.sessions.reset();
  }

  hasResumableSession(): boolean {
    return this.sessions.hasResumableSession();
  }

  /** Lists past conversations, most recently updated first, for a session
   * history picker. */
  listSessions(): SessionMeta[] {
    return this.sessions.listSessions();
  }

  /** Restores the most recently persisted conversation transcript, e.g. after
   * a crash/restart. Returns the restored messages (for replaying into the
   * TUI's visible chat log) or null if there was nothing to resume. */
  resumeSession(): ChatMessage[] | null {
    const saved = this.sessions.resumeSession();
    if (saved) this.conversation.loadMessages(saved);
    return saved;
  }

  /** Restores a specific past conversation by session id, e.g. from the
   * session history picker. */
  resumeSessionById(id: string): ChatMessage[] | null {
    const saved = this.sessions.resumeSessionById(id);
    if (saved) this.conversation.loadMessages(saved);
    return saved;
  }

  // Ollama's /api/chat response carries eval_count/prompt_eval_count/eval_duration
  // (nanoseconds) untyped through ChatResponse's index signature — read them here
  // rather than widening the shared type for fields only this call site needs.
  private emitUsage(response: { [key: string]: unknown }, latencyMs: number): void {
    const promptTokens = response.prompt_eval_count as number | undefined;
    const completionTokens = response.eval_count as number | undefined;
    const evalDurationNs = response.eval_duration as number | undefined;
    if (typeof promptTokens !== "number" && typeof completionTokens !== "number") return;
    const tokensPerSecond =
      typeof completionTokens === "number" && typeof evalDurationNs === "number" && evalDurationNs > 0
        ? completionTokens / (evalDurationNs / 1e9)
        : 0;
    this.emit("onUsage", {
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      tokensPerSecond,
      latencyMs,
    });
  }

  getRegistry() {
    return this.tools.registry;
  }

  /**
   * Kernel view of this agent: the runtime (agent + strategy registries),
   * the model gateway, the tool gateway, and the approval broker. Products
   * embedding the Agent programmatically should prefer this over reaching
   * into the individual subsystems.
   */
  getKernel() {
    return {
      runtime: this.runtime,
      modelGateway: this.modelGateway,
      toolGateway: this.tools.gateway,
      toolCatalog: this.tools.kernelCatalog,
      approvalBroker: this.approvalBroker,
      mountedPacks: [...this.tools.mountedPacks.keys()],
    };
  }

  /** Opens a run scope: a run id + an abort signal wired into every
   * gateway-supervised tool call issued during this scope. */
  startExecutionRun(): string {
    return this.execution.startExecutionRun();
  }

  /** Cancels the in-flight run scope: supervised tool calls observe the
   * abort and unwinds as cancelled (never a hard kill). */
  cancelExecutionRun(): boolean {
    return this.execution.cancelExecutionRun();
  }

  endExecutionRun(): void {
    this.execution.endExecutionRun();
  }

  async registerMcpServer(command: string, args: string[] = []): Promise<void> {
    await this.tools.registerMcpServer(command, args);
  }

  /** Connects every MCP server listed in config.mcpServers, one at a time
   * (each spawns a subprocess). Never throws — a server that fails to start
   * shows up as `connected: false` rather than aborting the others or the
   * TUI's own startup. */
  async connectConfiguredMcpServers(): Promise<McpServerState[]> {
    const results: McpServerState[] = [];
    for (const server of this.mcpServerConfigs) {
      const start = Date.now();
      try {
        const tools = await this.tools.registerMcpServer(server.command, server.args ?? []);
        results.push({
          name: server.name,
          connected: true,
          latencyMs: Date.now() - start,
          tools: tools.map((t) => t.name),
          errors: 0,
        });
      } catch {
        results.push({ name: server.name, connected: false, latencyMs: Date.now() - start, tools: [], errors: 1 });
      }
    }
    return results;
  }
}
