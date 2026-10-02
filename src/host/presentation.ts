import type { NexumOutputFormat, NexumRunOutput } from "../protocol/types.js";

export const SUPPORTED_OUTPUT_FORMATS: NexumOutputFormat[] = ["markdown", "openui"];

/** Wraps a client-supplied OpenUI spec in Nexum's presentation policy. */
export function openuiInstructions(spec: string): string {
  // The client owns which components exist; Nexum owns when UI is warranted,
  // so the model is told Markdown remains a valid final answer.
  return [
    "Output presentation:",
    "The client can render OpenUI Lang built only from the components specified below.",
    "This applies to your FINAL answer only, not to intermediate reasoning or tool calls.",
    "- If the result is structured data these components fit, reply with OpenUI Lang only, starting with `root = Stack(`.",
    "- Otherwise (explanations, code, prose), reply in plain Markdown.",
    "",
    spec,
  ].join("\n");
}

// Format classification, not OpenUI validation: malformed output may still be labelled openui, and the
// client renderer's Markdown fallback is the safety net. Parse with @openuidev/lang-core if that proves too loose.
const OPENUI_ROOT = /^root\s*=\s*[A-Z]\w*\s*\(/;

/** Labels the final answer with the format it actually is, not merely the one requested. */
export function presentOutput(content: string, requested: NexumOutputFormat): NexumRunOutput {
  const trimmed = content.trim();
  if (requested === "openui" && OPENUI_ROOT.test(trimmed)) return { format: "openui", content: trimmed };
  return { format: "markdown", content };
}
