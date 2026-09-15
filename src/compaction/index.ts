/**
 * CompactionService — controls long-running context growth.
 *
 * Nexum already has SessionStore, ExecutionRecorder, CheckpointStore, and
 * ContextManager. Those persist the transcript; they do not *compress* it.
 * For a long-running autonomous agent, the conversation history grows
 * without bound until the model's context window overflows.
 *
 * The CompactionService implements the DeepSeek-Harness-style compaction
 * pipeline:
 *
 *   Conversation
 *        ↓
 *   token pressure    (TokenEstimator: is the conversation over budget?)
 *        ↓
 *   compaction policy (CompactionPolicy: when/what to compact)
 *        ↓
 *   summary / memory  (SummaryProvider: LLM-generated summary of old turns)
 *        ↓
 *   history replace   (HistoryReducer: swap old turns for the summary)
 *        ↓
 *   continued exec    (ContextRebuilder: re-seat the new history into context)
 *
 * This is particularly important for the crypto-agent direction, where an
 * agent may run for hours or days monitoring markets.
 */

import type { ExecutionRequest } from "../core/types.js";

// ── Contracts ───────────────────────────────────────────────────────────────

/** A single message in a conversation (OpenAI-style). */
export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Optional tool call id (for role: "tool"). */
  toolCallId?: string;
  /** Optional tool calls (for role: "assistant"). */
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  /** Optional name (for role: "tool"). */
  name?: string;
}

export interface CompactionInput {
  /** The full conversation so far. */
  messages: ConversationMessage[];
  /** The model's context window size in tokens. */
  contextWindow: number;
  /** Tokens reserved for the new response (default 1024). */
  reserveForResponse?: number;
  /** Tokens reserved for system prompt + injected context (default 2048). */
  reserveForSystem?: number;
}

export interface CompactionDecision {
  /** Whether compaction is needed. */
  shouldCompact: boolean;
  /** Estimated tokens of the current conversation. */
  estimatedTokens: number;
  /** Effective token budget for conversation. */
  budget: number;
  /** Number of messages to compact (the oldest N). */
  messagesToCompact: number;
  /** Number of messages to keep verbatim (the most recent N). */
  messagesToKeep: number;
  /** Reason for the decision (for observability). */
  reason: string;
}

export interface CompactionResult {
  /** The new, compacted message list. */
  messages: ConversationMessage[];
  /** Summary text generated for the compacted portion. */
  summary: string;
  /** Number of messages removed. */
  removedCount: number;
  /** Estimated tokens saved. */
  tokensSaved: number;
  /** Decision that drove this compaction. */
  decision: CompactionDecision;
}

// ── TokenEstimator ──────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

