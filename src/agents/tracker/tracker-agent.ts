/**
 * Tracker — MAC v1 role agent (ADR-0001, SPEC §4.1).
 *
 * P1 registered the ROLE (inert, capability-scoped AgentDescriptor). P3
 * (ROADMAP "Tracker agent", issue #81) adds the BEHAVIOR:
 *
 *   - deterministic collectors (`collectors.ts`) gather repository, test,
 *     CI, agent-trace, task-status and budget facts through narrow ports —
 *     the LLM layer only summarizes what they return;
 *   - `collect()` anchors every collector result as immutable evidence via
 *     the `EvidenceAnchor` port and assembles a schema-validated
 *     `TrackerReport` under the SPEC §4.1 grounding rules (`contracts.ts`);
 *   - the tool surface is read-only BY CONSTRUCTION, enforced at BOTH
 *     SPEC §8.2 enforcement points:
 *       1. pack mounting — the catalog mounts read-class tools only
 *          (write/execute/network tools are filtered at mount time), and
 *       2. `trackerReadOnlyPosture()` — a RulePolicyEngine that denies any
 *          mutating tool at the policy layer even if one leaks into the
 *          catalog (defense in depth; asserted in tests, not prompts).
 *     Unattended runs additionally require the explicit read-only grant in
 *     `TRACKER_UNATTENDED_POLICY` (authorization ≠ approval).
 *
 * Pack scoping (SPEC §8.1 capability matrix row "tracker"):
 *   - filesystem  → read/list/search only (corrected read-class metadata)
 *   - git         → `git_read` verb only (READ_ONLY_SUBCOMMANDS in-tool)
 *   - history     → session search/events/trace + artifact reads
 *   - memory      → memory recall (read-class) — `memory_save` never mounts
 *   - github      → not mounted in P3; CI status arrives through the
 *                   injected `CiStatusPort` (governed read-only GET in P5)
 *
 * The generic `readonly` execution profile denies process-spawning READ
 * tools (`git_read` spawns git), which the tracker's matrix row explicitly
 * grants ("Read repository: Yes, via governed read-only git verbs") — so the
 * posture here is a dedicated rule with the same deny-first engine rather
 * than `profilePosture("readonly")`. Everything mutating is still denied.
 *
 * Layering: src/agents/tracker/** must not import orchestration, ui or
 * domains (tests/architecture/mission-layering.test.ts).
 */

import type { AgentDescriptor } from "../../runtime/agent/agent-runtime.js";
import { DefaultToolGateway, type ToolGateway } from "../../tools/gateway/tool-gateway.js";
import { ToolCatalog } from "../../tools/gateway/tool-catalog.js";
import type { ToolDefinition } from "../../core/tools/tool-contract.js";
import type { PolicyDecision, PolicyRequest, PolicyRule } from "../../core/policy/policy-engine.js";
import { RulePolicyEngine } from "../../core/policy/policy-engine.js";
import { withUnattendedPolicy, type UnattendedPolicy } from "../../core/policy/unattended-policy.js";
import { ReadFileTool } from "../../tools/filesystem.js";
import { ListDirectoryTool } from "../../tools/directory-tools.js";
import { SearchCodeTool } from "../../tools/search-tools.js";
import { GitReadTool } from "../../tools/git-tools.js";
import { SessionEventsTool, SessionSearchTool, SessionTraceTool } from "../../tools/session-history-tools.js";
import { ArtifactReadTool } from "../../tools/artifact-tools.js";
import { MemoryRecallTool } from "../../tools/memory-tools.js";
import { toGuard } from "../../tools/path-utils.js";
import type { SessionQueryService } from "../../session-query/index.js";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { SemanticMemory } from "../../memory/semantic/semantic-memory.js";
import {
  AgentTraceCollector,
  BudgetCollector,
  CiStatusCollector,
  GitStateCollector,
  TaskGraphCollector,
  TestResultsCollector,
  DEFAULT_STALE_AFTER_MS,
  gitReadPort,
  type AgentTracePort,
  type BudgetSnapshotPort,
  type CiStatusPort,
  type EvidenceAnchor,
  type GitReadPort,
  type ObservationCollector,
  type RunResultsPort,
  type TaskGraphSnapshotPort,
} from "./collectors.js";
import {
  assembleTrackerReport,
  evidenceRefSchema,
  type Blocker,
  type DetectedChange,
  type DroppedEntry,
  type EvidenceRef,
  type EvidenceRefResolverLike,
  type Observation,
  type TrackerReport,
} from "./contracts.js";

