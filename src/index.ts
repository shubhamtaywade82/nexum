/**
 * @nemesis-oss/nexum — the intentional public API (review item 38).
 *
 * Stable primitives only:
 *   AgentRuntime · Agent · Task · Tool · ToolGateway · ModelGateway ·
 *   PolicyEngine · ExecutionContext · ExecutionStrategy
 * plus the tool packs products mount and the product agents.
 *
 * Implementation modules stay private: the deep surface (providers,
 * strategies, stores, scheduler internals, domain tools) is reachable
 * through the plane subpath exports (./core ./runtime ./models ./tools
 * ./mcp ./orchestration ./evolution) for advanced embedding, but the
 * package root is the supported, semver-stable surface.
 *
 * Dependency direction (review item 40):
 *   ollama-sdk → Nexum Core (this package's planes) → DevAgent / CryptoAgent
 */

// ── Stable runtime primitives ───────────────────────────────────────────────
export type {
  AgentRuntime,
  TaskSpec as Task,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStatus,
  ExecutionBudget,
  ExecutionContext,
  StrategyName,
  StrategyExecuteOptions,
  EventSink,
  ContextManager,
} from "./core/types.js";

export {
  // runtime facade
  DefaultAgentRuntime,
  AgentRegistry,
  StrategyRegistry,
  defaultStrategyRegistry,
  devAgentDescriptor,
  type AgentDescriptor,
  // strategies (review item 3)
  ReActStrategy,
  PlanExecuteStrategy,
  GraphStrategy,
  type ExecutionStrategy,
  // execution contexts (review item 15)
  createExecutionContext,
  createManagedExecutionContext,
  childExecutionContext,
  // budgets (review item 14)
  BudgetManager,
  BudgetTracker,
  // durable execution history (review item 13)
  ExecutionEventStore,
  ExecutionRecorder,
} from "./runtime/index.js";

// ── Tool plane primitives ───────────────────────────────────────────────────
export { DefaultToolGateway, type ToolGateway } from "./tools/gateway/tool-gateway.js";
export { ToolCatalog } from "./tools/gateway/tool-catalog.js";
export type {
  ToolDefinition as Tool,
  ToolResult,
  ToolInvocation,
  ToolRisk,
  ToolCallContext,
  ToolSideEffects,
  ToolExecutionSpec,
  ToolPolicySpec,
  ToolNetworkRequirements,
} from "./core/tools/tool-contract.js";
export { mountToolPack, defineToolPack, packOf, type ToolPack, type ToolPackEntry } from "./tools/gateway/tool-pack.js";

// ── Policy plane (review items 7, 8) ────────────────────────────────────────
export {
  RulePolicyEngine,
  AllowAllPolicyEngine,
  type PolicyEngine,
  type PolicyRequest,
  type PolicyDecision,
} from "./core/policy/policy-engine.js";
export {
  executionProfile,
  executionProfileByName,
  tradingProfile,
  EXECUTION_PROFILES,
  type ExecutionProfile,
  type ExecutionProfileName,
  type TradingExecutionMode,
} from "./core/policy/execution-profiles.js";
export { profilePosture } from "./core/policy/postures.js";

// ── Model plane primitives (review item 18) ─────────────────────────────────
export { DefaultModelGateway, type ModelGateway } from "./models/gateway/model-gateway.js";
export type {
  ModelRouter,
  ModelSelection,
  RouteRequest,
  RouteConstraints,
  RoutePreferences,
  RoutingDimension,
  SelectionReason,
} from "./models/router/model-selection.js";
export { ScoredModelRouter, estimateCost } from "./models/router/scored-router.js";
export type { ProviderAdapter } from "./models/router/model-selection.js";
export { CAPABILITY_WEIGHTS } from "./models/router/model-selection.js";

// ── The application-level Agent (CLI/TUI composition root) ──────────────────
export { Agent, type AgentEvents, type AgentOptions } from "./cli/agent.js";
export { startRpcServer, type RpcCliOptions } from "./cli/rpc.js";

// ── Tool packs (products mount these) ───────────────────────────────────────
export {
  filesystemPack,
  processPack,
  gitPack,
  githubPack,
  lspPack,
  browserPack,
  docsPack,
  tradingPack,
  rubyPack,
  railsPack,
  databasePack,
  agentCorePack,
} from "./tools/packs/index.js";

// ── Product agents (review item 40) ─────────────────────────────────────────
export { DevAgent, DEVAGENT_DESCRIPTOR, CryptoAgent, cryptoAgentDescriptor } from "./agents/index.js";

