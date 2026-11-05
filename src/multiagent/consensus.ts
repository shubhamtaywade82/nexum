/**
 * ConsensusEngine — proposals, votes, and arbitration.
 *
 * With several specialist agents, two will eventually disagree. The
 * syllabus pattern is a supervisor resolving conflicting proposals; a
 * runtime needs the general machinery:
 *
 *   propose(topic, value) → cast(votes) → tally(voting strategy) → decision
 *
 * Voting strategies (pluggable):
 *   MajorityVoting    >50% of non-abstain weight approves
 *   UnanimousVoting   every non-abstain voter must approve
 *   WeightedVoting    per-agent weights, majority of weight
 *   QuorumVoting      majority AND minimum participation
 *   PriorityResolver  deadlock breaker: highest-priority voter's choice wins
 *
 * ConflictResolver arbitrates BETWEEN competing proposals (not votes):
 * the supervisor's proposal wins outright; otherwise the highest-priority
 * proposer's does; ties break deterministically to the first proposal.
 * Both integrate with the bus (coord.proposal / coord.vote /
 * coord.decision envelopes) and the shared state (decisions are recorded
 * by the caller or via recordDecision helper).
 */

import { randomUUID } from "node:crypto";
import type { AgentAddress, AgentMessageBus } from "./bus/message-bus.js";
import {
  decision as decisionMessage,
  proposal as proposalMessage,
  vote as voteMessage,
} from "./bus/coordination-protocol.js";
import type { SharedStateStore } from "./shared-state.js";

// ── Votes and proposals ─────────────────────────────────────────────────────

export interface VoteEntry {
  voter: AgentAddress;
  /** "approve" | "reject" | "abstain" or a custom option id. */
  choice: string;
  weight?: number;
  rationale?: string;
  ts: number;
}

export interface ProposalRecord {
  id: string;
  topic: string;
  /** The proposed value (opaque). */
  value: unknown;
  proposer: AgentAddress;
  /** Explicit option ids when the vote is a choice, not approve/reject. */
  options?: string[];
  votes: VoteEntry[];
  createdAt: number;
  resolved?: DecisionOutcome;
}

export interface DecisionOutcome {
  proposalId: string;
  topic: string;
  outcome: "approved" | "rejected" | "deadlock";
  /** The winning value/option when approved. */
  winner?: unknown;
  tally: Record<string, number>;
  totalWeight: number;
  participation: number;
  ts: number;
  rationale?: string;
}

// ── Voting strategies ───────────────────────────────────────────────────────

export interface VotingContext {
  proposal: Pick<ProposalRecord, "topic" | "value" | "options" | "proposer">;
  votes: VoteEntry[];
  electorate: AgentAddress[];
}

export interface VotingStrategy {
  readonly name: string;
  tally(ctx: VotingContext): DecisionOutcome;
}

function baseOutcome(ctx: VotingContext): Pick<DecisionOutcome, "tally" | "totalWeight" | "participation"> {
  const tally: Record<string, number> = {};
  let totalWeight = 0;
  for (const vote of ctx.votes) {
    const weight = vote.weight ?? 1;
    tally[vote.choice] = (tally[vote.choice] ?? 0) + weight;
    if (vote.choice !== "abstain") totalWeight += weight;
  }
  const voters = new Set(ctx.votes.map((v) => v.voter));
  const participation = ctx.electorate.length > 0 ? voters.size / ctx.electorate.length : 0;
  return { tally, totalWeight, participation };
}

