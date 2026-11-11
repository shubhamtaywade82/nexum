import { Tool } from "./tool.js";
import { ChatMessage, ChatResponse } from "../models/adapters/provider.js";
import type { ChatPort } from "../models/gateway/inference-dispatcher.js";

export type SelectionMode = "heuristic" | "llm" | "hybrid";

export interface SelectorOptions {
  mode?: SelectionMode;
  maxActiveTools?: number;
  provider?: ChatPort;
  /**
   * Optional override for the LLM-mode chat call, used in place of
   * `provider.chat` when given — e.g. route through the capability-routed
   * "quick" tier (a small always-resident model) instead of calling a fixed
   * Provider directly. Falls back to `provider.chat` when omitted.
   */
  chat?: (messages: ChatMessage[]) => Promise<ChatResponse>;
}

export class DynamicToolSelector {
  private readonly mode: SelectionMode;
  private readonly maxActiveTools: number;
  private readonly provider?: ChatPort;
  private readonly chatOverride?: (messages: ChatMessage[]) => Promise<ChatResponse>;

  constructor(opts: SelectorOptions = {}) {
    this.mode = opts.mode ?? "heuristic";
    this.maxActiveTools = opts.maxActiveTools ?? 8;
    this.provider = opts.provider;
    this.chatOverride = opts.chat;
  }

  async selectTools(prompt: string, history: ChatMessage[], availableTools: Tool[]): Promise<Tool[]> {
    if (availableTools.length === 0) return [];

    if (this.mode === "heuristic") {
      return this.heuristicSelect(prompt, history, availableTools);
    }

    if (this.mode === "llm") {
      if (!this.provider && !this.chatOverride) {
        return this.heuristicSelect(prompt, history, availableTools);
      }
      try {
        return await this.llmSelect(prompt, history, availableTools);
      } catch {
        return this.heuristicSelect(prompt, history, availableTools);
      }
    }

    // Hybrid mode: Try heuristic first. If we have high confidence matches, use them.
    // Otherwise, fall back to LLM intent analysis if provider is available.
    const heuristicResults = this.heuristicSelectWithScores(prompt, history, availableTools);
    const topScore = heuristicResults.length > 0 ? heuristicResults[0].score : 0;

    // If we have clear matches (score >= 3) and it contains basic shell/file operations, use heuristic
    if (topScore >= 3.0 && this.hasBasicTools(heuristicResults.map((r) => r.tool))) {
      return heuristicResults.map((r) => r.tool).slice(0, this.maxActiveTools);
    }

    if (this.provider || this.chatOverride) {
      try {
        return await this.llmSelect(prompt, history, availableTools);
      } catch {
        // Fallback to heuristic on LLM failure
      }
    }

    return heuristicResults.map((r) => r.tool).slice(0, this.maxActiveTools);
  }

  private heuristicSelect(prompt: string, history: ChatMessage[], tools: Tool[]): Tool[] {
    return this.heuristicSelectWithScores(prompt, history, tools)
      .map((r) => r.tool)
      .slice(0, this.maxActiveTools);
  }