// ── Agent-harness primitives (plugin system, services, capabilities) ────────
// These are the new agent-runtime primitives that bring Nexum to parity with
// DeepSeek Harness without rewriting the kernel. See:
//   - src/platform/plugins/      Plugin/Composition system (P0-1)
//   - src/core/capabilities/     Capability-based DI (P0-2)
//   - src/core/services/         Unified Service Registry (P0-3)
//   - src/skills/                Formal Skill system (P0-4)
//   - src/subagents/             Formal Subagent service (P0-5)
//   - src/jobs/                  Job service (P0-6)
//   - src/compaction/            Compaction service (P0-7)
//   - src/session-query/         Session query/trace service (P0-8)
//   - src/context-providers/     Context provider framework (P1-9)
//   - src/credentials/           Credential service (P1-10)
//   - src/attachments/           Attachment store (P1-11)
//   - src/workflow/              Workflow service (P1-12)
//   - src/webhooks/              Webhook/event ingress (P1-13)
//   - src/web-service/           Web service (P1-14)
//   - src/rpc/                   RPC/JSON-RPC agent server (P1-15)

// Plugin system
export {
  DefaultPluginHost,
  PluginRegistry,
  validateManifest,
  resolvePluginOrder,
  definePlugin,
  pluginFromRegistration,
  minimalProfile,
  standardProfile,
  fullProfile,
  type NexumPlugin,
  type PluginManifest,
  type PluginContext,
  type PluginHost,
  type PluginHostOptions,
  type PluginProfile,
  type PluginId,
  type PluginRecord,
  type PluginState,
  type ResolveResult,
} from "./platform/plugins/index.js";

// Capability DI
export {
  defineCapabilityToken,
  CapabilityRegistry,
  PLUGIN_HOST,
  type CapabilityToken,
} from "./core/capabilities/index.js";

// Service registry
export {
  ServiceRegistry,
  type ServiceToken,
  type ServiceRecord,
  type ServiceState,
  type ServiceLifecycle,
} from "./core/services/index.js";

// Formal Skill system
export {
  SkillSystem,
  FilesystemSkillProvider,
  InMemorySkillProvider,
  SkillLoader,
  SkillCatalog,
  SkillSelector,
  SkillInjector,
  type SkillProvider,
  type SkillSelectionInput,
  type SkillSelection,
  type SkillInjection,
} from "./skills/index.js";

// Subagent service
export {
  SubagentService,
  InProcessSubagentProvider,
  ProcessSubagentProvider,
  ACPSubagentProvider,
  SDKSubagentProvider,
  ExternalAgentSubagentProvider,
  defaultSubagentProviders,
  type SubagentProvider,
  type SubagentSpawnRequest,
  type SubagentHandle,
  type SubagentResult,
  type SubagentState,
  type SubagentProviderType,
  type SubagentServiceOptions,
} from "./subagents/index.js";

// Job service
export {
  JobService,
  type JobSpec,
  type JobId,
  type JobRecord,
  type JobState,
  type JobPriority,
  type JobListFilter,
  type JobServiceOptions,
} from "./jobs/index.js";

// Compaction service
export {
  CompactionService,
  CompactionPolicy,
  TokenEstimator,
  RuleBasedSummaryProvider,
  HistoryReducer,
  ContextRebuilder,
  type ConversationMessage,
  type CompactionInput,
  type CompactionDecision,
  type CompactionResult,
  type SummaryProvider,
  type CompactionPolicyOptions,
  type CompactionServiceOptions,
} from "./compaction/index.js";

// Session query service
export {
  SessionQueryService,
  type EventReadFilter,
  type EventReadResult,
  type EventSearchResult,
  type ToolCallTrace,
  type SessionTrace,
  type SessionSearchResult,
  type SessionQueryServiceOptions,
} from "./session-query/index.js";

// Context providers
export {
  ContextService,
  WorkspaceContextProvider,
  FileReferenceProvider,
  SessionReferenceProvider,
  TimeContextProvider,
  RuntimeContextProvider,
  GitContextProvider,
  DomainContextProvider,
  defaultContextProviders,
  type ContextProvider,
  type ContextFragment,
  type ContextFragmentKind,
  type ContextContributionInput,
  type ContextAssemblyResult,
  type ContextServiceOptions,
} from "./context-providers/index.js";