export class MajorityVoting implements VotingStrategy {
  readonly name = "majority";
  tally(ctx: VotingContext): DecisionOutcome {
    const base = baseOutcome(ctx);

    // Multi-option proposals: the top-weighted option wins (tie = deadlock).
    if (ctx.proposal.options !== undefined && ctx.proposal.options.length > 0) {
      const ranked = ctx.proposal.options
        .map((option) => ({ option, weight: base.tally[option] ?? 0 }))
        .sort((a, b) => b.weight - a.weight);
      const decided = ranked.reduce((s, r) => s + r.weight, 0);
      const tied = ranked.length > 1 && ranked[0].weight === ranked[1].weight;
      if (decided === 0 || tied) {
        return {
          proposalId: "",
          topic: ctx.proposal.topic,
          outcome: "deadlock",
          tally: base.tally,
          totalWeight: base.totalWeight,
          participation: base.participation,
          ts: Date.now(),
          ...(tied
            ? { rationale: `options ${ranked[0].option} and ${ranked[1].option} are tied at ${ranked[0].weight}` }
            : { rationale: "no decided votes" }),
        };
      }
      return {
        proposalId: "",
        topic: ctx.proposal.topic,
        outcome: "approved",
        winner: ranked[0].option,
        tally: base.tally,
        totalWeight: base.totalWeight,
        participation: base.participation,
        ts: Date.now(),
      };
    }

    const approve = base.tally["approve"] ?? 0;
    const reject = base.tally["reject"] ?? 0;
    const decided = approve + reject;
    const outcome = decided === 0 || approve === reject ? "deadlock" : approve > reject ? "approved" : "rejected";
    return {
      proposalId: "",
      topic: ctx.proposal.topic,
      outcome,
      ...(outcome === "approved" ? { winner: ctx.proposal.value } : {}),
      tally: base.tally,
      totalWeight: base.totalWeight,
      participation: base.participation,
      ts: Date.now(),
      ...(outcome === "deadlock" ? { rationale: `approve ${approve} vs reject ${reject}` } : {}),
    };
  }
}

export class UnanimousVoting implements VotingStrategy {
  readonly name = "unanimous";
  tally(ctx: VotingContext): DecisionOutcome {
    const base = baseOutcome(ctx);
    const decided = ctx.votes.filter((v) => v.choice !== "abstain");
    const allApprove = decided.length > 0 && decided.every((v) => v.choice === "approve");
    return {
      proposalId: "",
      topic: ctx.proposal.topic,
      outcome: allApprove ? "approved" : decided.length === 0 ? "deadlock" : "rejected",
      ...(allApprove ? { winner: ctx.proposal.value } : {}),
      tally: base.tally,
      totalWeight: base.totalWeight,
      participation: base.participation,
      ts: Date.now(),
      ...(allApprove ? {} : { rationale: "unanimity requires every non-abstain vote to approve" }),
    };
  }
}

export class WeightedVoting implements VotingStrategy {
  readonly name = "weighted";
  constructor(private readonly weights: Partial<Record<AgentAddress, number>> = {}) {}

  tally(ctx: VotingContext): DecisionOutcome {
    const weighted: VoteEntry[] = ctx.votes.map((v) => ({ ...v, weight: this.weights[v.voter] ?? v.weight ?? 1 }));
    const base = baseOutcome({ ...ctx, votes: weighted });
    const approve = base.tally["approve"] ?? 0;
    const reject = base.tally["reject"] ?? 0;
    const outcome = approve === reject ? "deadlock" : approve > reject ? "approved" : "rejected";
    return {
      proposalId: "",
      topic: ctx.proposal.topic,
      outcome,
      ...(outcome === "approved" ? { winner: ctx.proposal.value } : {}),
      tally: base.tally,
      totalWeight: base.totalWeight,
      participation: base.participation,
      ts: Date.now(),
    };
  }
}

export class QuorumVoting implements VotingStrategy {
  readonly name = "quorum";
  constructor(
    private readonly minParticipation: number,
    private readonly inner: VotingStrategy = new MajorityVoting(),
  ) {}

  tally(ctx: VotingContext): DecisionOutcome {
    const result = this.inner.tally(ctx);
    if (result.participation < this.minParticipation) {
      return {
        ...result,
        outcome: "deadlock",
        rationale: `quorum not met: participation ${Math.round(result.participation * 100)}% < ${Math.round(this.minParticipation * 100)}%`,
        ...(result.outcome === "approved" ? {} : {}),
      };
    }
    return result;
  }
}

/** Deadlock breaker: the highest-priority voter's choice wins outright. */
export class PriorityResolver {
  constructor(private readonly priority: Map<AgentAddress, number> = new Map()) {}

  priorityOf(agent: AgentAddress): number {
    return this.priority.get(agent) ?? 0;
  }