/** SPEC §4.1 registration block — postures verbatim (P1, unchanged). */
export function trackerDescriptor(): AgentDescriptor {
  return {
    id: "tracker",
    displayName: "Mission Tracker",
    description: "Observes repository, tests, CI, agent traces and budgets; publishes evidence-grounded observations.",
    defaultCapability: "tools",
    defaultStrategy: "react",
    capabilities: ["observe", "evidence-collection", "mission-reporting"],
    allowedPackIds: ["filesystem", "search", "git", "github", "history", "memory", "agent-core"],
    allowedPolicies: ["readonly", "restricted"],
    requiredTools: [], // no writes, no shell
    supportedStrategies: ["react", "plan_execute"],
  };
}

// ── Read-only enforcement, point 2: policy posture (SPEC §8.2) ──────────────

/**
 * Process-spawning tools the tracker may run: the governed read-only git
 * verbs only (`git_read` enforces status/diff/log/show/blame/rev-parse
 * in-tool and blocks program-running flags). Everything else that spawns
 * processes, touches the network or mutates state is denied.
 */
const TRACKER_READ_PROCESS_TOOLS = new Set(["git_read"]);

/**
 * SPEC §8.1 tracker row as a policy rule: reads only. Denies every
 * filesystem/external/financial mutation, every process spawn outside the
 * governed read-only git verbs, and all network egress. Runs inside
 * RulePolicyEngine's deny-first chain, so no later rule can widen it.
 */
export class TrackerReadOnlyRule implements PolicyRule {
  readonly id = "tracker-read-only";
  readonly description =
    "SPEC §8.1 tracker row: reads only — denies filesystem/external/financial mutation, process spawning outside governed read-only git verbs, and network egress.";

  evaluate(request: PolicyRequest): PolicyDecision | null {
    const tool = request.tool;
    const s = tool.sideEffects;
    const mutating =
      s.filesystem ||
      s.externalMutation ||
      s.financial ||
      s.network ||
      (s.process && !TRACKER_READ_PROCESS_TOOLS.has(tool.id));
    if (!mutating) return null;
    return {
      allowed: false,
      requireConfirmation: false,
      reason: `tracker is read-only (SPEC §8.1): tool "${tool.id}" can mutate state or reach the network`,
      rule: this.id,
    };
  }
}

/** The tracker's policy engine: deny-first read-only posture. */
export function trackerReadOnlyPosture(): RulePolicyEngine {
  return new RulePolicyEngine({
    rules: [new TrackerReadOnlyRule()],
    // Reads never confirm; anything mutating is already denied above.
    requireConfirmationFor: "critical",
  });
}

/**
 * The tracker's unattended grant (review: authorization ≠ approval). Lists
 * exactly the read-class surface the tracker needs to observe — nothing
 * else is permitted for unattended runs, and the read-only posture above
 * still denies anything mutating first. Host-process execution is granted
 * ONLY because the permitted list contains `git_read` (governed read-only
 * git verbs, enforced in-tool); network stays off (SPEC §8.1 tracker row).
 */
export const TRACKER_UNATTENDED_POLICY: UnattendedPolicy = {
  permittedTools: [
    "read_file",
    "list_directory",
    "search_code",
    "git_read",
    "session_search",
    "session_events",
    "session_trace",
    "artifact_read",
    "memory_recall",
  ],
  maxRisk: "read",
  allowHostProcess: true, // git_read only — the permitted list is exhaustive
  allowNetwork: false,
  allowExternalMutation: false,
};

// ── Read-only enforcement, point 1: mount-time filtering (SPEC §8.2) ────────

/** Read-class metadata correction for pure-reader tools whose category inference marks them mutating. */
const READ_META = {
  risk: "read" as const,
  sideEffects: { filesystem: false, process: false, network: false, externalMutation: false, financial: false },
  policy: { confirmation: "never" as const },
};

/** What the tracker's catalog is allowed to expose at all (SPEC §8.2 point 1). */
function isTrackerVisibleTool(d: ToolDefinition): boolean {
  const s = d.sideEffects;
  return (
    d.risk === "read" &&
    !s.filesystem &&
    (s.process === false || TRACKER_READ_PROCESS_TOOLS.has(d.id)) &&
    !s.network &&
    !s.externalMutation &&
    !s.financial
  );
}

/**
 * Build the tracker's catalog: read-class tools only, with corrected
 * metadata for pure readers (the category-based inference marks read_file/
 * list_directory mutating; the same correction the git pack applies to
 * `git_read`). The constructor-time invariant fails closed if a future
 * entry would expose a mutating tool.
 */
