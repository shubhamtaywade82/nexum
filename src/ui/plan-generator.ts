import { Provider, ChatMessage } from "../models/adapters/provider.js";
import { HistoryEntry, PlanStep } from "../orchestration/types.js";

export class PlanGenerationError extends Error {}

const PLAN_PROMPT = `Decompose the following task into a short ordered list of steps.
Respond with ONLY a JSON array, no prose, in this exact shape:
[{"id": "s1", "description": "...", "dependencies": [], "verify": "..."}, ...]
Each step's "dependencies" lists the "id"s of steps that must complete first (empty array if none).
"verify" is optional: a shell command that exits 0 only when the step is done (e.g. a focused test run). Omit it when no command can prove the step.`;

interface RawStep {
  id: unknown;
  description: unknown;
  dependencies: unknown;
  verify?: unknown;
}

function extractJsonArray(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new PlanGenerationError(`model response did not contain a JSON array: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new PlanGenerationError(
      `model response contained malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function validateSteps(parsed: unknown): PlanStep[] {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new PlanGenerationError("model response was not a non-empty JSON array");
  }
  return parsed.map((raw: RawStep, i) => {
    if (typeof raw.id !== "string" || typeof raw.description !== "string" || !Array.isArray(raw.dependencies)) {
      throw new PlanGenerationError(`step at index ${i} is missing required fields (id, description, dependencies)`);
    }
    if (!raw.dependencies.every((dep) => typeof dep === "string")) {
      throw new PlanGenerationError(`step at index ${i} has invalid dependencies: all elements must be strings`);
    }
    const verify = typeof raw.verify === "string" && raw.verify.trim() ? raw.verify.trim() : undefined;
    return {
      id: raw.id,
      description: raw.description,
      dependencies: raw.dependencies as string[],
      status: "pending",
      retryCount: 0,
      ...(verify ? { verify } : {}),
    };
  });
}

export async function generatePlan(userRequest: string, provider: Provider): Promise<PlanStep[]> {
  const messages: ChatMessage[] = [
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: userRequest },
  ];
  const response = await provider.chat(messages, { stream: false });
  const content = response.message?.content ?? "";
  const parsed = extractJsonArray(content);
  return validateSteps(parsed);
}

/** Orchestrator.Planner backed by the model: on a step failure, asks it to
 * revise the remaining steps around what went wrong. Reuses the same JSON
 * step format as the initial plan. */
export async function replanSteps(
  remaining: PlanStep[],
  history: HistoryEntry[],
  provider: Provider,
): Promise<PlanStep[]> {
  const failures = history
    .filter((h) => h.outcome.kind !== "success")
    .map((h) => `- ${h.stepId}: ${h.outcome.kind === "success" ? "" : h.outcome.error}`)
    .join("\n");
  const remainingSummary = JSON.stringify(
    remaining.map((s) => ({
      id: s.id,
      description: s.description,
      dependencies: s.dependencies,
      ...(s.verify ? { verify: s.verify } : {}),
    })),
  );
  const messages: ChatMessage[] = [
    { role: "system", content: PLAN_PROMPT },
    {
      role: "user",
      content:
        `Some steps in this plan failed. Remaining steps:\n${remainingSummary}\n\n` +
        `Failures so far:\n${failures}\n\n` +
        `Revise the remaining steps to work around these failures (different approach, split a step, or drop what's no longer needed). Respond with ONLY the revised JSON array in the same shape.`,
    },
  ];
  const response = await provider.chat(messages, { stream: false });
  const content = response.message?.content ?? "";
  return validateSteps(extractJsonArray(content));
}
