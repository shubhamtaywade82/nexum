import { AgentConversation } from "../../src/cli/agent-conversation.js";
import type { Agent } from "../../src/cli/agent.js";

type EventHandler = (...args: unknown[]) => void;

export class FakeAgent {
  readonly conversation = new AgentConversation();
  readonly sessions = {
    adopt: (_id: string): void => {},
    resumeSessionById: (_id: string): null => null,
  };
  readonly execution: { signal: AbortSignal | null } = { signal: null };

  private abortController: AbortController | null = null;
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private customRunHandler?: (goal: string) => Promise<string>;

  on(event: string, handler: EventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) h(...args);
  }

  setRunHandler(handler: (goal: string) => Promise<string>): void {
    this.customRunHandler = handler;
  }

  async startHost(): Promise<void> {}
  async stopHost(): Promise<void> {}

  resumeSessionById(_id: string): null {
    return null;
  }

  startExecutionRun(): string {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.abortController = new AbortController();
    this.execution.signal = this.abortController.signal;
    return runId;
  }

  cancelExecutionRun(): boolean {
    if (!this.abortController || this.abortController.signal.aborted) {
      return false;
    }
    this.abortController.abort();
    return true;
  }

  endExecutionRun(): void {
    this.abortController = null;
    this.execution.signal = null;
  }

  async runUserMessage(goal: string): Promise<string> {
    if (this.customRunHandler) {
      return this.customRunHandler(goal);
    }
    this.emit("onThinking", "Analyzing request...");
    this.emit("onModelUsed", "fast", "fake-model");
    this.emit("onToolCall", "read_file", { path: "README.md" });
    this.emit("onToolResult", "read_file", { content: "# Nexum" });
    this.conversation.pushUserMessage(goal);
    this.conversation.pushAssistantMessage(`Finished task: ${goal}`);
    return `Finished task: ${goal}`;
  }

  asAgent(): Agent {
    return this as unknown as Agent;
  }
}
