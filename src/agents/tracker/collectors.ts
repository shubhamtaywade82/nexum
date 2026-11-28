/**
 * Tracker deterministic collectors (SPEC §4.1 grounding rule 1) — MAC v1 P3.
 *
 * Observation gathering is implemented as DETERMINISTIC collector calls
 * (git reads, run results, CI queries, run-log reads, TaskGraph and budget
 * snapshots). The LLM component only summarizes and correlates what the
 * collectors returned; it never asserts repository state without a collector
 * result behind it. Collector failures are honest outcomes (they become
 * `Blocker`s in the report), never silence.
 *
 * Ports: each collector depends on a NARROW port the host supplies. Ports
 * exist so the collectors are pure and testable with fixtures; the default
 * adapters at the bottom wire them to the repo's real surfaces (governed
 * read-only git verbs via `GitReadTool`, `SessionQueryService` run logs,
 * `TaskGraph`). The CI port is injected by the host (P5 wires the governed
 * read-only GitHub GET path); without it the collector is simply not
 * configured — an unconfigured collector is a deployment decision, not a
 * runtime failure, and produces no blocker.
 *
 * Evidence anchoring: collector results carry no evidence refs by themselves.
 * The tracker agent anchors each raw result through the `EvidenceAnchor` port
 * (persisted by the host as an artifact/event/run record — P5 wires the
 * mission artifact store) and cites the returned ref. No anchor, no report
 * (fail-closed in tracker-agent.ts).
 *
 * Layering: src/agents/tracker/** imports runtime/core contracts only.
 */

import { GitReadTool } from "../../tools/git-tools.js";
import type { ExecutionEventStore } from "../../runtime/persistence/execution-event-store.js";
import type { TaskGraph } from "../../core/tasks/task-graph.js";
import type { BudgetUsage, ExecutionBudget } from "../../core/types.js";
import type { BlockerKind, DetectedChange, EvidenceRef, ObservationKind } from "./contracts.js";

// ── Outcome drafts (pre-anchoring; refs are attached by the agent) ──────────

/** Draft of an observation; `payload` is anchored verbatim as the evidence. */
export interface ObservationDraft {
  /** ≤ 500 chars, factual (agents truncate via `truncateForObservation`). */
  summary: string;
  /** Structured detail, ≤ 8 KiB. */
  detail?: string;
  /** Raw deterministic collector result — anchored as evidence, cited by ref. */
  payload: unknown;
  /** Changes detected from this collector's data (refs attached at anchor). */
  detectedChanges?: Array<Omit<DetectedChange, "evidenceRefs">>;
}

/** Honest failure: becomes a Blocker in the report (never silence). */
export interface CollectorFailureDraft {
  kind: BlockerKind;
  description: string;
  suggestedUnblock?: string;
  /** Raw failure detail — anchored as the blocker's evidence when present. */
  payload?: unknown;
}

export type CollectorRawOutcome = { ok: true; draft: ObservationDraft } | { ok: false; failure: CollectorFailureDraft };

export interface ObservationCollector {
  /** Stable collector id (provenance label for anchoring). */
  readonly id: string;
  /** Observation kind this collector produces. */
  readonly kind: ObservationKind;
  /** Freshness bound for this collector's observations (default 60s). */
  readonly staleAfterMs?: number;
  collect(): Promise<CollectorRawOutcome>;
}

/** Default freshness bound for tracker observations (SPEC §4.1 rule 3). */
export const DEFAULT_STALE_AFTER_MS = 60_000;

/** Observation limits from SPEC §4.1. */
export const OBSERVATION_SUMMARY_MAX = 500;
export const OBSERVATION_DETAIL_MAX = 8_192;

