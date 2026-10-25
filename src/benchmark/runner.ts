import { Provider, ChatMessage, ChatResponse, Tier } from "../models/adapters/provider.js";
import {
  AgenticBenchmarkCase,
  AgenticTrajectory,
  BenchmarkCase,
  BenchmarkResult,
  SingleTurnBenchmarkCase,
} from "./types.js";

export interface BenchmarkTarget {
  model: string;
  tier: Tier;
  provider: Provider;
}

interface CaseRunOutcome {
  pass: boolean;
  reason?: string;
  tokensPerSec: number | null;
  tokens: number;
  tokensEstimated: boolean;
}

export interface BenchmarkProgressEvent {
  model: string;
  tier: Tier;
  caseId: string;
  index: number;
  total: number;
  status: "running" | "done";
  pass?: boolean;
  reason?: string;
  latencyMs?: number;
  error?: string;
}

export interface BenchmarkToolCallEvent {
  model: string;
  tier: Tier;
  caseId: string;
  turn: number;
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface RunBenchmarkOptions {
  /**
   * Per-case wall-clock ceiling. Local-tier requests have no built-in timeout
   * (Provider's timeoutMs defaults to 0/disabled for local — a stalled Ollama
   * server or a stuck model load hangs forever with zero signal otherwise).
   * Default 2 minutes — generous for a single real local inference call,
   * including a multi-turn agentic case's several sequential calls.
   */
  timeoutMs?: number;
  onProgress?: (event: BenchmarkProgressEvent) => void;
  /** Fires per tool call inside an agentic case, as it resolves — the only way
   * to see what's happening mid-case before it either finishes or times out. */
  onToolCall?: (event: BenchmarkToolCallEvent) => void;
}

const DEFAULT_CASE_TIMEOUT_MS = 120_000;

// A plain array is reused as-is for every target. A factory is called fresh
// per target — required for any case whose `resolveTool` closes over mutable
// state (e.g. "error on the first call, succeed after"): without a fresh
// closure per target, that state would otherwise leak across different
// models' runs of the same case object.
export async function runBenchmark(
  targets: BenchmarkTarget[],
  cases: BenchmarkCase[] | (() => BenchmarkCase[]),
  opts: RunBenchmarkOptions = {},
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;

  for (const target of targets) {
    target.provider.setModel(target.model);
    target.provider.setTier(target.tier);

    const caseList = typeof cases === "function" ? cases() : cases;
    const total = caseList.length;
    let modelUnavailableError: string | null = null;

    for (let index = 0; index < caseList.length; index++) {
      const testCase = caseList[index];

      if (modelUnavailableError) {
        results.push({
          model: target.model,
          tier: target.tier,
          caseId: testCase.id,
          category: testCase.category,
          pass: false,
          latencyMs: 0,
          tokensPerSec: null,
          tokens: 0,
          tokensEstimated: false,
          error: modelUnavailableError,
        });
        opts.onProgress?.({
          model: target.model,
          tier: target.tier,
          caseId: testCase.id,
          index,
          total,
          status: "done",
          pass: false,
          latencyMs: 0,
          error: modelUnavailableError,
        });
        continue;
      }

      opts.onProgress?.({
        model: target.model,
        tier: target.tier,
        caseId: testCase.id,
        index,
        total,
        status: "running",
      });

      const start = Date.now();
      try {
        const outcome = await withTimeout(
          testCase.kind === "agentic"
            ? runAgenticTurn(target, testCase, opts.onToolCall)
            : runSingleTurn(target, testCase),
          timeoutMs,
        );
        const latencyMs = Date.now() - start;
        results.push({
          model: target.model,
          tier: target.tier,
          caseId: testCase.id,
          category: testCase.category,
          latencyMs,
          ...outcome,
        });
        opts.onProgress?.({
          model: target.model,
          tier: target.tier,
          caseId: testCase.id,
          index,
          total,
          status: "done",
          pass: outcome.pass,
          reason: outcome.reason,
          latencyMs,
        });
      } catch (e) {
        const latencyMs = Date.now() - start;
        const error = e instanceof Error ? e.message : String(e);
        if (error.includes("402") || error.includes("does not support chat")) {
          modelUnavailableError = error;
        }
        results.push({
          model: target.model,
          tier: target.tier,
          caseId: testCase.id,
          category: testCase.category,
          pass: false,
          latencyMs,
          tokensPerSec: null,
          tokens: 0,
          tokensEstimated: false,
          error,
        });
        opts.onProgress?.({
          model: target.model,
          tier: target.tier,
          caseId: testCase.id,
          index,
          total,
          status: "done",
          pass: false,
          latencyMs,
          error,
        });
      }
    }
  }

  return results;
}

// ponytail: doesn't abort the underlying request on timeout, just stops
// waiting on it — the real fetch keeps running in the background until it
// finishes or errors on its own. Plumb an AbortSignal through Provider.chat
// if wasted background requests become a real problem (e.g. rate limits).
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function runSingleTurn(target: BenchmarkTarget, testCase: SingleTurnBenchmarkCase): Promise<CaseRunOutcome> {
  const start = Date.now();
  const response = await target.provider.chat(testCase.messages, {
    tools: testCase.tools,
    stream: false,
  });
  const { pass, reason } = testCase.validate(response);
  return {
    pass,
    reason,
    tokensPerSec: estimateTokensPerSec(response, Date.now() - start),
    ...usageFor(response),
  };
}

// Standalone ReAct-style loop, deliberately not reusing Agent.runUserMessage —
// no conversation pruning, no capability routing, no tool registry side effects
// beyond what the case's own `resolveTool` does. Mirrors the shape of the real
// agent loop (src/cli/agent.ts) closely enough that findings here transfer.
async function runAgenticTurn(
  target: BenchmarkTarget,
  testCase: AgenticBenchmarkCase,
  onToolCall?: (event: BenchmarkToolCallEvent) => void,
): Promise<CaseRunOutcome> {
  const start = Date.now();
  const messages: ChatMessage[] = [...testCase.messages];
  const toolCallsMade: AgenticTrajectory["toolCallsMade"] = [];
  let finalContent = "";
  let hitMaxTurns = true;
  let turns = 0;
  let lastResponse: ChatResponse | undefined;
  // Every turn bills its full prompt again, so the case's cost is the sum over all turns.
  let tokens = 0;
  let tokensEstimated = false;

  for (; turns < testCase.maxTurns; turns++) {
    const response = await target.provider.chat(messages, { tools: testCase.tools, stream: false });
    lastResponse = response;
    const usage = usageFor(response);
    tokens += usage.tokens;
    tokensEstimated ||= usage.tokensEstimated;
    const assistantMessage = response.message as {
      content?: string;
      tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
    };
    messages.push({
      role: "assistant",
      content: assistantMessage.content ?? "",
      tool_calls: assistantMessage.tool_calls,
    });

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (!toolCalls.length) {
      finalContent = assistantMessage.content ?? "";
      hitMaxTurns = false;
      break;
    }

    for (const call of toolCalls) {
      const name = call.function.name;
      const rawArgs = call.function.arguments;
      const args =
        typeof rawArgs === "object" && rawArgs !== null
          ? (rawArgs as Record<string, unknown>)
          : typeof rawArgs === "string"
            ? (tryParseJson(rawArgs) ?? {})
            : {};
      const result = await testCase.resolveTool(name, args);
      toolCallsMade.push({ name, args, result });
      messages.push({ role: "tool", content: JSON.stringify(result) });
      onToolCall?.({ model: target.model, tier: target.tier, caseId: testCase.id, turn: turns, name, args, result });
    }
  }

  const trajectory: AgenticTrajectory = { finalContent, toolCallsMade, turns, hitMaxTurns };
  const { pass, reason } = testCase.validate(trajectory);
  return {
    pass,
    reason,
    tokensPerSec: lastResponse ? estimateTokensPerSec(lastResponse, Date.now() - start) : null,
    tokens,
    tokensEstimated,
  };
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Tokens one response consumed: the provider's prompt and completion counts
 * (Ollama's prompt_eval_count and eval_count). Only when the provider reports
 * neither does it fall back to a content-length estimate, which counts the
 * completion alone and so is a lower bound; `tokensEstimated` marks that case.
 */
export function usageFor(response: ChatResponse): { tokens: number; tokensEstimated: boolean } {
  const promptTokens = response.prompt_eval_count as number | undefined;
  const completionTokens = response.eval_count as number | undefined;
  if (typeof promptTokens === "number" && typeof completionTokens === "number") {
    return { tokens: promptTokens + completionTokens, tokensEstimated: false };
  }
  const content = response.message?.content ?? "";
  return { tokens: Math.ceil(content.length / 4), tokensEstimated: true };
}

// Ollama's /api/chat response includes eval_count/eval_duration (ns) on the
// final chunk when available; fall back to a rough content-length estimate
// (~4 chars/token) when a provider doesn't report them.
function estimateTokensPerSec(response: ChatResponse, latencyMs: number): number | null {
  const evalCount = response.eval_count as number | undefined;
  const evalDurationNs = response.eval_duration as number | undefined;
  if (typeof evalCount === "number" && typeof evalDurationNs === "number" && evalDurationNs > 0) {
    return evalCount / (evalDurationNs / 1e9);
  }
  if (latencyMs <= 0) return null;
  const content = response.message?.content ?? "";
  const estimatedTokens = content.length / 4;
  return estimatedTokens / (latencyMs / 1000);
}
