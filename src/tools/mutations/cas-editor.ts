/**
 * CAS file mutation (review item 10) — optimistic, compare-and-swap edits.
 *
 * `edit_file_lines` (and every line-based mutation) must validate the file
 * version the agent OBSERVED before applying:
 *
 *   read
 *     → content hash          (sha256, recorded by the read)
 *     → generate patch        (the edit the model proposes)
 *     → verify expected hash  (current file still matches what was read)
 *     → dry-run               (apply to the observed content in memory)
 *     → apply atomically      (temp file + rename)
 *     → return diff
 *
 * A mismatch (someone else — human, another agent, a watcher — mutated the
 * file since the read) fails with ExpectedHashMismatch carrying the
 * current hash, so the model re-reads and retries instead of clobbering.
 *
 * `apply_patch` is the PRIMARY editing primitive (review item 11):
 * unified diffs against the observed content hash; line editing and
 * find/replace remain convenience wrappers on top of this module.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createTwoFilesPatch } from "diff";
import { WorkspaceGuard } from "../../core/fs/workspace-guard.js";
import { readVerifiedWith, writeVerifiedWith } from "../verified-fs.js";
import { enforceEditSyntax } from "../../validation/edit-check.js";

export class ExpectedHashMismatchError extends Error {
  constructor(
    public readonly path: string,
    public readonly expectedHash: string,
    public readonly currentHash: string,
  ) {
    super(
      `${path} changed since it was read (expected ${expectedHash.slice(0, 12)}, found ${currentHash.slice(0, 12)}); re-read and retry`,
    );
    this.name = "ExpectedHashMismatchError";
  }
}

export class PatchApplicationError extends Error {
  constructor(
    message: string,
    public readonly hunk?: number,
  ) {
    super(message);
    this.name = "PatchApplicationError";
  }
}

/** sha256 of file content — the observed version stamp. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface MutationResult {
  path: string;
  /** false for a dry run (validated + diffed, nothing written). */
  applied: boolean;
  /** sha256 before the mutation. */
  previousHash: string;
  /** sha256 after the mutation. */
  newHash: string;
  /** Unified diff of the change. */
  diff: string;
  bytesWritten: number;
  /** The edit likely broke the file's structure (see validation/edit-check). */
  syntaxWarning?: string;
}

export interface CasEditorOptions {
  guard: WorkspaceGuard;
  /** Where atomic temp files land (defaults to <dir of target>/.nexum-tmp). */
  tmpSuffix?: string;
}

/**
 * The compare-and-swap editor behind edit_file_lines / apply_patch /
 * apply_unified_diff (review items 10 + 11).
 */
export class CasEditor {
  constructor(private readonly opts: CasEditorOptions) {}

  /** Read through the guard, returning content + its hash (the CAS token). */
  async read(relativePath: string): Promise<{ path: string; absolute: string; content: string; hash: string }> {
    const absolute = this.opts.guard.requireAllowed("read", relativePath);
    const content = (
      await readVerifiedWith(() => this.opts.guard.requireAllowed("read", relativePath), relativePath)
    ).toString("utf8");
    return { path: relativePath, absolute, content, hash: contentHash(content) };
  }

  /**
   * Line-based edit with CAS (review item 10). `edit` receives the observed
   * lines and returns the new lines; the current file must still hash to
   * `expectedHash` when the edit applies.
   */
  async editLines(
    relativePath: string,
    expectedHash: string,
    edit: (lines: string[]) => string[],
    opts: { dryRun?: boolean } = {},
  ): Promise<MutationResult> {
    const { absolute, content } = await this.readIfCurrent(relativePath, expectedHash);
    const observed = content.split("\n");
    const next = edit(observed);
    if (next.join("\n") === content) {
      return {
        path: relativePath,
        applied: true,
        previousHash: expectedHash,
        newHash: expectedHash,
        diff: "",
        bytesWritten: Buffer.byteLength(content, "utf8"),
      };
    }
    const nextContent = next.join("\n");
    return this.applyAtomic(relativePath, absolute, content, nextContent, expectedHash, opts.dryRun);
  }

