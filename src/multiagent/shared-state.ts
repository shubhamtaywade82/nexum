/**
 * SharedStateStore — the coordination blackboard.
 *
 * Multiple agents writing one state need more than "share an object":
 * they need versioning (who wrote what, when), compare-and-swap (don't
 * clobber concurrent work silently), per-field ownership, and an explicit
 * conflict policy. This store provides all four over a structured
 * SharedAgentState (goal, facts, findings, artifacts, decisions, statuses).
 *
 *   update(owner, expectedVersion?, mutator)   — CAS-checked mutation
 *   addFact / addFinding / publishArtifact /
 *   recordDecision / setAgentStatus            — domain helpers (set-union
 *                                                semantics for concurrent adds)
 *
 * Conflict policies when a CAS check fails or a non-owner mutates an owned
 * field:
 *   "lww"              last write wins (logged as conflicted)
 *   "reject"           throw VersionConflictError
 *   "supervisor-wins"  only the supervisor proceeds; others are rejected
 *   custom resolver    (ctx) => "proceed" | "reject"
 */

import type { AgentAddress } from "./bus/message-bus.js";
import { randomUUID } from "node:crypto";

export interface Fact {
  id: string;
  key: string;
  value: unknown;
  /** 0..1 — how much to trust this fact. */
  confidence: number;
  source: AgentAddress;
  ts: number;
}

export interface Finding {
  id: string;
  summary: string;
  detail?: string;
  /** Artifact references backing this finding (see artifacts plane). */
  evidence?: Array<{ artifactId: string; version?: number }>;
  source: AgentAddress;
  tags?: string[];
  ts: number;
}

export interface Decision {
  id: string;
  rationale: string;
  decidedBy: AgentAddress;
  alternatives?: string[];
  ts: number;
}

export type AgentState = "idle" | "working" | "blocked" | "done" | "failed";

export interface AgentStatusInfo {
  agentId: AgentAddress;
  state: AgentState;
  currentTaskId?: string;
  progress?: number;
  lastHeartbeat: number;
}

export interface ArtifactEntry {
  artifactId: string;
  name?: string;
  version?: number;
  contributedBy: AgentAddress;
}

export interface SharedAgentState {
  goal: string;
  facts: Fact[];
  findings: Finding[];
  artifacts: ArtifactEntry[];
  decisions: Decision[];
  agentStatuses: AgentStatusInfo[];
  version: number;
  updatedAt: number;
}

export type SharedStateField = keyof Omit<SharedAgentState, "version" | "updatedAt">;

export interface ChangeLogEntry {
  version: number;
  who: AgentAddress;
  ts: number;
  summary: string;
  conflicted: boolean;
  resolution?: "lww" | "supervisor-wins" | "custom";
}

export class VersionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly owner: AgentAddress,
  ) {
    super(`state version conflict: expected ${expected}, current ${actual} (writer: ${owner})`);
    this.name = "VersionConflictError";
  }
}

export interface ConflictContext {
  owner: AgentAddress;
  expectedVersion?: number;
  currentVersion: number;
  /** Fields the mutation touched that are owned by someone else. */
  violatedFields: SharedStateField[];
}

export type ConflictPolicy = "lww" | "reject" | "supervisor-wins" | ((ctx: ConflictContext) => "proceed" | "reject");

export interface SharedStateOptions {
  goal: string;
  conflictPolicy?: ConflictPolicy;
  /** Required by the "supervisor-wins" policy. */
  supervisorId?: AgentAddress;
  /** Field ownership: only these agents may mutate the listed fields. */
  fieldOwners?: Partial<Record<SharedStateField, AgentAddress[]>>;
}

export interface UpdateOptions {
  owner: AgentAddress;
  /** CAS check: proceed only when the current version matches. */
  expectedVersion?: number;
  summary?: string;
}

type Subscriber = (state: Readonly<SharedAgentState>, change: ChangeLogEntry) => void;

