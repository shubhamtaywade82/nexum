/**
 * Race-checked file access on top of WorkspaceGuard verdicts.
 *
 * A guard verdict is a check at one instant; a symlink swapped into the path
 * afterwards (e.g. by a concurrent sandboxed shell command writing into the
 * mounted workspace) would redirect the real syscall. Node has no
 * openat2(RESOLVE_BENEATH), so:
 *   - reads open the file, then re-resolve through the guard and require the
 *     SAME inode — a swap either escapes the guard or changes the inode;
 *   - writes create an empty temp file exclusively, prove it lives in the
 *     approved directory, write content through the descriptor only after
 *     that, and rename (a swapped parent makes the rename miss the temp file);
 *   - path-only ops (delete/move/mkdir) re-validate right before the syscall,
 *     which narrows but cannot fully close the window.
 */

import { constants } from "node:fs";
import { open, rename, stat, unlink, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FsOperation, WorkspaceGuard } from "../core/fs/workspace-guard.js";
import { guardPath, PathEscapeError } from "./path-utils.js";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function changed(path: string): PathEscapeError {
  return new PathEscapeError(`${path} changed while being accessed (symlink swap?); retry`);
}

/**
 * Read the file `resolve()` approves, verifying the bytes come from that same
 * file: open without following the final component, then re-resolve and
 * require the same device + inode.
 */
export async function readVerifiedWith(resolve: () => string, label: string): Promise<Buffer> {
  const resolved = resolve();
  const handle = await open(resolved, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const again = resolve();
    const current = await stat(again).catch(() => null);
    if (!current || current.dev !== opened.dev || current.ino !== opened.ino) throw changed(label);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Read a file the guard approved for `op` (tool error contract). */
export function readVerified(guard: WorkspaceGuard, op: FsOperation, path: string): Promise<Buffer> {
  return readVerifiedWith(() => guardPath(guard, op, path), path);
}

/**
 * Atomically replace the file `resolve()` approves, without following a
 * swapped parent: exclusive empty temp file → prove it sits at the approved
 * location → write through the descriptor → rename.
 */
export async function writeVerifiedWith(resolve: () => string, label: string, content: string | Buffer): Promise<void> {
  const resolved = resolve();
  const dir = dirname(resolved);
  const tmp = join(dir, `.${basename(resolved)}.tmp-${randomBytes(6).toString("hex")}`);
  const handle = await open(tmp, "wx"); // O_EXCL: never through a pre-planted symlink
  let written = false;
  try {
    const created = await handle.stat();
    const again = resolve();
    const dirNow = await realpath(dir).catch(() => null);
    const atTmp = await stat(tmp).catch(() => null);
    if (again !== resolved || dirNow !== dir || !atTmp || atTmp.ino !== created.ino || atTmp.dev !== created.dev) {
      throw changed(label);
    }
    await handle.writeFile(content);
    written = true;
  } finally {
    await handle.close();
    if (!written) await unlink(tmp).catch(() => {});
  }
  try {
    await rename(tmp, resolved);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/** Atomically replace a file the guard approved for writing (tool error contract). */
export function writeVerified(guard: WorkspaceGuard, path: string, content: string | Buffer): Promise<void> {
  return writeVerifiedWith(() => guardPath(guard, "write", path), path, content);
}

/**
 * Re-validate a path-only operation immediately before its syscall: same
 * verdict, and no symlink anywhere in its parent chain.
 */
export async function revalidate(
  guard: WorkspaceGuard,
  op: FsOperation,
  path: string,
  resolved: string,
): Promise<void> {
  const again = guardPath(guard, op, path);
  const dirNow = await realpath(dirname(resolved)).catch(() => null);
  if (again !== resolved || (dirNow !== null && dirNow !== dirname(resolved))) throw changed(path);
}
