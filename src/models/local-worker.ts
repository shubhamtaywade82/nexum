import type { ChatPort } from "./gateway/inference-dispatcher.js";

export type LocalTaskType = "ts_interface" | "regex" | "parse" | "format" | "test_skeleton" | "boilerplate";
export type LocalOutputType = "typescript" | "json" | "regex" | "text" | "code";

export interface LocalTask {
  type: LocalTaskType;
  /** The raw user prompt or the cloud-delegated sub-task prompt. */
  prompt: string;
  expectedOutput: LocalOutputType;
  /** Max tokens for the local model to generate. Default 400. */
  maxTokens?: number;
  /** Optional few-shot examples to prepend to the prompt. */
  examples?: Array<{ input: string; output: string }>;
}

export interface LocalResult {
  success: boolean;
  output?: string;
  error?: string;
  validationError?: string;
  /** Number of generation attempts (1 = first attempt succeeded, 2 = needed a retry). */
  attempts: number;
}

/**
 * Executes a single, stateless coding task on the local (small) model.
 *
 * The local model is treated as a pure text-in / text-out generator with
 * no tool access and no persistent state. It is never given multi-step or
 * reasoning tasks.
 *
 * On validation failure the worker retries exactly once with an improved
 * prompt that includes the validation error; on a second failure it returns
 * `{ success: false }` so the caller can fall back to the cloud model.
 */
export class LocalWorker {
  constructor(private readonly provider: ChatPort) {}

  async execute(task: LocalTask): Promise<LocalResult> {
    // First attempt
    try {
      const output = await this.generate(task.prompt, task);
      const validation = this.validateOutput(output, task.expectedOutput);
      if (validation.valid) {
        return { success: true, output, attempts: 1 };
      }

      // Retry with refined prompt
      const refinedPrompt = this.refinePrompt(task.prompt, validation.error ?? "invalid output");
      try {
        const output2 = await this.generate(refinedPrompt, task);
        const validation2 = this.validateOutput(output2, task.expectedOutput);
        if (validation2.valid) {
          return { success: true, output: output2, attempts: 2 };
        }
        return {
          success: false,
          validationError: validation2.error,
          error: "Output failed validation after 2 attempts",
          attempts: 2,
        };
      } catch (e2) {
        return { success: false, error: String(e2), attempts: 2 };
      }
    } catch (e) {
      return { success: false, error: String(e), attempts: 1 };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async generate(prompt: string, task: LocalTask): Promise<string> {
    const systemContent = this.buildSystemPrompt(task);
    const messages = [
      { role: "system" as const, content: systemContent },
      { role: "user" as const, content: prompt },
    ];
    const response = await this.provider.chat(messages);
    return this.stripCodeFences(response.message.content);
  }

  private buildSystemPrompt(task: LocalTask): string {
    let base: string;
    switch (task.type) {
      case "ts_interface":
        base =
          "You are a TypeScript typist. Output ONLY a valid TypeScript interface block. No markdown fences, no explanation.";
        break;
      case "regex":
        base =
          "Output ONLY the regex pattern as a JavaScript RegExp literal (e.g. /pattern/flags). No explanation, no extra text.";
        break;
      case "parse":
        base = "Extract the requested data from the input. Output ONLY valid JSON. No explanation, no markdown fences.";
        break;
      case "format":
        base = "Output ONLY the reformatted data in the requested format. No explanation.";
        break;
      case "test_skeleton":
        base =
          "Output ONLY the Jest test skeleton code. No markdown fences, no explanation. Use describe() and it() blocks.";
        break;
      case "boilerplate":
      default:
        base = "Output ONLY the requested code. No explanation, no markdown fences.";
        break;
    }

    if (!task.examples?.length) return base;

    const exampleBlock = task.examples.map((ex) => `Input: ${ex.input}\nOutput: ${ex.output}`).join("\n\n");

    return `${base}\n\nExamples:\n${exampleBlock}`;
  }

  /** Strips leading/trailing markdown code fences from model output. */
  stripCodeFences(text: string): string {
    return text
      .trim()
      .replace(/^```(?:typescript|ts|json|javascript|js|regex|text|code)?\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();
  }

  private validateOutput(text: string, type: LocalOutputType): { valid: boolean; error?: string } {
    const t = text.trim();
    if (!t) return { valid: false, error: "Empty output" };

    switch (type) {
      case "typescript": {
        if (!/\b(interface|type |class )\b/.test(t)) {
          return { valid: false, error: "No TypeScript declaration (interface/type/class) found" };
        }
        // Balanced brace check
        const opens = (t.match(/{/g) ?? []).length;
        const closes = (t.match(/}/g) ?? []).length;
        if (opens !== closes) {
          return { valid: false, error: `Unbalanced braces: ${opens} '{' vs ${closes} '}'` };
        }
        return { valid: true };
      }
      case "json": {
        try {
          JSON.parse(t);
          return { valid: true };
        } catch (e) {
          return { valid: false, error: `Invalid JSON: ${(e as Error).message}` };
        }
      }
      case "regex": {
        try {
          // Accept bare pattern or /pattern/flags literal
          const inner = t.startsWith("/") ? t.replace(/^\/(.+)\/[gimsuy]*$/, "$1") : t;
          new RegExp(inner);
          return { valid: true };
        } catch (e) {
          return { valid: false, error: `Invalid regex: ${(e as Error).message}` };
        }
      }
      case "text":
      case "code":
      default:
        return t.length > 5 ? { valid: true } : { valid: false, error: "Output too short" };
    }
  }

  private refinePrompt(original: string, error: string): string {
    return `${original}\n\n[Previous attempt failed validation: ${error}. Please correct the output and try again.]`;
  }
}