export class TokenEstimator {
  /** Rough token estimate: chars / 4 (good enough for budgeting decisions). */
  estimate(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  estimateMessage(message: ConversationMessage): number {
    let chars = message.content.length;
    if (message.toolCalls) {
      for (const tc of message.toolCalls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
    // Role + framing overhead (~4 tokens per message).
    return Math.ceil(chars / CHARS_PER_TOKEN) + 4;
  }

  estimateConversation(messages: ConversationMessage[]): number {
    return messages.reduce((sum, m) => sum + this.estimateMessage(m), 0);
  }
}

// ── CompactionPolicy ─────────────────────────────────────────────────────────

export interface CompactionPolicyOptions {
  /** Compaction trigger: fraction of context window (default 0.75). */
  triggerFraction?: number;
  /** After compaction, target this fraction of context window (default 0.5). */
  targetFraction?: number;
  /** Always keep the most recent N messages verbatim (default 6). */
  keepRecentMessages?: number;
  /** Never compact if conversation is under this many messages (default 8). */
  minMessagesToCompact?: number;
}

export class CompactionPolicy {
  constructor(private readonly opts: CompactionPolicyOptions = {}) {}

  decide(input: CompactionInput): CompactionDecision {
    const estimator = new TokenEstimator();
    const estimatedTokens = estimator.estimateConversation(input.messages);
    const reserveResponse = input.reserveForResponse ?? 1024;
    const reserveSystem = input.reserveForSystem ?? 2048;
    const budget = input.contextWindow - reserveResponse - reserveSystem;
    const trigger = budget * (this.opts.triggerFraction ?? 0.75);
    const target = budget * (this.opts.targetFraction ?? 0.5);
    const keepRecent = this.opts.keepRecentMessages ?? 6;
    const minToCompact = this.opts.minMessagesToCompact ?? 8;

    if (estimatedTokens <= trigger) {
      return {
        shouldCompact: false,
        estimatedTokens,
        budget,
        messagesToCompact: 0,
        messagesToKeep: input.messages.length,
        reason: `under trigger (${estimatedTokens} <= ${Math.round(trigger)})`,
      };
    }

    // We need to compact enough messages to get down to `target`.
    // Walk from oldest to newest, accumulating tokens, until removing more
    // would put us under target.
    const messagesToCompact = Math.max(
      minToCompact,
      this.countMessagesToCompact(input.messages, estimatedTokens - target, keepRecent),
    );

    return {
      shouldCompact: true,
      estimatedTokens,
      budget,
      messagesToCompact,
      messagesToKeep: input.messages.length - messagesToCompact,
      reason: `over trigger (${estimatedTokens} > ${Math.round(trigger)}); compacting ${messagesToCompact} oldest to reach ~${Math.round(target)} tokens`,
    };
  }

  private countMessagesToCompact(messages: ConversationMessage[], tokensToRemove: number, keepRecent: number): number {
    const estimator = new TokenEstimator();
    let removed = 0;
    let tokensSaved = 0;
    const maxRemovable = messages.length - keepRecent;
    for (let i = 0; i < maxRemovable; i++) {
      if (tokensSaved >= tokensToRemove) break;
      tokensSaved += estimator.estimateMessage(messages[i]);
      removed++;
    }
    return removed;
  }
}

// ── SummaryProvider ──────────────────────────────────────────────────────────

export interface SummaryProvider {
  summarize(messages: ConversationMessage[]): Promise<string>;
}

/**
 * Rule-based summary provider — no LLM call, just a structured digest.
 * Suitable for tests and as a default fallback. An LLM-backed provider can
 * be injected for production use.
 */
export class RuleBasedSummaryProvider implements SummaryProvider {
  async summarize(messages: ConversationMessage[]): Promise<string> {
    if (messages.length === 0) return "(empty history)";

    const userTurns = messages.filter((m) => m.role === "user");
    const assistantTurns = messages.filter((m) => m.role === "assistant");
    const toolTurns = messages.filter((m) => m.role === "tool");

    const lines: string[] = [
      `## Compacted History (${messages.length} messages)`,
      "",
      `**Summary:** ${userTurns.length} user turns, ${assistantTurns.length} assistant turns, ${toolTurns.length} tool results.`,
      "",
    ];

    // List the first user message (the original goal) verbatim.
    if (userTurns.length > 0) {
      lines.push("### Original Goal");
      lines.push(userTurns[0].content.slice(0, 500));
      lines.push("");
    }

    // List the last assistant message (most recent state).
    if (assistantTurns.length > 0) {
      const last = assistantTurns[assistantTurns.length - 1];
      lines.push("### Most Recent Assistant Output");
      lines.push(last.content.slice(0, 500));
      lines.push("");
    }

    // List tool call summaries (name + truncated args).
    if (toolTurns.length > 0) {
      lines.push("### Tool Calls Made");
      for (const t of toolTurns.slice(0, 20)) {
        const name = t.name ?? t.toolCallId ?? "(unknown)";
        const preview = t.content.slice(0, 100).replace(/\n/g, " ");
        lines.push(`- ${name}: ${preview}`);
      }
      if (toolTurns.length > 20) {
        lines.push(`- ... and ${toolTurns.length - 20} more tool calls`);
      }
    }

    return lines.join("\n");
  }
}

// ── HistoryReducer ───────────────────────────────────────────────────────────

export class HistoryReducer {
  /**
   * Replace the oldest N messages with a single system message containing
   * the summary. Keep the most recent messages verbatim.
   */
  reduce(messages: ConversationMessage[], decision: CompactionDecision, summary: string): ConversationMessage[] {
    if (!decision.shouldCompact) return messages;

    const toCompact = messages.slice(0, decision.messagesToCompact);
    const toKeep = messages.slice(decision.messagesToCompact);

    // Preserve the system prompt if it exists (it's usually messages[0]).
    const systemMessages = toCompact.filter((m) => m.role === "system");
    const nonSystemToCompact = toCompact.filter((m) => m.role !== "system");

    // Build the summary message.
    const summaryMessage: ConversationMessage = {
      role: "system",
      content: `[Compacted History]\n\n${summary}\n\n(${nonSystemToCompact.length} messages compacted)`,
    };

    return [...systemMessages, summaryMessage, ...toKeep];
  }
}

// ── ContextRebuilder ─────────────────────────────────────────────────────────

export class ContextRebuilder {
  /**
   * Re-seat the compacted history into the ExecutionRequest's context.
   * This is a thin adapter: it returns the new message list for the caller
   * to pass to the model gateway.
   */
  rebuild(messages: ConversationMessage[], _request?: ExecutionRequest): ConversationMessage[] {
    // Currently a passthrough; future versions may re-inject workspace
    // context, file references, or other ContextProvider outputs.
    return messages;
  }
}

// ── CompactionService ─────────────────────────────────────────────────────────

export interface CompactionServiceOptions {
  policy?: CompactionPolicy;
  summaryProvider?: SummaryProvider;
}

export class CompactionService {
  readonly estimator: TokenEstimator;
  readonly policy: CompactionPolicy;
  readonly summaryProvider: SummaryProvider;
  readonly reducer: HistoryReducer;
  readonly rebuilder: ContextRebuilder;

  constructor(opts: CompactionServiceOptions = {}) {
    this.estimator = new TokenEstimator();
    this.policy = opts.policy ?? new CompactionPolicy();
    this.summaryProvider = opts.summaryProvider ?? new RuleBasedSummaryProvider();
    this.reducer = new HistoryReducer();
    this.rebuilder = new ContextRebuilder();
  }

  /** Check if compaction is needed (read-only). */
  evaluate(input: CompactionInput): CompactionDecision {
    return this.policy.decide(input);
  }

  /** Compact the conversation if needed. Returns the result + new messages. */
  async compact(input: CompactionInput): Promise<CompactionResult> {
    const decision = this.policy.decide(input);
    if (!decision.shouldCompact) {
      return {
        messages: input.messages,
        summary: "",
        removedCount: 0,
        tokensSaved: 0,
        decision,
      };
    }

    const toCompact = input.messages.slice(0, decision.messagesToCompact);
    const summary = await this.summaryProvider.summarize(toCompact);
    const newMessages = this.reducer.reduce(input.messages, decision, summary);
    const newTokens = this.estimator.estimateConversation(newMessages);
    const tokensSaved = Math.max(0, decision.estimatedTokens - newTokens);

    return {
      messages: newMessages,
      summary,
      removedCount: decision.messagesToCompact,
      tokensSaved,
      decision,
    };
  }
}
