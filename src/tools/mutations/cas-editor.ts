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

import { withFileLock } from "./file-lock.js";
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
  private async editLinesUnlocked(
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
  private async applyUnifiedDiffUnlocked(
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
  private async writeContentUnlocked(
    relativePath: string,
    expectedHash: string | null,
    nextContent: string,
  ): Promise<MutationResult> {
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

  /**
   * Each write runs under the file's lock, so Nexum's own edits to one file are serialized. The commit-time
   * hash check still applies: it is what catches a writer outside Nexum.
   */
  editLines(
    relativePath: string,
    expectedHash: string,
    edit: (lines: string[]) => string[],
    opts: { dryRun?: boolean } = {},
  ): Promise<MutationResult> {
    return this.locked(relativePath, () => this.editLinesUnlocked(relativePath, expectedHash, edit, opts));
  }

  applyUnifiedDiff(
    relativePath: string,
    expectedHash: string,
    patch: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<MutationResult> {
    return this.locked(relativePath, () => this.applyUnifiedDiffUnlocked(relativePath, expectedHash, patch, opts));
  }

  writeContent(relativePath: string, expectedHash: string | null, nextContent: string): Promise<MutationResult> {
    return this.locked(relativePath, () => this.writeContentUnlocked(relativePath, expectedHash, nextContent));
  }

  private locked<T>(relativePath: string, fn: () => Promise<T>): Promise<T> {
    const target = this.opts.guard.requireAllowed("write", relativePath);
    return withFileLock(target, fn);
  }

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

  /**
   * Throws ExpectedHashMismatchError unless the file still holds `expectedHash`.
   * A file that does not exist is the empty content, which is what an edit computed
   * against a missing file expects.
   */
  private async assertStillAt(relativePath: string, expectedHash: string): Promise<void> {
    const current = await readVerifiedWith(
      () => this.opts.guard.requireAllowed("write", relativePath),
      relativePath,
    ).then(
      (buf) => buf.toString("utf8"),
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    const currentHash = contentHash(current);
    if (currentHash !== expectedHash) {
      throw new ExpectedHashMismatchError(relativePath, expectedHash, currentHash);
    }
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
      await writeVerifiedWith(
        () => this.opts.guard.requireAllowed("write", relativePath),
        relativePath,
        after,
        // Compare-and-swap at the commit point: the target must still hold the version this edit was computed
        // from. Without this, a change made after the read and before the rename was silently overwritten.
        () => this.assertStillAt(relativePath, previousHash),
      );
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

/** How far from a hunk's declared position its old-side text may be found. */
const HUNK_SEARCH_RADIUS = 50;

/**
 * Apply a unified diff to content. Each hunk's old side (context plus removed
 * lines, in order) must match the content exactly, at the nearest location to
 * the declared line within HUNK_SEARCH_RADIUS. Anything else throws
 * PatchApplicationError and nothing is written: a hunk that does not match is
 * never spliced at its declared position ("trusting the producer" corrupted
 * files), and an ambiguous match is refused rather than guessed.
 */
export function applyUnifiedDiffToContent(content: string, patch: string, label = "file"): string {
  const lines = content.split("\n");
  const hunks = parseUnifiedDiff(patch);
  if (hunks.length === 0) {
    throw new PatchApplicationError(`no hunks found in patch for ${label}`);
  }

  let offset = 0; // cumulative line drift from earlier hunks, in the partially patched output
  const output = [...lines];

  hunks.forEach((hunk, idx) => {
    const number = idx + 1;
    // Insertion-only hunks (-N,0) name the line the insertion follows; others name the first old line.
    const declared = hunk.oldBody.length === 0 ? hunk.oldStart + offset : hunk.oldStart - 1 + offset;
    const anchor = findHunkAnchor(output, hunk.oldBody, declared);
    if (anchor === "none") {
      throw new PatchApplicationError(
        `hunk #${number} does not match content of ${label} (context not found near line ${hunk.oldStart})`,
        number,
      );
    }
    if (anchor === "ambiguous") {
      throw new PatchApplicationError(
        `hunk #${number} matches more than one location in ${label} near line ${hunk.oldStart}; add context lines`,
        number,
      );
    }
    output.splice(anchor, hunk.oldBody.length, ...hunk.newBody);
    offset += hunk.newBody.length - hunk.oldBody.length;
  });

  return output.join("\n");
}

interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Old side, in order: context and removed lines. This is what must match the file. */
  oldBody: string[];
  /** New side, in order: context and added lines. */
  newBody: string[];
}

/**
 * Parses hunks by their header counts, not by line prefixes alone: inside a
 * hunk, a line is body until the counts are satisfied, so a removed line such as
 * `-- note` is not mistaken for a `--- a/file` header. Body lines beyond the
 * counts, a truncated hunk, or a count mismatch are malformed and throw.
 */
function parseUnifiedDiff(patch: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const closeCurrent = (): void => {
    if (current && (oldLeft !== 0 || newLeft !== 0)) {
      throw new PatchApplicationError(
        `hunk #${hunks.length} is truncated: its header counts exceed its body`,
        hunks.length,
      );
    }
    current = null;
  };

  const patchLines = patch.split("\n");
  // A trailing newline leaves an empty last element that is not a line of the patch.
  if (patchLines[patchLines.length - 1] === "") patchLines.pop();
  for (const line of patchLines) {
    if (current && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("@@")) {
        throw new PatchApplicationError(
          `hunk #${hunks.length} is truncated: its header counts exceed its body`,
          hunks.length,
        );
      }
      const hunk: ParsedHunk = current;
      if (line.startsWith("+")) {
        hunk.newBody.push(line.slice(1));
        newLeft -= 1;
      } else if (line.startsWith("-")) {
        hunk.oldBody.push(line.slice(1));
        oldLeft -= 1;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file": not a content line
      } else {
        // a context line, possibly blank with its leading space stripped
        const text = line.startsWith(" ") ? line.slice(1) : line;
        hunk.oldBody.push(text);
        hunk.newBody.push(text);
        oldLeft -= 1;
        newLeft -= 1;
      }
      if (oldLeft < 0 || newLeft < 0) {
        throw new PatchApplicationError(`hunk #${hunks.length} has more lines than its header declares`, hunks.length);
      }
      continue;
    }

    closeCurrent();
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      const hunk: ParsedHunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] !== undefined ? Number(header[2]) : 1,
        newStart: Number(header[3]),
        newLines: header[4] !== undefined ? Number(header[4]) : 1,
        oldBody: [],
        newBody: [],
      };
      hunks.push(hunk);
      current = hunk;
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      continue;
    }
    // Between hunks: file headers ("diff", "index", "---", "+++") and prose are ignored.
    // A body-shaped line here is a body line the header did not count: refuse it, do not drop it.
    if (
      hunks.length > 0 &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("+++ ") &&
      !line.startsWith("--- ")
    ) {
      throw new PatchApplicationError(
        `line after hunk #${hunks.length} is not covered by its header: "${line}"`,
        hunks.length,
      );
    }
  }
  closeCurrent();
  return hunks;
}

/**
 * Where the old side occurs, nearest to `declared` first. Returns the index,
 * "none" when there is no match within the radius, or "ambiguous" when two
 * matches are equally near. An empty old side (pure insertion) is only valid
 * at the declared position.
 */
function findHunkAnchor(content: string[], oldBody: string[], declared: number): number | "none" | "ambiguous" {
  const matchesAt = (i: number): boolean =>
    i >= 0 && i + oldBody.length <= content.length && oldBody.every((line, j) => content[i + j] === line);

  if (oldBody.length === 0) {
    return declared >= 0 && declared <= content.length ? declared : "none";
  }
  for (let distance = 0; distance <= HUNK_SEARCH_RADIUS; distance++) {
    const candidates = distance === 0 ? [declared] : [declared - distance, declared + distance];
    const hits = candidates.filter(matchesAt);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return "ambiguous";
  }
  return "none";
}
