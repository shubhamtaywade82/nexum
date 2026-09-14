/**
 * Keyword-based escalation hint classification.
 * Determines which capability tier the model should escalate to
 * when self-escalating via the escalate_task tool.
 *
 * This is keyword classification, not an LLM intent classifier — cheap and
 * deterministic. These patterns pick the ESCALATION TARGET for when the model
 * self-escalates via the escalate_task tool.
 */
export const VISION_PATTERN = /\b(screenshot|diagram|image|photo|picture)\b|\.(png|jpe?g|gif|webp)\b/;
export const REASONING_PATTERN =
  /\b(architecture|trade-?offs?|root cause|design decision|why does|why is|think through|deep dive)\b/;

/**
 * Read-only lookup/classification phrasing — used to require tool
 * evidence on quick-routed lookup turns (a prose-only answer is wrong,
 * not just low quality).
 */
export const LOOKUP_PATTERN = /\b(where is|where's|find the|show me|list the|which file|how many|what does .* do)\b/;

export type EscalationHint = "vision" | "reasoning" | null;

export function detectEscalationHint(text: string): EscalationHint {
  const desc = text.toLowerCase();
  if (VISION_PATTERN.test(desc)) return "vision";
  if (REASONING_PATTERN.test(desc)) return "reasoning";
  return null;
}

export function isLookupPrompt(text: string): boolean {
  return LOOKUP_PATTERN.test(text.toLowerCase());
}