export function trackerReadOnlyCatalog(opts: {
  workspaceRoot: string;
  sessionQuery?: SessionQueryService;
  artifacts?: ArtifactStore;
  memory?: SemanticMemory;
}): ToolCatalog {
  const catalog = new ToolCatalog();
  const guard = toGuard(opts.workspaceRoot);

  catalog.registerLegacy(new ReadFileTool(guard), "Filesystem", READ_META);
  catalog.registerLegacy(new ListDirectoryTool(guard), "Filesystem", READ_META);
  catalog.registerLegacy(new SearchCodeTool(guard), "Search", READ_META);
  catalog.registerLegacy(new GitReadTool(opts.workspaceRoot), "Git", {
    ...READ_META,
    sideEffects: { ...READ_META.sideEffects, process: true }, // governed read-only verbs, enforced in-tool
  });

  if (opts.sessionQuery) {
    const query = opts.sessionQuery;
    for (const tool of [new SessionSearchTool(query), new SessionEventsTool(query), new SessionTraceTool(query)]) {
      catalog.registerLegacy(tool, "Memory", READ_META);
    }
  }
  if (opts.artifacts) {
    catalog.registerLegacy(new ArtifactReadTool(opts.artifacts), "Memory", READ_META);
  }
  if (opts.memory) {
    catalog.registerLegacy(new MemoryRecallTool(opts.memory), "Memory", READ_META);
  }

  // Mount invariant (fail-closed): the tracker must never even SEE a
  // mutating tool. A violation is a construction error, not a runtime risk.
  for (const entry of catalog.all()) {
    if (!isTrackerVisibleTool(entry.definition)) {
      throw new Error(
        `tracker read-only mount invariant violated: tool "${entry.definition.id}" (risk "${entry.definition.risk}") is not read-class`,
      );
    }
  }
  return catalog;
}

// ── The agent ───────────────────────────────────────────────────────────────

export interface TrackerAgentOptions {
  /** Workspace the tracker observes (also mounts its read-only git/file surface). */
  workspaceRoot: string;
  /** Governed read-only git port; defaults to `gitReadPort(workspaceRoot)`. */
  git?: GitReadPort;
  /** Recorded run results source (test/build outcomes). */
  runResults?: RunResultsPort;
  /** CI status source (governed read-only queries; P5 wires GitHub GET). */
  ci?: CiStatusPort;
  /** Agent trace source (run logs / session_events). */
  traces?: AgentTracePort;
  /** TaskGraph snapshot source (task status + dependency progress). */
  taskGraph?: TaskGraphSnapshotPort;
  /** Budget / telemetry snapshot source. */
  budget?: BudgetSnapshotPort;

  /**
   * Persists each collector result as immutable evidence and returns the
   * citation ref. Required for `collect()` — without anchoring, no
   * observation could carry resolvable evidence (fail-closed).
   */
  evidenceAnchor?: EvidenceAnchor;
  /** Resolves evidence refs; unresolvable refs drop their observation (§4.1 rule 2). */
  resolver?: EvidenceRefResolverLike;
  /** Drop log sink; dropped entries are also returned from collect(). */
  log?: (entry: DroppedEntry) => void;

  // Read-only gateway surface (LLM summarization layer, P5 wiring):
  sessionQuery?: SessionQueryService;
  artifacts?: ArtifactStore;
  memory?: SemanticMemory;
}

export type TrackerCollectResult =
  { ok: true; report: TrackerReport; dropped: DroppedEntry[] } | { ok: false; reason: string };

/**
 * The Tracker's deterministic observation path: run the collectors, anchor
 * their results as evidence, assemble + validate the TrackerReport. No
 * model call anywhere — grounding rule 1 by construction.
 */
export class TrackerAgent {
  readonly descriptor: AgentDescriptor;
  /** Read-only tool gateway (mount-filtered catalog + read-only posture). */
  readonly gateway: ToolGateway;
  /** Deterministic collectors, in the SPEC §4.1 responsibility order. */
  readonly collectors: readonly ObservationCollector[];

  private readonly evidenceAnchor?: EvidenceAnchor;
  private readonly resolver?: EvidenceRefResolverLike;
  private readonly log?: (entry: DroppedEntry) => void;