  breakDeadlock(ctx: VotingContext): DecisionOutcome | undefined {
    const decided = ctx.votes
      .filter((v) => v.choice !== "abstain")
      .sort((a, b) => this.priorityOf(b.voter) - this.priorityOf(a.voter) || a.ts - b.ts);
    const top = decided[0];
    if (!top) return undefined;
    const base = baseOutcome(ctx);
    const approved = top.choice === "approve" || top.choice === ctx.proposal.value;
    return {
      proposalId: "",
      topic: ctx.proposal.topic,
      outcome: approved ? "approved" : "rejected",
      ...(approved ? { winner: ctx.proposal.value } : {}),
      tally: base.tally,
      totalWeight: base.totalWeight,
      participation: base.participation,
      ts: Date.now(),
      rationale: `deadlock broken by priority: ${top.voter} (priority ${this.priorityOf(top.voter)}) chose ${top.choice}`,
    };
  }
}

// ── Consensus engine ────────────────────────────────────────────────────────

export interface ConsensusEngineOptions {
  electorate: AgentAddress[];
  voting?: VotingStrategy;
  priorityResolver?: PriorityResolver;
  /** Optional bus — proposals/votes/decisions are mirrored onto it. */
  bus?: AgentMessageBus;
  /** Address used for bus mirroring (default "consensus"). */
  busAddress?: AgentAddress;
}

export class ConsensusEngine {
  private readonly proposals = new Map<string, ProposalRecord>();
  private readonly electorate: Set<AgentAddress>;
  private readonly voting: VotingStrategy;
  private readonly priorityResolver?: PriorityResolver;
  private readonly bus?: AgentMessageBus;
  private readonly busAddress: AgentAddress;

  constructor(opts: ConsensusEngineOptions) {
    this.electorate = new Set(opts.electorate);
    this.voting = opts.voting ?? new MajorityVoting();
    this.priorityResolver = opts.priorityResolver;
    this.bus = opts.bus;
    this.busAddress = opts.busAddress ?? "consensus";
  }

  propose(input: { topic: string; value: unknown; proposer: AgentAddress; options?: string[] }): ProposalRecord {
    const record: ProposalRecord = {
      id: `prop_${randomUUID()}`,
      topic: input.topic,
      value: input.value,
      proposer: input.proposer,
      ...(input.options !== undefined ? { options: input.options } : {}),
      votes: [],
      createdAt: Date.now(),
    };
    this.proposals.set(record.id, record);
    this.bus?.send(
      proposalMessage(this.busAddress, "topic:coordination", {
        proposalId: record.id,
        topic: record.topic,
        value: record.value,
        ...(input.options !== undefined ? { options: input.options } : {}),
      }),
    );
    return record;
  }

  cast(input: { proposalId: string; voter: AgentAddress; choice: string; rationale?: string }): VoteEntry {
    const record = this.proposals.get(input.proposalId);
    if (!record) throw new Error(`unknown proposal "${input.proposalId}"`);
    if (!this.electorate.has(input.voter)) {
      throw new Error(`"${input.voter}" is not in the electorate`);
    }
    if (record.resolved) throw new Error(`proposal "${input.proposalId}" is already resolved`);
    if (record.options !== undefined && !record.options.includes(input.choice) && !["abstain"].includes(input.choice)) {
      throw new Error(`choice "${input.choice}" is not one of the proposal options`);
    }
    const entry: VoteEntry = {
      voter: input.voter,
      choice: input.choice,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ts: Date.now(),
    };
    record.votes.push(entry);
    this.bus?.send(
      voteMessage(this.busAddress, "topic:coordination", {
        proposalId: record.id,
        choice: entry.choice,
        ...(entry.rationale !== undefined ? { rationale: entry.rationale } : {}),
      }),
    );

    // Auto-resolve once every electorate member has voted.
    if (this.electorate.size > 0 && record.votes.length >= this.electorate.size) {
      this.resolve(record.id);
    }
    return entry;
  }

  /** Tally now (early resolution is allowed; votes keep counting until then). */
  resolve(proposalId: string): DecisionOutcome {
    const record = this.proposals.get(proposalId);
    if (!record) throw new Error(`unknown proposal "${proposalId}"`);
    if (record.resolved) return record.resolved;

    let outcome = this.voting.tally({
      proposal: record,
      votes: record.votes,
      electorate: [...this.electorate],
    });
    outcome.proposalId = record.id;
    if (outcome.outcome === "deadlock" && this.priorityResolver) {
      const broken = this.priorityResolver.breakDeadlock({
        proposal: record,
        votes: record.votes,
        electorate: [...this.electorate],
      });
      if (broken) outcome = { ...broken, proposalId: record.id };
    }
    record.resolved = outcome;
    this.bus?.send(
      decisionMessage(this.busAddress, "topic:coordination", {
        proposalId: record.id,
        outcome: outcome.outcome,
        ...(outcome.winner !== undefined ? { winner: outcome.winner } : {}),
        tally: outcome.tally,
        ...(outcome.rationale !== undefined ? { rationale: outcome.rationale } : {}),
      }),
    );
    return outcome;
  }

