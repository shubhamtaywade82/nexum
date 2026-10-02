import { ChatMessage } from "../models/adapters/provider.js";
import { CliConfig } from "./config.js";
import { SkillContent } from "../skills/types.js";
import { LOCAL_DELEGATION_SYSTEM_ADDENDUM } from "../tools/delegate-tool.js";

interface LearningEntry {
  category: string;
  lesson: string;
}

export class AgentConversation {
  private messages: ChatMessage[] = [];
  // The current task's own request — set only by pushUserMessage (once per
  // runUserMessage call), never by pushSystemMessage's synthetic nudges (which
  // also push role:"user"). pruneContext keeps this even once it ages out of
  // the "last 10" window, so a long tool-loop never silently loses the ask.
  private currentTurnUserMessage: ChatMessage | null = null;

  /** Run-scoped output instructions (e.g. an OpenUI spec); the system prompt is
   * rebuilt every turn, so clearing this keeps them out of later runs. */
  presentationInstructions = "";

  buildSystemPrompt(config: CliConfig, learnings: LearningEntry[], _skills: SkillContent[]): string {
    const learningsBlock =
      learnings.length > 0
        ? "\n\n[Recalled Past Learnings & User Preferences]:\n" +
          learnings.map((l) => `- [${l.category}] Lesson: ${l.lesson}`).join("\n")
        : "";

    // Cloud-primary sessions start already-escalated (see agent.ts's
    // `escalated` initializer), so the per-turn escalation-triggered
    // injection of this addendum never fires for them — bake it into the
    // persistent prompt instead, gated on the same enableLocalWorker flag
    // the constructor uses to decide whether LocalWorker/delegate_to_local
    // even exist this session.
    const delegationBlock =
      config.tier === "cloud" && config.enableLocalWorker !== false ? `\n\n${LOCAL_DELEGATION_SYSTEM_ADDENDUM}` : "";

    const presentationBlock = this.presentationInstructions ? `\n\n${this.presentationInstructions}` : "";

    return (
      (config.systemPrompt ?? "") +
      learningsBlock +
      delegationBlock +
      presentationBlock +
      "\n\nTool contract:\n" +
      "1) Call exactly one tool per assistant turn when appropriate.\n" +
      "2) If read_file returns `truncated`, that is a content ceiling, not an instruction to stop.\n" +
      "3) `PathEscapeError` means the path escaped the workspace root; fix the path and retry.\n" +
      "4) After tool results, continue toward the user's stated goal with minimal next steps.\n" +
      "5) Semantic tools (get_definition, find_references, workspace_symbols, document_symbols, hover, diagnostics) provide structured code intelligence for supported file types. Prefer these over raw text search for code understanding.\n" +
      "6) Use search_code / read_file as fallback when semantic tools are unavailable for a file type.\n" +
      "7) In Rails workspaces, prefer the Rails semantic tools (find_model, find_route, find_controller, find_service, find_spec, find_association, find_callback, rails_context) over reading files — they answer framework questions (routes, associations, callbacks, spec coverage) directly from the semantic index."
    );
  }

  init(config: CliConfig, learnings: LearningEntry[], skills: SkillContent[]): void {
    const header = this.buildSystemPrompt(config, learnings, skills);
    this.messages = [{ role: "system", content: header }];
  }

  refreshSystemPrompt(config: CliConfig, learnings: LearningEntry[], skills: SkillContent[]): void {
    const header = this.buildSystemPrompt(config, learnings, skills);
    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages[0].content = header;
    } else {
      this.messages.unshift({ role: "system", content: header });
    }
  }

  /** Skill bodies already present in the transcript, so a skill that stays
   * active across many turns is injected once rather than re-appended every
   * turn — that duplicated the full body per turn and crowded out real
   * context. Cleared by reset()/loadMessages(), which replace the transcript. */
  private readonly injectedSkills = new Set<string>();

  /** Messages that survive pruning — skill bodies are standing instructions,
   * like the system prompt, not conversational history. Identity-based so
   * pruneContext can keep exactly these without pattern-matching content. */
  private readonly pinned = new Set<ChatMessage>();

  injectSkill(skill: SkillContent): void {
    if (this.injectedSkills.has(skill.id)) return;
    this.injectedSkills.add(skill.id);
    const message: ChatMessage = { role: "system", content: `Skill: ${skill.name}\n\n${skill.body}` };
    this.pinned.add(message);
    this.messages.push(message);
  }

  pushUserMessage(content: string): void {
    const message: ChatMessage = { role: "user", content };
    this.messages.push(message);
    this.currentTurnUserMessage = message;
  }

  pushAssistantMessage(content: string, tool_calls?: ChatMessage["tool_calls"]): void {
    this.messages.push({ role: "assistant", content, tool_calls } as ChatMessage);
  }

  pushToolResult(content: string): void {
    this.messages.push({ role: "tool", content });
  }

  pushSystemMessage(content: string): void {
    this.messages.push({ role: "user", content });
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /** Replaces the whole transcript, e.g. when resuming a persisted session.
   * The next runUserMessage call refreshes message[0]'s system prompt in
   * place via refreshSystemPrompt, so a stale saved prompt self-heals. */
  loadMessages(messages: ChatMessage[]): void {
    this.messages = messages;
    this.currentTurnUserMessage = null;
    this.injectedSkills.clear();
    this.pinned.clear();
  }

  pruneContext(maxMessages = 25): void {
    if (this.messages.length <= maxMessages) return;

    const systemPrompt = this.messages[0];
    // A `role:"tool"` message only makes sense directly after the assistant
    // message whose tool_calls produced it. Cutting on a fixed message count
    // could put an orphaned tool result at the head of the window, which
    // providers either reject or silently misread. Walk forward to the first
    // message that can legally start a window instead.
    let recent = this.messages.slice(-10);
    while (recent.length > 0 && recent[0].role === "tool") recent = recent.slice(1);

    const dropped = this.messages.slice(1, this.messages.length - recent.length);
    const toolRunCount = dropped.filter((m) => m.role === "tool").length;
    const summaryText = `[system] Bypassed ${dropped.length} intermediate turns (${toolRunCount} tool calls) to save context window.`;

    // Skills are standing instructions; dropping them mid-task silently
    // changed the agent's behaviour, and injectSkill's dedup meant they were
    // never re-added.
    const pinned = dropped.filter((m) => this.pinned.has(m));

    const preserved =
      this.currentTurnUserMessage && !recent.includes(this.currentTurnUserMessage) ? [this.currentTurnUserMessage] : [];

    this.messages = [systemPrompt, ...pinned, { role: "system", content: summaryText }, ...preserved, ...recent];
  }

  reset(): void {
    this.messages = [];
    this.currentTurnUserMessage = null;
    this.injectedSkills.clear();
    this.pinned.clear();
  }

  isEmpty(): boolean {
    return this.messages.length === 0;
  }
}