  private static readonly STOPWORDS = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "to",
    "in",
    "on",
    "for",
    "with",
    "this",
    "that",
    "what",
    "which",
    "who",
    "whom",
    "how",
    "why",
    "when",
    "where",
    "does",
    "do",
    "did",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "s",
    "it",
    "its",
    "as",
    "at",
    "by",
    "from",
    "into",
    "if",
    "than",
    "then",
  ]);

  private heuristicSelectWithScores(
    prompt: string,
    history: ChatMessage[],
    tools: Tool[],
  ): Array<{ tool: Tool; score: number }> {
    const textToAnalyze = (
      prompt +
      " " +
      history
        .slice(-3)
        .map((m) => m.content ?? "")
        .join(" ")
    ).toLowerCase();

    // Filler-word overlap ("the", "what", "s" from "what's", etc.) used to be
    // able to outscore a genuinely relevant tool — a verbose description
    // repeating "the" a few times could beat a tool whose only match was one
    // real content word. Stopwords are excluded on both sides so they can
    // never contribute score.
    const queryTokens = new Set(
      (textToAnalyze.match(/[a-z0-9]+/g) ?? []).filter((t) => !DynamicToolSelector.STOPWORDS.has(t)),
    );

    return tools
      .map((tool) => {
        let score = 0;

        // 1. Match tool name tokens
        const nameTokens = tool.name.toLowerCase().split(/[_-]/);
        for (const token of nameTokens) {
          if (queryTokens.has(token)) score += 3.0;
        }

        // 2. Match exact tool name
        if (queryTokens.has(tool.name.toLowerCase())) {
          score += 5.0;
        }

        // 3. Match capabilities
        const caps = tool.capabilities;
        if (caps && Array.isArray(caps)) {
          for (const cap of caps) {
            const capTokens = cap.toLowerCase().split(/\s+/);
            for (const token of capTokens) {
              if (queryTokens.has(token)) score += 2.0;
            }
          }
        }

        // 4. Match tags
        const tags = tool.tags;
        if (tags && Array.isArray(tags)) {
          for (const tag of tags) {
            if (queryTokens.has(tag.toLowerCase())) {
              score += 2.5;
            }
          }
        }

        // 5. Match description words — deduped, so a description repeating
        // the same word several times can't inflate score past a genuine
        // one-word match elsewhere.
        const descTokens = new Set(tool.description.toLowerCase().match(/[a-z0-9]+/g) ?? []);
        for (const token of descTokens) {
          if (queryTokens.has(token)) score += 0.5;
        }

        // Baseline boost for critical tools — only reinforces a tool that
        // already has some real signal. Applying it unconditionally used to
        // manufacture relevance from zero matches, so a bare "hi" (nothing
        // matched at all) still surfaced read_file/write_file/run_shell as
        // "active tools" and an eager model would use one just because it
        // was offered.
        if (score > 0 && ["read_file", "write_file", "run_shell"].includes(tool.name)) {
          score += 1.0;
        }

        return { tool, score };
      })
      .filter((r) => r.score > 0.5)
      .sort((a, b) => b.score - a.score);
  }

  private async llmSelect(prompt: string, history: ChatMessage[], tools: Tool[]): Promise<Tool[]> {
    if (!this.provider && !this.chatOverride) throw new Error("No provider specified for LLM tool selection");

    const toolDescriptions = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
    const systemPrompt = `You are an expert developer coordinator. Analyze the user request and history and identify the subset of tools required for the immediate next step.
Available Tools:
${toolDescriptions}

Your output MUST be a JSON array of tool name strings, and nothing else. Do not wrap in markdown blocks.
Example: ["read_file", "run_shell"]`;

    const userMsg = `User Request: ${prompt}\nLast History Context: ${history.slice(-1)[0]?.content ?? "(None)"}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ];
    const res = this.chatOverride
      ? await this.chatOverride(messages)
      : await this.provider!.chat(messages, { stream: false });

    const content = res.message.content.trim();
    const jsonStr = content
      .replace(/^```json\s*/i, "")
      .replace(/```$/, "")
      .trim();

    try {
      const toolNames = JSON.parse(jsonStr) as string[];
      if (Array.isArray(toolNames)) {
        const selected = tools.filter((t) => toolNames.includes(t.name));
        if (selected.length > 0) {
          return selected.slice(0, this.maxActiveTools);
        }
      }
    } catch {
      // JSON parse error or empty array fallback
    }

    // Default fallback
    return tools.filter((t) => ["read_file", "run_shell", "patch_file"].includes(t.name)).slice(0, this.maxActiveTools);
  }

  private hasBasicTools(tools: Tool[]): boolean {
    return tools.some((t) => ["read_file", "run_shell"].includes(t.name));
  }
}
