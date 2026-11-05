import { Tool } from "./tool.js";

export class EscalateTaskTool extends Tool {
  get name(): string {
    return "escalate_task";
  }

  get description(): string {
    return (
      "MANDATORY call, not optional, whenever you are stuck. Call this instead of guessing, " +
      "instead of inventing a tool or command that does not exist, instead of apologizing, and " +
      "instead of giving up: complex multi-file changes, architecture or design decisions, deep " +
      "reasoning, ambiguous requirements, a tool call that failed and you don't know how to fix it, " +
      'or any point where your next message would start with something like "I\'m sorry", "I ' +
      'cannot", "is not supported", or otherwise explain why you can\'t do the task instead of ' +
      "doing it. If you notice yourself about to write an apology or an explanation of your own " +
      "limitations, call this tool instead of writing that message. A stronger model will take over " +
      "with your full conversation history, including everything you've already done — you lose " +
      "nothing by calling it. Do not call this for simple lookups, small edits, or tasks you're " +
      "actually confident about and can complete."
    );
  }

  get tags(): string[] {
    return ["meta", "escalation"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { reason: { type: "string", description: "Why this task needs a stronger model" } },
      // Not required: this is the escape hatch for a model too confused to fill in
      // a schema correctly — call() already defaults a missing reason to
      // "unspecified". Requiring it here would let strict validation reject the
      // one call meant to catch exactly that failure mode before it ever runs.
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason : "unspecified";
    return { escalate: true, reason };
  }
}