export class SharedStateStore {
  private state: SharedAgentState;
  private readonly log: ChangeLogEntry[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly conflictPolicy: ConflictPolicy;
  private readonly supervisorId?: AgentAddress;
  private readonly fieldOwners: Partial<Record<SharedStateField, AgentAddress[]>>;

  constructor(opts: SharedStateOptions) {
    this.state = {
      goal: opts.goal,
      facts: [],
      findings: [],
      artifacts: [],
      decisions: [],
      agentStatuses: [],
      version: 0,
      updatedAt: Date.now(),
    };
    this.conflictPolicy = opts.conflictPolicy ?? "lww";
    this.supervisorId = opts.supervisorId;
    this.fieldOwners = opts.fieldOwners ?? {};
  }

  get version(): number {
    return this.state.version;
  }

  snapshot(): Readonly<SharedAgentState> {
    return JSON.parse(JSON.stringify(this.state)) as SharedAgentState;
  }

  subscribe(listener: Subscriber): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  changelog(): ChangeLogEntry[] {
    return [...this.log];
  }

  /**
   * CAS-checked mutation. The mutator receives a writable draft; whatever
   * it changes is committed atomically (version bump + changelog + notify).
   * Throws VersionConflictError when the policy rejects the write.
   */
  update(opts: UpdateOptions, mutator: (draft: SharedAgentState) => void): Readonly<SharedAgentState> {
    const current = this.state;
    const staleVersion = opts.expectedVersion !== undefined && opts.expectedVersion !== current.version;

    const draft = JSON.parse(JSON.stringify(current)) as SharedAgentState;
    mutator(draft);
    const touched = changedFields(current, draft);
    const violatedFields = touched.filter((field) => {
      const owners = this.fieldOwners[field];
      return owners !== undefined && owners.length > 0 && !owners.includes(opts.owner);
    });

    const conflict = staleVersion || violatedFields.length > 0;
    let resolution: ChangeLogEntry["resolution"];
    if (conflict) {
      const ctx: ConflictContext = {
        owner: opts.owner,
        ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        currentVersion: current.version,
        violatedFields,
      };
      const outcome =
        typeof this.conflictPolicy === "function"
          ? this.conflictPolicy(ctx)
          : this.conflictPolicy === "lww"
            ? "proceed"
            : this.conflictPolicy === "supervisor-wins"
              ? opts.owner === this.supervisorId
                ? "proceed"
                : "reject"
              : "reject"; // "reject"
      if (outcome === "reject") {
        throw new VersionConflictError(opts.expectedVersion ?? current.version, current.version, opts.owner);
      }
      resolution =
        typeof this.conflictPolicy === "function" ? "custom" : (this.conflictPolicy as "lww" | "supervisor-wins");
    }

    draft.version = current.version + 1;
    draft.updatedAt = Date.now();
    this.state = draft;
    const entry: ChangeLogEntry = {
      version: draft.version,
      who: opts.owner,
      ts: draft.updatedAt,
      summary: opts.summary ?? `updated ${touched.length > 0 ? touched.join(", ") : "state"}`,
      conflicted: conflict,
      ...(resolution !== undefined ? { resolution } : {}),
    };
    this.log.push(entry);
    const snapshot = this.snapshot();
    for (const subscriber of [...this.subscribers]) subscriber(snapshot, entry);
    return snapshot;
  }

  // ── Domain helpers (set-union / per-key LWW semantics) ───────────────────

  /** Upsert a fact by key — concurrent adds by different agents merge. */
  addFact(input: {
    key: string;
    value: unknown;
    confidence?: number;
    owner: AgentAddress;
    expectedVersion?: number;
  }): Fact {
    const confidence = clamp01(input.confidence ?? 0.7);
    let saved: Fact | undefined;
    this.update(
      {
        owner: input.owner,
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        summary: `fact ${input.key}`,
      },
      (draft) => {
        const existing = draft.facts.find((f) => f.key === input.key);
        if (existing && existing.source === input.owner) {
          existing.value = input.value;
          existing.confidence = confidence;
          existing.ts = Date.now();
          saved = existing;
          return;
        }
        if (existing && existing.source !== input.owner) {
          // per-key LWW by confidence then recency — both writers survive in
          // the log, the stronger fact wins the key.
          if (confidence <= existing.confidence) {
            saved = existing;
            draft.facts.push({
              id: `fact_${randomUUID()}`,
              key: input.key,
              value: input.value,
              confidence,
              source: input.owner,
              ts: Date.now(),
            });
            return;
          }
        }
        const fact: Fact = {
          id: `fact_${randomUUID()}`,
          key: input.key,
          value: input.value,
          confidence,
          source: input.owner,
          ts: Date.now(),
        };
        draft.facts = draft.facts.filter((f) => f.key !== input.key).concat(fact);
        saved = fact;
      },
    );
    return saved as Fact;
  }

  addFinding(input: {
    summary: string;
    detail?: string;
    evidence?: Array<{ artifactId: string; version?: number }>;
    tags?: string[];
    owner: AgentAddress;
    expectedVersion?: number;
  }): Finding {
    const finding: Finding = {
      id: `find_${randomUUID()}`,
      summary: input.summary,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      source: input.owner,
      ts: Date.now(),
    };
    this.update(
      {
        owner: input.owner,
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        summary: `finding: ${input.summary.slice(0, 60)}`,
      },
      (draft) => {
        draft.findings.push(finding);
      },
    );
    return finding;
  }

  publishArtifact(input: { artifactId: string; name?: string; version?: number; owner: AgentAddress }): ArtifactEntry {
    const entry: ArtifactEntry = {
      artifactId: input.artifactId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
      contributedBy: input.owner,
    };
    this.update({ owner: input.owner, summary: `artifact ${input.name ?? input.artifactId}` }, (draft) => {
      draft.artifacts = draft.artifacts.filter((a) => a.artifactId !== input.artifactId).concat(entry);
    });
    return entry;
  }

  recordDecision(input: { rationale: string; decidedBy: AgentAddress; alternatives?: string[] }): Decision {
    const decision: Decision = {
      id: `dec_${randomUUID()}`,
      rationale: input.rationale,
      decidedBy: input.decidedBy,
      ...(input.alternatives !== undefined ? { alternatives: input.alternatives } : {}),
      ts: Date.now(),
    };
    this.update({ owner: input.decidedBy, summary: `decision: ${input.rationale.slice(0, 60)}` }, (draft) => {
      draft.decisions.push(decision);
    });
    return decision;
  }

  setAgentStatus(input: {
    agentId: AgentAddress;
    state: AgentState;
    currentTaskId?: string;
    progress?: number;
  }): AgentStatusInfo {
    const status: AgentStatusInfo = {
      agentId: input.agentId,
      state: input.state,
      ...(input.currentTaskId !== undefined ? { currentTaskId: input.currentTaskId } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      lastHeartbeat: Date.now(),
    };
    this.update({ owner: input.agentId, summary: `status ${input.agentId}: ${input.state}` }, (draft) => {
      draft.agentStatuses = draft.agentStatuses.filter((s) => s.agentId !== input.agentId).concat(status);
    });
    return status;
  }

  fact(key: string): Fact | undefined {
    return this.state.facts.find((f) => f.key === key);
  }

  findingsByTag(tag: string): Finding[] {
    return this.state.findings.filter((f) => f.tags?.includes(tag));
  }

  agentStatus(agentId: AgentAddress): AgentStatusInfo | undefined {
    return this.state.agentStatuses.find((s) => s.agentId === agentId);
  }
}

function changedFields(before: SharedAgentState, after: SharedAgentState): SharedStateField[] {
  const fields: SharedStateField[] = ["goal", "facts", "findings", "artifacts", "decisions", "agentStatuses"];
  return fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
