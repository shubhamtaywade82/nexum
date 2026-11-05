import { createParser, type LibraryJSONSchema } from "@openuidev/lang-core";
import type {
  NexumPresentationCapability,
  NexumRunOutput,
  OpenUiOffer,
  PresentationMode,
  PresentationRequest,
} from "../protocol/types.js";

/** The OpenUI Lang version this server validates against (the lang-core release line it ships). */
export const OPENUI_SCHEMA_VERSION = "0.3.0";

export const SUPPORTED_PRESENTATIONS: NexumPresentationCapability[] = [
  { format: "markdown" },
  { format: "openui", schemaVersion: OPENUI_SCHEMA_VERSION },
];

/** False when the client offers an OpenUI version this server cannot validate. */
export function isPresentationSupported(presentation: PresentationRequest): boolean {
  if (presentation.mode === "markdown" || !presentation.openui) return true;
  return presentation.openui.schemaVersion === OPENUI_SCHEMA_VERSION;
}

/**
 * Prompt text for this run's presentation, or "" when nothing should be injected
 * (Markdown was requested, or the client offered no OpenUI).
 */
export function presentationInstructions(presentation: PresentationRequest): string {
  const { mode, openui } = presentation;
  return openui && mode !== "markdown" ? openuiInstructions(openui.spec, mode) : "";
}

/** Wraps a client-supplied OpenUI spec in Nexum's presentation policy. */
export function openuiInstructions(spec: string, mode: Exclude<PresentationMode, "markdown">): string {
  // The client owns which components exist; Nexum owns when UI is warranted. In `auto` Markdown stays a
  // valid answer; in `openui` the client asked for UI, so the model is told to produce it.
  const policy =
    mode === "openui"
      ? ["- Reply with OpenUI Lang only, starting with `root = Stack(`. No prose, no code fence."]
      : [
          "- If the result is structured data these components fit, reply with OpenUI Lang only, starting with `root = Stack(`.",
          "- Otherwise (explanations, code, prose), reply in plain Markdown.",
        ];
  return [
    "Output presentation:",
    "The client can render OpenUI Lang built only from the components specified below.",
    "This applies to your FINAL answer only, not to intermediate reasoning or tool calls.",
    ...policy,
    "",
    spec,
  ].join("\n");
}

/**
 * Labels the final answer with the format it actually is. An answer is `openui` only if it is a program
 * that starts with `root =` (an enclosing code fence is allowed) and validates against the client's library.
 * Anything else, including a prose answer that merely mentions OpenUI, is returned unchanged as Markdown,
 * so no text is ever dropped by rendering only the UI part.
 */
export function presentOutput(content: string, presentation: PresentationRequest): NexumRunOutput {
  const { mode, openui } = presentation;
  if (mode === "markdown" || !openui) return { format: "markdown", content };

  const program = extractProgram(content);
  if (program !== null && openUiProblemsOf(program, openui).length === 0) {
    return { format: "openui", content: program, schemaVersion: openui.schemaVersion };
  }
  return { format: "markdown", content };
}

/** The program text if the answer starts with one (optionally inside a code fence), otherwise null. */
function extractProgram(content: string): string | null {
  let text = content.trim();
  const fence = /^```[\w-]*\s*\n/.exec(text);
  if (fence) {
    text = text
      .slice(fence[0].length)
      .replace(/\n?```\s*$/, "")
      .trim();
  }
  return /^root\s*=/.test(text) ? text : null;
}

/**
 * Why an answer that set out to be an OpenUI program is not a valid one; null when it is not a program at all
 * (plain Markdown is a fine answer) or when it is valid.
 */
export function openUiProblems(content: string, presentation: PresentationRequest): string[] | null {
  const { mode, openui } = presentation;
  if (mode === "markdown" || !openui) return null;
  const program = extractProgram(content);
  if (program === null) return null;
  const problems = openUiProblemsOf(program, openui);
  return problems.length > 0 ? problems : null;
}

function openUiProblemsOf(program: string, offer: OpenUiOffer): string[] {
  try {
    const { root, meta } = createParser(offer.schema as LibraryJSONSchema).parse(program);
    const problems = [...meta.errors, ...meta.unresolved, ...meta.orphaned].map(describeProblem);
    if (root === null) problems.push("the program has no root component");
    if (meta.incomplete) problems.push("the program is incomplete");
    return problems;
  } catch (err) {
    // A schema the parser cannot use means nothing can be validated: fall back rather than trust the model.
    return [`the program could not be parsed: ${err instanceof Error ? err.message : String(err)}`];
  }
}

function describeProblem(problem: unknown): string {
  if (typeof problem === "string") return problem;
  const message = (problem as { message?: unknown })?.message;
  return typeof message === "string" ? message : JSON.stringify(problem);
}
