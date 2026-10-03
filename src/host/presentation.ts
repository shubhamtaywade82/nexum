import { createParser, type LibraryJSONSchema } from "@openuidev/lang-core";
import type { NexumPresentationCapability, NexumRunOutput, PresentationRequest } from "../protocol/types.js";

export const OPENUI_SCHEMA_VERSION = "0.3.0";

export const SUPPORTED_PRESENTATIONS: NexumPresentationCapability[] = [
  { format: "markdown" },
  { format: "openui", schemaVersion: OPENUI_SCHEMA_VERSION },
];

export function isPresentationSupported(presentation: PresentationRequest): boolean {
  if (presentation.mode === "markdown") return true;
  if (!presentation.openui) return true;
  return presentation.openui.schemaVersion === OPENUI_SCHEMA_VERSION;
}

export function openuiInstructions(spec: string): string {
  // Model prompt frames OpenUI as preferred for structured data but keeps Markdown valid
  // so the agent can fall back when components cannot represent the result.
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

const OPENUI_ROOT = /^root\s*=\s*[A-Z]\w*\s*\(/;

export function presentOutput(content: string, presentation: PresentationRequest): NexumRunOutput {
  const trimmed = content.trim();
  if (presentation.mode === "markdown" || !presentation.openui) {
    return { format: "markdown", content };
  }

  // Validates syntax and component signatures against the client-provided schema.
  // If parsing fails or reports errors, the safe fallback is markdown.
  if (OPENUI_ROOT.test(trimmed)) {
    try {
      const parser = createParser(presentation.openui.schema as LibraryJSONSchema);
      const parsed = parser.parse(trimmed);
      if (parsed.root !== null && !parsed.meta.incomplete && parsed.meta.errors.length === 0) {
        return {
          format: "openui",
          content: trimmed,
          schemaVersion: presentation.openui.schemaVersion,
        };
      }
    } catch {
      // Fallback to markdown when schema is unparseable
    }
  }

  return { format: "markdown", content };
}