export function truncateForObservation(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 20))}…[truncated ${text.length - max + 20} chars]`;
}

// ── Ports ───────────────────────────────────────────────────────────────────

export interface GitReadSuccess {
  ok: true;
  command: string;
  stdout: string;
  stderr: string;
}

export interface GitReadError {
  ok: false;
  /** Error code — "PolicyDenied" maps to a permission-denied blocker. */
  code: string;
  message: string;
}

/** Governed read-only git verbs (status/diff/log/show/blame/rev-parse). */
export interface GitReadPort {
  run(subcommand: string, args?: string[]): Promise<GitReadSuccess | GitReadError>;
}

export interface RecordedRunResult {
  runId: string;
  status: string;
  summary?: string;
}

/** Sandboxed run results (test/build outcomes) the tracker may read. */
export interface RunResultsPort {
  latestRuns(limit?: number): Promise<RecordedRunResult[]>;
}

export interface CiWorkflowRun {
  workflow: string;
  status: string;
  conclusion?: string | null;
  url?: string;
}

/** CI status via governed read-only queries (host-injected; P5 wires GitHub). */
export interface CiStatusPort {
  latestRuns(limit?: number): Promise<CiWorkflowRun[]>;
}

export interface AgentTraceSnapshot {
  runs: Array<{
    runId: string;
    eventCount: number;
    toolFailureCount: number;
    lastEventType?: string;
  }>;
  totalEvents: number;
}

/** Agent execution traces + tool failures (run-log / session_events reads). */
export interface AgentTracePort {
  snapshot(): Promise<AgentTraceSnapshot>;
}

export interface TaskGraphNodeSnapshot {
  id: string;
  goal: string;
  status: string;
  dependencies: string[];
  attempt: number;
}

/** TaskGraph snapshot (task status + dependency progress). */
export interface TaskGraphSnapshotPort {
  snapshot(): Promise<TaskGraphNodeSnapshot[]>;
}

export interface BudgetSnapshot {
  usage: BudgetUsage;
  limits?: ExecutionBudget;
}

/** Runtime resource / model usage snapshot (budgets, telemetry). */
export interface BudgetSnapshotPort {
  snapshot(): Promise<BudgetSnapshot>;
}

/** Anchor one collector result as immutable evidence; returns the citation. */
export type EvidenceAnchor = (input: { collectorId: string; source: string; payload: unknown }) => Promise<EvidenceRef>;

// ── Failure mapping (failure honesty) ───────────────────────────────────────

/** Maps a port error code to the SPEC §4.1 Blocker kind vocabulary. */
export function blockerKindForErrorCode(code: string): BlockerKind {
  const normalized = code.toLowerCase();
  if (normalized.includes("policydenied") || normalized.includes("permission")) return "permission-denied";
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("external") || normalized.includes("unavailable")) return "external-unavailable";
  if (normalized.includes("missing") || normalized.includes("notconfigured")) return "missing-dependency";
  return "tool-failure";
}

function gitFailure(failure: GitReadError, command: string): CollectorFailureDraft {
  return {
    kind: blockerKindForErrorCode(failure.code),
    description: `git read "${command}" failed: ${failure.code} — ${failure.message}`,
    payload: failure,
  };
}

// ── Built-in deterministic collectors ───────────────────────────────────────

/** Path → DetectedChange kind (extension map; unknown → "environment"). */
function changeKindForPath(path: string): DetectedChange["kind"] {
  const lower = path.toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java)$/.test(lower)) return "code";
  if (/\.test\.|\.spec\.|(__tests__|tests?\/)/.test(lower)) return "test";
  if (/\.(json|ya?ml|toml|ini|env|lock)$|(^|\/)\.env/.test(lower)) return "config";
  if (/\.(md|mdx|txt|rst|adoc)$/.test(lower)) return "docs";
  if (/(^|\/)\.github\/(workflows|actions)\//.test(lower)) return "ci";
  return "environment";
}

/**
 * Repository state collector: structure + changes + recent history, entirely
 * via the governed read-only git verbs (`git_read` — status/diff/log only).
 * `status` is authoritative; `log` and `diff` are best-effort enrichment, so
 * a fresh repository without commits still observes cleanly.
 */
export class GitStateCollector implements ObservationCollector {
  readonly id = "git-state";
  readonly kind: ObservationKind = "repository";
  readonly staleAfterMs = 30_000; // working-tree state goes stale fast

  constructor(private readonly git: GitReadPort) {}

  async collect(): Promise<CollectorRawOutcome> {
    const status = await this.git.run("status", ["--porcelain"]);
    if (!status.ok) return { ok: false, failure: gitFailure(status, "status --porcelain") };

    const changedPaths: Array<{ area: string; path: string }> = [];
    for (const line of status.stdout.split("\n")) {
      if (!line.trim()) continue;
      const area = line.slice(0, 2).trim() || "??";
      // porcelain v1: "XY path" (rename entries "R  old -> new" keep the target)
      const rawPath = line.slice(3).split(" -> ").pop() ?? line.slice(3);
      changedPaths.push({ area, path: rawPath.replace(/^"|"$/g, "") });
    }

    const log = await this.git.run("log", ["-n", "5", "--oneline"]);
    const headCommit = log.ok ? (log.stdout.split("\n")[0]?.split(" ")[0] ?? "unknown") : "no commits yet";

    const diff = await this.git.run("diff", ["HEAD"]);
    const diffStdout = diff.ok ? diff.stdout : "";

    const detail = truncateForObservation(
      [
        `status --porcelain:\n${status.stdout.trimEnd() || "(clean)"}`,
        log.ok ? `log -n 5 --oneline:\n${log.stdout.trimEnd()}` : `log unavailable: ${log.message}`,
        diffStdout
          ? `diff HEAD:\n${diffStdout.trimEnd()}`
          : diff.ok
            ? "(no unstaged diff)"
            : `diff unavailable: ${diff.message}`,
      ].join("\n\n"),
      OBSERVATION_DETAIL_MAX,
    );

    return {
      ok: true,
      draft: {
        summary:
          changedPaths.length === 0
            ? `working tree clean; HEAD ${headCommit}`
            : `working tree has ${changedPaths.length} changed path(s); HEAD ${headCommit}`,
        detail,
        payload: { status: status.stdout, log: log.ok ? log.stdout : null, diff: diffStdout || null, headCommit },
        detectedChanges: changedPaths.map((c) => ({
          kind: changeKindForPath(c.path),
          subject: c.path,
        })),
      },
    };
  }
}

/** Test/build results collector: reads recorded sandboxed run results. */
export class TestResultsCollector implements ObservationCollector {
  readonly id = "test-results";
  readonly kind: ObservationKind = "tests";
  readonly staleAfterMs = 120_000;

  constructor(private readonly runs: RunResultsPort) {}

  async collect(): Promise<CollectorRawOutcome> {
    try {
      const runs = await this.runs.latestRuns(5);
      const failed = runs.filter((r) => r.status !== "completed").length;
      return {
        ok: true,
        draft: {
          summary:
            runs.length === 0 ? "no recorded runs yet" : `${runs.length} recorded run(s), ${failed} not completed`,
          detail: truncateForObservation(JSON.stringify(runs, null, 2), OBSERVATION_DETAIL_MAX),
          payload: { runs },
        },
      };
    } catch (err) {
      return {
        ok: false,
        failure: {
          kind: "tool-failure",
          description: `run results read failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
}

