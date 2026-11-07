import { randomUUID } from "node:crypto";
import { Episode, ToolEvent } from "./types.js";

/**
 * Builds one Episode per runUserMessage call by observing the Agent's
 * existing event surface. It stores compact outcomes rather than full tool
 * payloads, keeping persisted traces cheap and safe to reflect on.
 */
export class EpisodeRecorder {
  private current: Episode | null = null;
  private readonly pendingCalls = new Map<string, { args: Record<string, unknown>; at: number }>();

  begin(goal: string, activatedSkillIds: string[], parentEpisodeId?: string): void {
    this.current = {
      id: randomUUID(),
      goal: goal.slice(0, 2000),
      startedAt: Date.now(),
      endedAt: 0,
      toolEvents: [],
      activatedSkillIds,
      terminal: "answered",
      finalAssistantText: "",
      ...(parentEpisodeId ? { parentEpisodeId } : {}),
    };
    this.pendingCalls.clear();
  }

  onToolCall(name: string, args: Record<string, unknown>): void {
    this.pendingCalls.set(name, { args: this.compactArgs(args), at: Date.now() });
  }

  onToolResult(name: string, result: Record<string, unknown>): void {
    if (!this.current) return;
    const pending = this.pendingCalls.get(name);
    const started = pending ? pending.at : Date.now();
    const errorLabel = this.errorLabel(result);
    const event: ToolEvent = {
      name,
      args: pending ? pending.args : {},
      ok: errorLabel === undefined,
      durationMs: Date.now() - started,
      at: started,
    };
    if (errorLabel !== undefined) event.errorLabel = errorLabel.slice(0, 200);
    this.current.toolEvents.push(event);
    this.pendingCalls.delete(name);
  }

  onError(err: Error, toolName?: string): void {
    if (!this.current) return;
    const name = toolName ?? this.pendingCalls.keys().next().value;
    if (!name) return;
    const pending = this.pendingCalls.get(name);
    this.current.toolEvents.push({
      name,
      args: pending ? pending.args : {},
      ok: false,
      errorLabel: `${err.constructor.name}: ${err.message}`.slice(0, 200),
      durationMs: pending ? Date.now() - pending.at : 0,
      at: pending ? pending.at : Date.now(),
    });
    this.pendingCalls.delete(name);
  }

  end(terminal: Episode["terminal"], finalAssistantText: string): Episode | null {
    if (!this.current) return null;
    const episode = this.current;
    episode.endedAt = Date.now();
    episode.terminal = terminal;
    episode.finalAssistantText = finalAssistantText.slice(0, 4000);
    this.current = null;
    this.pendingCalls.clear();
    return episode;
  }

  private errorLabel(result: Record<string, unknown>): string | undefined {
    if (typeof result.error === "string") return result.error;
    if (typeof result.exitCode === "number" && result.exitCode !== 0) return `exit ${result.exitCode}`;
    return undefined;
  }

  /** Keep only short scalar args; large strings (file bodies, patches) are elided. */
  private compactArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string") out[key] = value.length > 300 ? `${value.slice(0, 300)}…[${value.length}]` : value;
      else if (typeof value === "number" || typeof value === "boolean" || value == null) out[key] = value;
      else out[key] = "[object]";
    }
    return out;
  }
}
