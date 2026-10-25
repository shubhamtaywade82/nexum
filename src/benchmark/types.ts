import { ChatMessage, ChatResponse, OllamaToolSchema, Tier } from "../models/adapters/provider.js";

export type BenchmarkCategory =
  | "output-format"
  | "tool-calling"
  | "reasoning"
  | "thinking"
  | "agentic-looping"
  | "error-recovery"
  | "escalation"
  | "execution";

interface BenchmarkCaseBase {
  id: string;
  description: string;
  category?: BenchmarkCategory;
}

export interface SingleTurnBenchmarkCase extends BenchmarkCaseBase {
  kind?: "single-turn";
  messages: ChatMessage[];
  tools?: OllamaToolSchema[];
  validate: (response: ChatResponse) => { pass: boolean; reason?: string };
}

/** One resolved tool call within an agentic-case trajectory. */
export interface AgenticToolCall {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

/** The full record of a multi-turn agentic case run, handed to `validate`. */
export interface AgenticTrajectory {
  finalContent: string;
  toolCallsMade: AgenticToolCall[];
  turns: number;
  /** True if the loop was cut off by maxTurns without the model producing a final (no-tool-call) answer. */
  hitMaxTurns: boolean;
}

/**
 * A multi-turn ReAct-style case: the model can call tools, see results, and
 * keep going until it answers with no tool call or `maxTurns` is reached.
 * `resolveTool` is either a scripted mock (for deterministic ReAct/error-recovery
 * cases) or a real `Registry.invoke` bound to a temp workspace (for genuine
 * end-to-end tool execution cases) — the runner doesn't care which.
 */
export interface AgenticBenchmarkCase extends BenchmarkCaseBase {
  kind: "agentic";
  messages: ChatMessage[];
  tools: OllamaToolSchema[];
  maxTurns: number;
  resolveTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  validate: (trajectory: AgenticTrajectory) => { pass: boolean; reason?: string };
}

export type BenchmarkCase = SingleTurnBenchmarkCase | AgenticBenchmarkCase;

export interface BenchmarkResult {
  model: string;
  tier: Tier;
  caseId: string;
  category?: BenchmarkCategory;
  pass: boolean;
  reason?: string;
  latencyMs: number;
  tokensPerSec: number | null;
  /** Prompt plus completion tokens the case consumed, summed over every turn. 0 when no response came back. */
  tokens: number;
  /** True when `tokens` is a content-length estimate because the provider reported no usage counts. */
  tokensEstimated: boolean;
  /** "agent" when the case ran through the harness's own Agent, "model" for the standalone model loop. */
  driver?: "model" | "agent";
  /** Models the harness actually called (agent driver only); routing may pick models besides `model`. */
  modelsUsed?: string[];
  error?: string;
}

export interface ModelScore {
  model: string;
  tier: Tier;
  cases: number;
  passRate: number;
  avgLatencyMs: number;
  avgTokensPerSec: number | null;
}

export interface CategoryScore {
  category: string;
  cases: number;
  passRate: number;
}
