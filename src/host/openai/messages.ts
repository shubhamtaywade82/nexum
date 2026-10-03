import { z } from "zod";
import type { CreateRunRequest } from "../../protocol/types.js";

const ContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.string() }).passthrough(),
]);

const MessageSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool", "function"]),
    content: z.union([z.string(), z.array(ContentPartSchema), z.null()]).optional(),
  })
  .passthrough();

/**
 * The parts of an OpenAI chat request Nexum acts on. Everything else (temperature, max_tokens, tools, ...)
 * is accepted and ignored: Nexum chooses its own model and runs its own tools.
 */
export const ChatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(MessageSchema).min(1),
    stream: z.boolean().optional(),
  })
  .passthrough();
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface ClientTurn {
  role: "user" | "assistant";
  content: string;
}

/** A chat request reduced to what a Nexum run needs. */
export interface Conversation {
  /** The final user message. */
  goal: string;
  /** System/developer messages, which carry the client's own instructions and any retrieved context. */
  context: string;
  /** Earlier user/assistant turns, oldest first. */
  history: ClientTurn[];
  /** The client's own id for this conversation, when it sent one. */
  externalKey?: string;
}

export type ConversationResult = { ok: true; conversation: Conversation } | { ok: false; message: string };

type Message = ChatCompletionRequest["messages"][number];

type ContentPart = z.infer<typeof ContentPartSchema>;

function isTextPart(part: ContentPart): part is { type: "text"; text: string } {
  return part.type === "text" && typeof (part as { text?: unknown }).text === "string";
}

/** Reads the text of a message; images and other non-text parts are not supported. */
function textOf(message: Message): { ok: true; text: string } | { ok: false; message: string } {
  const { content } = message;
  if (typeof content === "string") return { ok: true, text: content };
  if (!content) return { ok: true, text: "" };
  const texts: string[] = [];
  for (const part of content) {
    if (!isTextPart(part)) return { ok: false, message: `only text content is supported, got a "${part.type}" part` };
    texts.push(part.text);
  }
  return { ok: true, text: texts.join("\n") };
}

/** Splits an OpenAI message list into the goal, the client's context and the earlier turns. */
export function parseConversation(messages: Message[]): ConversationResult {
  const context: string[] = [];
  const turns: ClientTurn[] = [];

  for (const message of messages) {
    const text = textOf(message);
    if (!text.ok) return text;
    if (message.role === "system" || message.role === "developer") {
      if (text.text) context.push(text.text);
    } else if ((message.role === "user" || message.role === "assistant") && text.text) {
      turns.push({ role: message.role, content: text.text });
    }
    // tool/function results belong to the client's own tool loop, which Nexum does not take part in.
  }

  const last = turns.pop();
  if (last?.role !== "user") return { ok: false, message: "the last message must be a non-empty user message" };
  return { ok: true, conversation: { goal: last.content, context: context.join("\n\n"), history: turns } };
}

/** The goal Nexum runs: the user's request, led by the client's context when it sent any. */
export function composeGoal({ goal, context }: Conversation): string {
  return context ? `Context from the client:\n${context}\n\nUser request:\n${goal}` : goal;
}

/** The run Nexum starts for a chat request: non-interactive (nobody can answer a prompt) and Markdown. */
export function toRunRequest(conversation: Conversation): CreateRunRequest {
  return { goal: composeGoal(conversation), presentation: { mode: "markdown" }, interactive: false };
}
