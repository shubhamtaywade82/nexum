import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalStateDir } from "../platform/paths.js";
import { isLoopbackBind } from "./request-guard.js";

/**
 * The bearer token for a loopback host, kept per user in the global state
 * directory. `nexum serve` creates it on first use and every local client reads
 * it, so the default loopback setup needs no configuration and still refuses
 * any caller that cannot read this user's files.
 */

export function serverTokenPath(home?: string): string {
  return join(globalStateDir(home), "server-token");
}

/** The stored token, or `undefined` when the file is missing or empty. */
export function readServerToken(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const token = readFileSync(path, "utf8").trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Returns the stored token, creating it on first use. The file is 0600 inside a
 * 0700 directory. It is written through a temp file and renamed into place, so an
 * interrupted write never leaves a partial token behind.
 */
export function loadOrCreateServerToken(path: string): string {
  const existing = readServerToken(path);
  if (existing !== undefined) return existing;

  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return token;
}

export type ServeAuth = { kind: "token"; token: string; source: "env" | "file" } | { kind: "none" };

/**
 * The auth `nexum serve` runs with. An explicit `NEXUM_SERVER_TOKEN` wins. A
 * loopback bind otherwise gets the per-user token file, unless the operator opts
 * out with `noToken`. A non-loopback bind never gets a generated token: the
 * operator must supply one, and the host refuses to start without it.
 */
export function resolveServeAuth(opts: {
  host: string;
  envToken: string | undefined;
  noToken: boolean;
  tokenPath: string;
}): ServeAuth {
  if (opts.envToken) return { kind: "token", token: opts.envToken, source: "env" };
  if (opts.noToken || !isLoopbackBind(opts.host)) return { kind: "none" };
  return { kind: "token", token: loadOrCreateServerToken(opts.tokenPath), source: "file" };
}
