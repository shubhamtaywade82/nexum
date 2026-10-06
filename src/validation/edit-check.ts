/**
 * Syntax regression check for file mutations (write/patch/append/edit).
 *
 * validateSyntax is deliberately lightweight (bracket balance for JS/TS/Ruby,
 * triple-quote balance for Python, a real parse for JSON). Only JSON gets a
 * hard reject — JSON.parse has no false positives. For the heuristic
 * languages the check is relative: a warning is raised only when the file
 * was balanced BEFORE the edit and is not AFTER, so a checker blind spot
 * (regex literals, heredocs) that already affected the old content never
 * fires, and the model gets a precise signal it introduced the break.
 */

import { validateSyntax } from "./syntax.js";

export interface EditSyntaxVerdict {
  /** Set when the edit must not be written. */
  reject?: string;
  /** Set when the edit is written but likely broke the file's structure. */
  warning?: string;
}

export class EditSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditSyntaxError";
  }
}

export function checkEditSyntax(path: string, before: string | null, after: string): EditSyntaxVerdict {
  const next = validateSyntax(path, after);
  if (next.ok) return {};
  // A new or empty file has no structure to preserve: judge `after` alone.
  const prev = before === null || before === "" ? { ok: true } : validateSyntax(path, before);
  // Already broken before this edit: not this edit's regression.
  if (!prev.ok) return {};

  const reason = next.error ?? "syntax check failed";
  if (path.toLowerCase().endsWith(".json") || /null bytes|illegal unicode/.test(reason)) {
    return { reject: `${path}: ${reason}` };
  }
  return { warning: `${path}: this edit introduced a structural problem (${reason}); check and fix it` };
}

/** Throw on a reject verdict; return the warning (if any) to surface in the tool result. */
export function enforceEditSyntax(path: string, before: string | null, after: string): string | undefined {
  const verdict = checkEditSyntax(path, before, after);
  if (verdict.reject) throw new EditSyntaxError(`refused to write invalid content — ${verdict.reject}`);
  return verdict.warning;
}
