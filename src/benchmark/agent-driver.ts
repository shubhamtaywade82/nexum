import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OllamaToolSchema } from "../models/adapters/provider.js";
import type { LegacyToolMetadata } from "../tools/gateway/tool-catalog.js";
import { Tool } from "../tools/tool.js";
import type { AgenticCaseDriver, BenchmarkTarget, CaseRunOutcome } from "./runner.js";
import type { AgenticBenchmarkCase, AgenticToolCall, AgenticTrajectory } from "./types.js";

/**
 * Runs agentic benchmark cases through the harness's own `Agent`.
 *
 * The runner's standalone loop calls the model directly, so its score cannot
 * move when the system prompt, tool selection, routing, loop control, context
 * management or answer gate change. Those are exactly what harness evolution
 * mutates. This driver sends the case's request to `Agent.runUserMessage`, so
 * the candidate's own code decides how the case is worked.
 *
 * The case still defines the environment. The agent's tools are replaced with
 * the case's tools, wrapped so every call resolves through the case's
 * `resolveTool`, and nothing built in (shell, filesystem, network) is reachable.
 * Each case gets a fresh agent in its own scratch workspace, so no conversation
 * or state carries from one case to the next.
 */

/** The agent events the driver listens to. `Agent` accepts these through its `events` option. */
export interface BenchmarkAgentEvents {
  onModelUsed: (
    tier: string,
    model: string,
    usage?: { promptTokens: number; completionTokens: number; latencyMs: number },
  ) => void;
  onBackgroundModelUsage: (info: {
    purpose: "summary";
    model: string;
    promptTokens: number | null;
    completionTokens: number | null;
  }) => void;
}

/** What the driver needs from an agent. `Agent` satisfies it. */
export interface BenchmarkAgent {
  readonly tools: { replaceAllTools(tools: Tool[], meta?: LegacyToolMetadata, category?: string): void };
  runUserMessage(message: string): Promise<string>;
  /** Background model work (the conversation summary) is part of the case's cost, so the driver waits for it. */
  whenIdle(): Promise<void>;
  stopHost(): Promise<void>;
}

export type BenchmarkAgentFactory = (input: {
  workspaceRoot: string;
  target: BenchmarkTarget;
  events: BenchmarkAgentEvents;
}) => BenchmarkAgent | Promise<BenchmarkAgent>;

/**
 * Case tools are scripted or read-only on a scratch workspace, so they carry
 * no side effects and need no confirmation. The agent's own approval policy is
 * left as configured; nothing here turns on auto-approval.
 */
const CASE_TOOL_METADATA: LegacyToolMetadata = { risk: "read", policy: { confirmation: "never" } };

class CaseTool extends Tool {
  constructor(
    private readonly toolSchema: OllamaToolSchema,
    private readonly invoke: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) {
    super();
  }

  get name(): string {
    return this.toolSchema.function.name;
  }

  get description(): string {
    return this.toolSchema.function.description ?? "";
  }

  get parameters(): Record<string, unknown> {
    return (this.toolSchema.function.parameters as Record<string, unknown> | undefined) ?? { type: "object" };
  }

  call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.invoke(args);
  }
}

/** The request the agent receives: the case's messages, in order, as one user message. */
export function caseRequest(testCase: AgenticBenchmarkCase): string {
  return testCase.messages
    .map((m) => m.content)
    .filter((content) => content.trim().length > 0)
    .join("\n\n");
}

export function createAgentDriver(createAgent: BenchmarkAgentFactory): AgenticCaseDriver {
  return async (target, testCase): Promise<CaseRunOutcome> => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "nexum-bench-agent-"));
    const toolCallsMade: AgenticToolCall[] = [];
    const modelsUsed = new Set<string>();
    let modelCalls = 0;
    let tokens = 0;
    let usageMissing = false;
    // The standalone loop caps model turns. The agent's loop cap is its own, so
    // the case's budget is enforced on tool calls: past it, a call returns an
    // error instead of a result, and the trajectory records the cut-off.
    let budgetExhausted = false;

    const events: BenchmarkAgentEvents = {
      onModelUsed: (_tier, model, usage) => {
        modelCalls += 1;
        modelsUsed.add(model);
        if (usage) tokens += usage.promptTokens + usage.completionTokens;
        else usageMissing = true;
      },
      onBackgroundModelUsage: ({ model, promptTokens, completionTokens }) => {
        modelsUsed.add(model);
        if (promptTokens === null || completionTokens === null) usageMissing = true;
        else tokens += promptTokens + completionTokens;
      },
    };

    const invoke = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (toolCallsMade.length >= testCase.maxTurns) {
        budgetExhausted = true;
        return { error: `tool-call budget of ${testCase.maxTurns} for this case is exhausted` };
      }
      const result = await testCase.resolveTool(name, args);
      toolCallsMade.push({ name, args, result });
      return result;
    };

    let agent: BenchmarkAgent | undefined;
    const start = Date.now();
    try {
      agent = await createAgent({ workspaceRoot, target, events });
      agent.tools.replaceAllTools(
        testCase.tools.map((schema) => new CaseTool(schema, (args) => invoke(schema.function.name, args))),
        CASE_TOOL_METADATA,
      );
      const finalContent = await agent.runUserMessage(caseRequest(testCase));
      await agent.whenIdle();
      const trajectory: AgenticTrajectory = {
        finalContent,
        toolCallsMade,
        turns: modelCalls,
        hitMaxTurns: budgetExhausted,
      };
      const { pass, reason } = testCase.validate(trajectory);
      const elapsedSec = (Date.now() - start) / 1000;
      return {
        pass,
        reason,
        tokensPerSec: tokens > 0 && elapsedSec > 0 ? tokens / elapsedSec : null,
        tokens,
        // A model call without reported usage makes the total a lower bound.
        tokensEstimated: usageMissing,
        modelsUsed: [...modelsUsed].sort(),
      };
    } finally {
      await agent?.stopHost().catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}