  constructor(opts: TrackerAgentOptions) {
    this.descriptor = trackerDescriptor();
    this.evidenceAnchor = opts.evidenceAnchor;
    this.resolver = opts.resolver;
    this.log = opts.log;

    const catalog = trackerReadOnlyCatalog({
      workspaceRoot: opts.workspaceRoot,
      ...(opts.sessionQuery !== undefined ? { sessionQuery: opts.sessionQuery } : {}),
      ...(opts.artifacts !== undefined ? { artifacts: opts.artifacts } : {}),
      ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
    });
    this.gateway = new DefaultToolGateway({
      catalog,
      policyEngine: withUnattendedPolicy(trackerReadOnlyPosture(), TRACKER_UNATTENDED_POLICY),
      validation: "strict",
      label: "tracker:readonly",
    });

    // Deterministic collector order: repository → tests → ci → traces →
    // tasks → resources (SPEC §4.1 responsibilities, stable for audit).
    const collectors: ObservationCollector[] = [new GitStateCollector(opts.git ?? gitReadPort(opts.workspaceRoot))];
    if (opts.runResults) collectors.push(new TestResultsCollector(opts.runResults));
    if (opts.ci) collectors.push(new CiStatusCollector(opts.ci));
    if (opts.traces) collectors.push(new AgentTraceCollector(opts.traces));
    if (opts.taskGraph) collectors.push(new TaskGraphCollector(opts.taskGraph));
    if (opts.budget) collectors.push(new BudgetCollector(opts.budget));
    this.collectors = collectors;
  }

  /**
   * Observe now: run every collector, anchor evidence, assemble the report.
   * Never throws for expected failure modes — failures become blockers and
   * the report ships (SPEC §4.1 failure honesty); only contract bugs
   * (schema violations) surface as `{ ok: false }`.
   */
  async collect(input: { missionId: string; now?: string }): Promise<TrackerCollectResult> {
    if (!this.evidenceAnchor) {
      return {
        ok: false,
        reason:
          "no evidence anchor configured: a tracker report without resolvable evidence must not exist (SPEC §4.1 rule 2, fail-closed)",
      };
    }
    const nowMs = input.now !== undefined ? Date.parse(input.now) : Date.now();
    if (Number.isNaN(nowMs)) {
      return { ok: false, reason: `invalid clock input: ${String(input.now)}` };
    }
    const now = new Date(nowMs).toISOString();

    const observations: Observation[] = [];
    const detectedChanges: DetectedChange[] = [];
    const blockers: Blocker[] = [];

    const outcomes = await Promise.all(this.collectors.map((c) => c.collect()));
    for (let i = 0; i < this.collectors.length; i++) {
      const collector = this.collectors[i];
      const outcome = outcomes[i];

      if (outcome.ok) {
        const anchored = await this.anchor(collector.id, outcome.draft.payload);
        if (!anchored.ok) {
          // No evidence, no observation — and the failure is surfaced, not hidden.
          blockers.push({
            kind: "tool-failure",
            description: `collector "${collector.id}" succeeded but its evidence could not be anchored (${anchored.reason}); the observation was dropped (SPEC §4.1 rule 2)`,
            evidenceRefs: [],
          });
          continue;
        }
        const staleAfterMs = collector.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
        observations.push({
          kind: collector.kind,
          summary: outcome.draft.summary,
          ...(outcome.draft.detail !== undefined ? { detail: outcome.draft.detail } : {}),
          evidenceRefs: [anchored.ref],
          observedAt: now,
          staleAfter: new Date(nowMs + staleAfterMs).toISOString(),
        });
        for (const change of outcome.draft.detectedChanges ?? []) {
          detectedChanges.push({ ...change, evidenceRefs: [anchored.ref] });
        }
      } else {
        const failure = outcome.failure;
        const refs = failure.payload !== undefined ? await this.anchorRefsOrNull(collector.id, failure.payload) : [];
        blockers.push({
          kind: failure.kind,
          description: failure.description,
          evidenceRefs: refs,
          ...(failure.suggestedUnblock !== undefined ? { suggestedUnblock: failure.suggestedUnblock } : {}),
        });
      }
    }

    const assembled = assembleTrackerReport({
      missionId: input.missionId,
      observations,
      detectedChanges,
      blockers,
      now,
      ...(this.resolver !== undefined ? { resolver: this.resolver } : {}),
      ...(this.log !== undefined ? { log: this.log } : {}),
    });
    if (!assembled.ok) return { ok: false, reason: assembled.reason };
    return { ok: true, report: assembled.report, dropped: assembled.dropped };
  }

  private async anchor(
    collectorId: string,
    payload: unknown,
  ): Promise<{ ok: true; ref: EvidenceRef } | { ok: false; reason: string }> {
    try {
      const ref = await this.evidenceAnchor!({ collectorId, source: collectorId, payload });
      const parsed = evidenceRefSchema.safeParse(ref);
      if (!parsed.success) {
        return { ok: false, reason: `anchor returned a malformed evidence ref: ${JSON.stringify(ref)}` };
      }
      return { ok: true, ref };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Anchors a failure payload for blocker evidence; unanchorable failures cite nothing (still surfaced). */
  private async anchorRefsOrNull(collectorId: string, payload: unknown): Promise<EvidenceRef[]> {
    const anchored = await this.anchor(collectorId, payload);
    return anchored.ok ? [anchored.ref] : [];
  }
}
