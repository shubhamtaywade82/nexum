import type { NexumRunEvent } from "../../protocol/types.js";

const MAX_ARGS_CHARS = 100;
const MAX_ERROR_CHARS = 200;

export interface ProjectionState {
  /** Whether any tool line has been written, so the answer is set off from them by a blank line. */
  activity: boolean;
}

/**
 * Turns a run event into the text a chat client shows for it, or null when it has nothing to show.
 *
 * A plain OpenAI client has no concept of Nexum's tool events, and must never see `tool_calls` (it would try to
 * run them itself). So tool activity is rendered as Markdown blockquote lines in the message text, which every
 * client displays, followed by the answer.
 */
export function projectEvent(event: NexumRunEvent, state: ProjectionState): string | null {
  switch (event.type) {
    case "tool.started": {
      state.activity = true;
      const args = summarizeArgs(event.args);
      return `> 🔧 **${event.name}**${args ? ` \`${args}\`` : ""}\n`;
    }
    case "tool.completed": {
      const failure = failureOf(event.result);
      return failure ? `> ⚠️ **${event.name}** failed: ${failure}\n` : null;
    }
    case "run.completed":
      return lead(state) + event.output.content;
    case "run.failed":
      return `${lead(state)}⚠️ The run failed: ${event.error}`;
    case "run.cancelled":
      return `${lead(state)}⚠️ The run was cancelled.`;
    case "run.interrupted":
      return `${lead(state)}⚠️ The run was interrupted: ${event.reason}`;
    default:
      return null;
  }
}

const lead = (state: ProjectionState): string => (state.activity ? "\n" : "");

function summarizeArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args ?? {});
  if (text === "{}") return "";
  const safe = text.replace(/`/g, "'");
  return safe.length > MAX_ARGS_CHARS ? `${safe.slice(0, MAX_ARGS_CHARS - 1)}…` : safe;
}

function failureOf(result: Record<string, unknown>): string | null {
  if (typeof result?.error !== "string") return null;
  const detail = typeof result.message === "string" ? `${result.error}: ${result.message}` : result.error;
  return detail.length > MAX_ERROR_CHARS ? `${detail.slice(0, MAX_ERROR_CHARS - 1)}…` : detail;
}