  /**
   * Unified-diff patch with CAS (review item 11 — the PRIMARY primitive).
   * `patch` is a unified diff whose context must match the observed
   * content; `expectedHash` pins the version the diff was generated
   * against.
   */
  async applyUnifiedDiff(
    relativePath: string,
    expectedHash: string,
    patch: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<MutationResult> {
    const { absolute, content } = await this.readIfCurrent(relativePath, expectedHash);
    const nextContent = applyUnifiedDiffToContent(content, patch, relativePath);
    if (nextContent === content) {
      return {
        path: relativePath,
        applied: true,
        previousHash: expectedHash,
        newHash: expectedHash,
        diff: "",
        bytesWritten: Buffer.byteLength(content, "utf8"),
      };
    }
    return this.applyAtomic(relativePath, absolute, content, nextContent, expectedHash, opts.dryRun);
  }

  /**
   * Replace whole-file content with CAS (the write primitive used by
   * write_file when it wants version safety).
   */
  async writeContent(relativePath: string, expectedHash: string | null, nextContent: string): Promise<MutationResult> {
    const absolute = this.opts.guard.requireAllowed("write", relativePath);
    let current = "";
    if (expectedHash !== null) {
      const verdict = this.opts.guard.check("read", relativePath);
      if (verdict.allowed && verdict.resolvedPath) {
        current = (
          await readVerifiedWith(() => this.opts.guard.requireAllowed("read", relativePath), relativePath)
        ).toString("utf8");
        const currentHash = contentHash(current);
        if (currentHash !== expectedHash) {
          throw new ExpectedHashMismatchError(relativePath, expectedHash, currentHash);
        }
      } else if (expectedHash !== null) {
        // expected a version but file is gone → the workspace moved under us
        throw new ExpectedHashMismatchError(relativePath, expectedHash, "(missing)");
      }
    } else {
      current = await readVerifiedWith(() => this.opts.guard.requireAllowed("read", relativePath), relativePath).then(
        (b) => b.toString("utf8"),
        () => "",
      );
    }
    return this.applyAtomic(relativePath, absolute, current, nextContent, expectedHash ?? contentHash(current));
  }

  /** Generate a unified diff for a proposed content change (dry-run output). */
  diffFor(relativePath: string, before: string, after: string): string {
    return createTwoFilesPatch(`a/${relativePath}`, `b/${relativePath}`, before, after, "", "", {
      context: 3,
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async readIfCurrent(
    relativePath: string,
    expectedHash: string,
  ): Promise<{ absolute: string; content: string; hash: string }> {
    const absolute = this.opts.guard.requireAllowed("patch", relativePath);
    const content = (
      await readVerifiedWith(() => this.opts.guard.requireAllowed("patch", relativePath), relativePath)
    ).toString("utf8");
    const hash = contentHash(content);
    if (hash !== expectedHash) {
      throw new ExpectedHashMismatchError(relativePath, expectedHash, hash);
    }
    return { absolute, content, hash };
  }

  /** dry-run (in memory) → apply atomically (temp + rename) → diff. */
  private async applyAtomic(
    relativePath: string,
    absolute: string,
    before: string,
    after: string,
    previousHash: string,
    dryRun = false,
  ): Promise<MutationResult> {
    const syntaxWarning = enforceEditSyntax(relativePath, before, after);
    if (!dryRun) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeVerifiedWith(() => this.opts.guard.requireAllowed("write", relativePath), relativePath, after);
    }
    return {
      path: relativePath,
      applied: !dryRun,
      previousHash,
      newHash: contentHash(after),
      diff: this.diffFor(relativePath, before, after),
      bytesWritten: Buffer.byteLength(after, "utf8"),
      ...(syntaxWarning ? { syntaxWarning } : {}),
    };
  }
}

// ── Unified diff application (strict, hunk-anchored) ────────────────────────

/**
 * Apply a unified diff to content. Hunks are matched by their context
 * lines with a small search window (fuzz), mirroring `patch(1)`'s
 * behavior. Failing hunks throw PatchApplicationError.
 */
export function applyUnifiedDiffToContent(content: string, patch: string, label = "file"): string {
  const lines = content.split("\n");
  const hunks = parseUnifiedDiff(patch);
  if (hunks.length === 0) {
    throw new PatchApplicationError(`no hunks found in patch for ${label}`);
  }

  let offset = 0; // cumulative line drift from earlier hunks
  const output = [...lines];

  hunks.forEach((hunk, idx) => {
    const start = hunk.newStart - 1 + offset; // 0-based index into output
    const ctxWindow = Math.max(0, start - 50);
    const anchor = findHunkAnchor(output, hunk, ctxWindow, start + hunk.context.length + 50);
    if (anchor === -1) {
      throw new PatchApplicationError(
        `hunk #${idx + 1} does not match content of ${label} (context not found near line ${hunk.newStart})`,
        idx + 1,
      );
    }
    // remove old lines, insert new ones at the anchor
    output.splice(anchor, hunk.oldLines, ...hunk.newBody);
    offset += hunk.newLines - hunk.oldLines;
  });

  return output.join("\n");
}

interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  context: string[];
  newBody: string[];
}

function parseUnifiedDiff(patch: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const lines = patch.split("\n");
  let current: ParsedHunk | null = null;
  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] !== undefined ? Number(header[2]) : 1,
        newStart: Number(header[3]),
        newLines: header[4] !== undefined ? Number(header[4]) : 1,
        context: [],
        newBody: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) {
      continue;
    }
    if (line.startsWith("+")) current.newBody.push(line.slice(1));
    else if (line.startsWith("-")) {
      /* old-only line: contributes to oldLines, nothing to emit */
    } else if (line.startsWith(" ")) {
      current.context.push(line.slice(1));
      current.newBody.push(line.slice(1));
    } else if (line === "" || line.startsWith("\\")) {
      // trailing newline markers / blank separator: treat as context-less
    }
  }
  return hunks;
}

function findHunkAnchor(content: string[], hunk: ParsedHunk, from: number, to: number): number {
  // match the first context line (or first removed line when no context)
  const probeLen = Math.max(1, hunk.context.length);
  for (let i = Math.max(0, from); i < Math.min(content.length, to + probeLen); i++) {
    let matched = true;
    for (let j = 0; j < probeLen; j++) {
      if (content[i + j] !== hunk.context[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  // fallback: newStart as declared (trusting the producer)
  return Math.min(Math.max(0, hunk.newStart - 1), content.length);
}
