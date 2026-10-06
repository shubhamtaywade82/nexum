import type { IncomingMessage } from "node:http";
import type { ChatMessage } from "../../models/adapters/provider.js";
import { DISCOVERY_SESSION_ID } from "../agent-registry.js";
import type { Conversation } from "./messages.js";
import type { OpenAiContext } from "./chat-session.js";

/** Open WebUI prefixes its own title/tag/follow-up prompts with this marker. */
const TASK_PROMPT_MARKER = "### Task:";

/**
 * True for housekeeping requests a chat UI makes about a conversation (titles, tags, follow-ups) rather than on
 * the user's behalf. They must not reach the agent: it would run tools and pollute the session with them.
 */
export function isTaskRequest(req: IncomingMessage, conversation: Conversation): boolean {
  const header = req.headers["x-openwebui-task"];
  if (typeof header === "string" && header.trim() !== "") return true;
  return conversation.goal.trimStart().startsWith(TASK_PROMPT_MARKER);
}

/** One plain model reply to the request: no agent loop, tools or session. */
export async function completeTask(ctx: OpenAiContext, { context, history, goal }: Conversation): Promise<string> {
  const messages: ChatMessage[] = [
    ...(context ? [{ role: "system" as const, content: context }] : []),
    ...history,
    { role: "user" as const, content: goal },
  ];
  const { agent } = await ctx.registry.getOrCreate(DISCOVERY_SESSION_ID);
  return agent.completeOnce(messages);
}
