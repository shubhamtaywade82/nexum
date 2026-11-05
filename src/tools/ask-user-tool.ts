import { randomUUID } from "node:crypto";
import { Tool } from "./tool.js";
import { ClarificationOption, ClarificationRequest, ClarificationResponse } from "../runtime/types.js";

export interface ClarificationRequester {
  requestClarification(request: ClarificationRequest): Promise<ClarificationResponse>;
}

export class AskUserTool extends Tool {
  constructor(private readonly requester: ClarificationRequester) {
    super();
  }

  get name(): string {
    return "ask_user";
  }

  get description(): string {
    return (
      "Ask the user a structured multiple-choice question when requirements, design decisions, " +
      "or implementation trade-offs are ambiguous. The user will be presented with the options " +
      "and can select one or provide custom instructions."
    );
  }

  get tags(): string[] {
    return ["interaction", "clarification"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        question: { type: "string", description: "The clarifying question to ask the user" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "List of 2-6 clear, mutually exclusive choices for the user",
        },
      },
      required: ["question", "options"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) return { error: "Question cannot be empty" };

    const rawOptions = Array.isArray(args.options) ? (args.options as unknown[]) : [];
    const optionStrings = rawOptions.filter((o): o is string => typeof o === "string" && o.trim().length > 0);
    if (optionStrings.length < 2) return { error: "At least 2 options are required" };

    const options: ClarificationOption[] = optionStrings.map((opt, i) => ({
      id: `opt_${i + 1}`,
      label: opt.trim(),
    }));

    options.push({
      id: "custom",
      label: "Custom instructions...",
      detail: "Specify custom instructions",
      isCustom: true,
    });

    const id = `ask-${randomUUID()}`;
    const response = await this.requester.requestClarification({
      id,
      prompt: question,
      question,
      options,
      allowCustom: true,
    });

    if (response.customText) {
      return { selected: "custom", customInstructions: response.customText };
    }
    const chosen = options.find((o) => o.id === response.selectedId);
    return { selected: chosen?.label ?? response.selectedId };
  }
}