/** CI status collector: governed read-only workflow queries. */
export class CiStatusCollector implements ObservationCollector {
  readonly id = "ci-status";
  readonly kind: ObservationKind = "ci";
  readonly staleAfterMs = 120_000;

  constructor(private readonly ci: CiStatusPort) {}

  async collect(): Promise<CollectorRawOutcome> {
    try {
      const runs = await this.ci.latestRuns(10);
      const failing = runs.filter((r) => (r.conclusion ?? r.status) === "failure").length;
      return {
        ok: true,
        draft: {
          summary: runs.length === 0 ? "no CI runs visible" : `${runs.length} CI run(s) visible, ${failing} failing`,
          detail: truncateForObservation(JSON.stringify(runs, null, 2), OBSERVATION_DETAIL_MAX),
          payload: { runs },
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        failure: {
          kind: blockerKindForErrorCode(message),
          description: `CI status query failed: ${message}`,
        },
      };
    }
  }
}

/** Agent trace collector: run logs + tool failures (session_events reads). */
export class AgentTraceCollector implements ObservationCollector {
  readonly id = "agent-traces";
  readonly kind: ObservationKind = "agent-trace";
  readonly staleAfterMs = 60_000;

  constructor(private readonly traces: AgentTracePort) {}

  async collect(): Promise<CollectorRawOutcome> {
    try {
      const snapshot = await this.traces.snapshot();
      const failures = snapshot.runs.reduce((acc, r) => acc + r.toolFailureCount, 0);
      return {
        ok: true,
        draft: {
          summary: `${snapshot.runs.length} recorded run(s), ${snapshot.totalEvents} event(s), ${failures} tool failure(s)`,
          detail: truncateForObservation(JSON.stringify(snapshot, null, 2), OBSERVATION_DETAIL_MAX),
          payload: snapshot,
        },
      };
    } catch (err) {
      return {
        ok: false,
        failure: {
          kind: "tool-failure",
          description: `agent trace read failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
}

/** TaskGraph snapshot collector: task status + dependency progress. */
export class TaskGraphCollector implements ObservationCollector {
  readonly id = "task-graph";
  readonly kind: ObservationKind = "task-status";
  readonly staleAfterMs = 60_000;

  constructor(private readonly graph: TaskGraphSnapshotPort) {}

  async collect(): Promise<CollectorRawOutcome> {
    try {
      const nodes = await this.graph.snapshot();
      const byStatus = nodes.reduce<Record<string, number>>((acc, n) => {
        acc[n.status] = (acc[n.status] ?? 0) + 1;
        return acc;
      }, {});
      return {
        ok: true,
        draft: {
          summary: `task graph: ${nodes.length} node(s) [${
            Object.entries(byStatus)
              .map(([s, n]) => `${s}=${n}`)
              .join(", ") || "empty"
          }]`,
          detail: truncateForObservation(JSON.stringify(nodes, null, 2), OBSERVATION_DETAIL_MAX),
          payload: { nodes },
        },
      };
    } catch (err) {
      return {
        ok: false,
        failure: {
          kind: "tool-failure",
          description: `task graph snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
}

/** Budget snapshot collector: runtime resource and model usage. */
export class BudgetCollector implements ObservationCollector {
  readonly id = "budget";
  readonly kind: ObservationKind = "resources";
  readonly staleAfterMs = 30_000;

  constructor(private readonly budget: BudgetSnapshotPort) {}

  async collect(): Promise<CollectorRawOutcome> {
    try {
      const snapshot = await this.budget.snapshot();
      const u = snapshot.usage;
      return {
        ok: true,
        draft: {
          summary: `usage: ${u.toolCalls} tool call(s), ${u.modelCalls} model call(s), ${u.totalTokens} tokens`,
          detail: truncateForObservation(JSON.stringify(snapshot, null, 2), OBSERVATION_DETAIL_MAX),
          payload: snapshot,
        },
      };
    } catch (err) {
      return {
        ok: false,
        failure: {
          kind: "tool-failure",
          description: `budget snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
}

// ── Default port adapters (wire ports to the repo's real surfaces) ──────────

/** Governed read-only git verbs via the repo's `GitReadTool` (in-tool allowlist). */
export function gitReadPort(root: string): GitReadPort {
  const tool = new GitReadTool(root);
  return {
    async run(subcommand, args = []) {
      const res = await tool.call({ args: [subcommand, ...args] });
      if (typeof res.error === "string") {
        return { ok: false, code: String(res.error), message: String(res.message ?? res.error) };
      }
      const exitCode = Number(res.exitCode ?? 0);
      if (exitCode !== 0) {
        return {
          ok: false,
          code: "GitError",
          message: String(res.stderr || res.stdout || `git ${subcommand} exited ${exitCode}`),
        };
      }
      return {
        ok: true,
        command: String(res.command ?? `git ${subcommand}`),
        stdout: String(res.stdout ?? ""),
        stderr: String(res.stderr ?? ""),
      };
    },
  };
}

/** Agent traces from the repo's `ExecutionEventStore` (run-log reads). */
export function sessionTracePort(store: ExecutionEventStore): AgentTracePort {
  return {
    async snapshot() {
      const runIds = store
        .listRuns()
        .map((r) => r.runId)
        .filter((id) => id.length > 0)
        .slice(-20);
      const runs: AgentTraceSnapshot["runs"] = [];
      let totalEvents = 0;
      for (const runId of runIds) {
        const events = store.eventsForRun(runId);
        const toolFailureCount = events.filter(
          (e) => /tool/i.test(e.event.type) && /"error"/i.test(JSON.stringify(e.event)),
        ).length;
        totalEvents += events.length;
        runs.push({
          runId,
          eventCount: events.length,
          toolFailureCount,
          lastEventType: events.at(-1)?.event.type,
        });
      }
      return { runs, totalEvents };
    },
  };
}

/** TaskGraph snapshot from the repo's `TaskGraph`. */
export function taskGraphPort(graph: TaskGraph): TaskGraphSnapshotPort {
  return {
    async snapshot() {
      return graph.all().map((n) => ({
        id: n.id,
        goal: n.goal,
        status: n.status,
        dependencies: [...n.dependencies],
        attempt: n.attempt,
      }));
    },
  };
}