// Credential service
export {
  CredentialService,
  EnvCredentialProvider,
  FileCredentialProvider,
  KeychainCredentialProvider,
  VaultCredentialProvider,
  ScopedCredentialService,
  redact,
  defaultCredentialProviders,
  type CredentialSpec,
  type CredentialRecord,
  type CredentialScope,
  type CredentialProvider,
  type CredentialServiceOptions,
} from "./credentials/index.js";

// Attachment store
export {
  AttachmentStore,
  hashContent,
  storeFile,
  guessMediaType,
  type AttachmentId,
  type AttachmentMediaType,
  type AttachmentRecord,
  type AttachmentStoreOptions,
} from "./attachments/index.js";

// Workflow service
export {
  WorkflowService,
  type WorkflowDefinition,
  type WorkflowInstance,
  type WorkflowStep,
  type WorkflowStepContext,
  type WorkflowStepResult,
  type WorkflowEvent,
  type WorkflowCheckpoint,
  type WorkflowTrigger,
  type WorkflowInstanceState,
  type WorkflowServiceOptions,
} from "./workflow/index.js";

// Webhook service
export {
  WebhookService,
  type WebhookEndpoint,
  type WebhookEvent,
  type WebhookRule,
  type WebhookServiceOptions,
} from "./webhooks/index.js";

// Web service
export {
  WebService,
  NodeFetchProvider,
  SimpleWebContentExtractor,
  StubSearchProvider,
  DuckDuckGoSearchProvider,
  FileSearchProvider,
  defaultWebService,
  type WebSearchResult,
  type WebFetchResult,
  type WebContentExtraction,
  type SearchProvider,
  type FetchProvider,
  type HttpProvider,
  type BrowserProvider,
  type WebContentExtractor,
} from "./web-service/index.js";

// RPC server
export {
  RpcServer,
  registerCoreMethods,
  registerJobMethods,
  registerSubagentMethods,
  registerWorkflowMethods,
  registerWebhookMethods,
  registerControlPlaneMethods,
  registerAllServiceMethods,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type RpcMethodHandler,
  type RpcContext,
  type RpcServerOptions,
} from "./rpc/index.js";

// ── P2 — Productization primitives ─────────────────────────────────────────
//   - src/settings/            Settings service (P2-16)
//   - src/profiles/            Profile/bundle system (P2-17)
//   - src/marketplace/         Plugin marketplace (P2-18)
//   - src/control-plane/       Runtime observability + control (P2-19)

// Settings service
export {
  SettingsService,
  registerDefaultSpecs,
  type SettingSpec,
  type SettingValue,
  type SettingNamespace,
  type SettingUpdate,
  type SettingsChangeEvent,
  type SettingsServiceOptions,
} from "./settings/index.js";

// Profile/bundle system
export {
  ProfileRegistry,
  ProfileLoader,
  ProfileComposer,
  ProfileResolver,
  cliProfileBundle,
  serverProfileBundle,
  cryptoBotProfileBundle,
  registerBuiltinProfiles,
  type ProfileBundle,
  type ProfileRecord,
  type ComposedProfile,
  type ProfileLoaderOptions,
} from "./profiles/index.js";

// Plugin marketplace
export {
  MarketplaceService,
  HttpMarketplaceSource,
  NpmMarketplaceSource,
  GitMarketplaceSource,
  type MarketplaceEntry,
  type InstalledPlugin,
  type MarketplaceSource,
  type MarketplaceServiceOptions,
  type GitMarketplaceSourceOptions,
  type NpmMarketplaceSourceOptions,
} from "./marketplace/index.js";

// Control plane (observability + control)
export {
  ControlPlaneService,
  registerDefaultMetrics,
  type MetricSpec,
  type MetricSnapshot,
  type MetricType,
  type HealthCheck,
  type HealthReport,
  type HealthStatus,
  type RuntimePhase,
  type RuntimeStatus,
  type ControlAction,
  type ControlRequest,
  type ControlResponse,
} from "./control-plane/index.js";

// ── Nexum Local Host: the HTTP+SSE transport (docs/plan Phase 0 + 1) ───────
export {
  type NexumSessionMeta,
  type NexumRun,
  type NexumRunStatus,
  type NexumRunEvent,
  type NexumPlanStepView,
  type NexumCapabilities,
  type CreateRunRequest,
  CreateRunRequestSchema,
  PROTOCOL_VERSION,
} from "./protocol/types.js";
export { createNexumHost, type NexumHost, type NexumHostOptions } from "./host/index.js";
export { startNexumServer, type ServeCliOptions } from "./cli/serve.js";