  /** Await resolution: resolves immediately if already decided. */
  async awaitResolution(proposalId: string, timeoutMs = 10_000): Promise<DecisionOutcome> {
    const existing = this.proposals.get(proposalId)?.resolved;
    if (existing) return existing;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = this.proposals.get(proposalId);
      if (record?.resolved) return record.resolved;
      if (Date.now() >= deadline) throw new Error(`proposal "${proposalId}" not resolved within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  proposal(id: string): ProposalRecord | undefined {
    const record = this.proposals.get(id);
    return record ? { ...record, votes: [...record.votes] } : undefined;
  }

  all(): ProposalRecord[] {
    return [...this.proposals.values()].map((p) => ({ ...p, votes: [...p.votes] }));
  }
}

// ── Conflict resolution between proposals ───────────────────────────────────

export interface CompetingProposal {
  proposer: AgentAddress;
  value: unknown;
  rationale?: string;
}

export interface ConflictResolution {
  winner: CompetingProposal;
  method: "supervisor" | "priority" | "first";
  rationale: string;
}

export interface ConflictResolverOptions {
  supervisorId?: AgentAddress;
  /** Higher number = wins ties (default 0 for everyone). */
  priority?: Map<AgentAddress, number>;
  /** Optional shared state — resolutions are recorded as decisions. */
  sharedState?: SharedStateStore;
}

export class ConflictResolver {
  private readonly supervisorId?: AgentAddress;
  private readonly priority: Map<AgentAddress, number>;
  private readonly sharedState?: SharedStateStore;

  constructor(opts: ConflictResolverOptions = {}) {
    this.supervisorId = opts.supervisorId;
    this.priority = opts.priority ?? new Map();
    this.sharedState = opts.sharedState;
  }

  /**
   * Arbitrate between competing proposals deterministically:
   * supervisor's proposal wins outright; else highest priority; else first.
   */
  resolve(input: { topic: string; proposals: CompetingProposal[] }): ConflictResolution {
    if (input.proposals.length === 0) throw new Error("conflict resolution requires at least one proposal");
    if (input.proposals.length === 1) {
      const resolution: ConflictResolution = {
        winner: input.proposals[0],
        method: "first",
        rationale: "only one proposal",
      };
      this.record(input.topic, resolution);
      return resolution;
    }
    const supervisorProposal = this.supervisorId
      ? input.proposals.find((p) => p.proposer === this.supervisorId)
      : undefined;
    let resolution: ConflictResolution;
    if (supervisorProposal) {
      resolution = {
        winner: supervisorProposal,
        method: "supervisor",
        rationale: `supervisor ${this.supervisorId} proposed the winning value`,
      };
    } else {
      const ranked = [...input.proposals].sort(
        (a, b) => (this.priority.get(b.proposer) ?? 0) - (this.priority.get(a.proposer) ?? 0),
      );
      const topPriority = this.priority.get(ranked[0].proposer) ?? 0;
      const tied = (this.priority.get(ranked[1].proposer) ?? 0) === topPriority;
      resolution = tied
        ? {
            winner: input.proposals[0],
            method: "first",
            rationale: `priority tie (${topPriority}) — first proposal wins deterministically`,
          }
        : {
            winner: ranked[0],
            method: "priority",
            rationale: `${ranked[0].proposer} has the highest priority (${topPriority})`,
          };
    }
    this.record(input.topic, resolution);
    return resolution;
  }

  private record(topic: string, resolution: ConflictResolution): void {
    this.sharedState?.recordDecision({
      rationale: `[${topic}] ${resolution.rationale}`,
      decidedBy: resolution.winner.proposer,
      alternatives: resolution.method === "first" ? [] : [`${resolution.method} arbitration`],
    });
  }
}
