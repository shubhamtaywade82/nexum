/**
 * What an escalated turn sends the primary model: a compact, bounded summary of the state, not the transcript (N-12).
 *
 * The primary model needs the request, why the turn escalated, and what the quick model already got from its tools.
 * It does not need every intermediate message, and sending them costs input tokens on every call of the turn. The
 * summary keeps the system messages, one summary message, and nothing else from the earlier conversation. It is a
 * pure function of the transcript and the reason, so the same inputs always produce the same summary.
 */

import type { ChatMessage } from "../models/adapters/provider.js";
import { LOCAL_DELEGATION_SYSTEM_ADDENDUM } from "../tools/delegate-tool.js";

/** Control notes the runtime pushed into the transcript (reviewer issues, tool-escape retries, context). */
const CONTROL_NOTE_PREFIXES = ["[system]", "[context]"] as const;
const MAX_CONTROL_NOTES = 8;

export const ESCALATION_SUMMARY_LIMITS = {
  goalChars: 2_000,
  resultChars: 800,
  maxResults: 6,
  assistantChars: 800,
} as const;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}… [${trimmed.length - max} more characters]`;
}

export interface EscalationSummaryInput {
  readonly goal: string;
  readonly reason: string;
  /** Tool results so far, oldest first. Only the most recent are kept. */
  readonly toolResults: readonly string[];
  readonly lastAssistantText?: string;
}

export function buildEscalationSummary(input: EscalationSummaryInput): string {
  const results = input.toolResults.slice(-ESCALATION_SUMMARY_LIMITS.maxResults);
  const lines = [
    `The quick model handed this turn to you. Reason: ${input.reason}.`,
    `Request: ${clip(input.goal, ESCALATION_SUMMARY_LIMITS.goalChars)}`,
  ];
  if (results.length > 0) {
    lines.push("Tool results so far (most recent last):");
    for (const result of results) lines.push(`- ${clip(result, ESCALATION_SUMMARY_LIMITS.resultChars)}`);
  }
  if (input.lastAssistantText && input.lastAssistantText.trim() !== "") {
    lines.push(`Last answer attempt: ${clip(input.lastAssistantText, ESCALATION_SUMMARY_LIMITS.assistantChars)}`);
  }
  lines.push("Continue the request from this state. Do not repeat a tool call whose result is listed above.");
  return lines.join("\n");
}

/**
 * The messages an escalated call sends: the system messages, the most recent control notes (instructions the runtime
 * added, such as the reviewer's issues and the delegation addendum), then the summary. Nothing else from the
 * transcript. Control notes are instructions the primary must follow, not history, so they are not summarised away.
 */
export function compactTranscriptForEscalation(
  messages: readonly ChatMessage[],
  input: { goal: string; reason: string },
): ChatMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const controlNotes = messages
    .filter(
      (m) =>
        m.role === "user" &&
        (m.content === LOCAL_DELEGATION_SYSTEM_ADDENDUM || CONTROL_NOTE_PREFIXES.some((p) => m.content.startsWith(p))),
    )
    .slice(-MAX_CONTROL_NOTES);
  const toolResults = messages.filter((m) => m.role === "tool").map((m) => m.content);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim() !== "");
  const summary = buildEscalationSummary({
    goal: input.goal,
    reason: input.reason,
    toolResults,
    lastAssistantText: lastAssistant?.content,
  });
  return [...system, ...controlNotes, { role: "user", content: summary }];
}
