/**
 * Workspace trust — whether settings a repository ships may configure Nexum.
 *
 * A workspace carries files Nexum treats as configuration: `.nexum/config.json`
 * (and legacy `.devagent/config.json`), the MCP approval and publisher trust
 * stores next to it, and the `.env` files Nexum loads into its own process.
 * Anyone who can commit to the repository can author them, so a freshly
 * cloned repo could otherwise turn the sandbox off, register MCP server
 * commands, point the model at its own endpoint, or set PATH/NODE_OPTIONS so
 * the next `git` or Node child Nexum spawns is theirs.
 *
 * Trust is recorded OUTSIDE every workspace (`~/.nexum/trusted-workspaces.json`)
 * and bound to a digest of those files' exact contents, like `direnv allow`:
 * any change — a `git pull`, a teammate's commit — makes the workspace
 * untrusted again until the user reviews it. Until then only the keys in
 * `WORKSPACE_SAFE_KEYS` apply from the workspace config, the workspace `.env`
 * files are not loaded, and the workspace MCP approvals are ignored.
 *
 * Nexum's own writes to these files (saving config from the UI, `nexum mcp
 * trust approve`, `nexum marketplace keys add`) go through `preservingTrust`,
 * which re-stamps the digest only if the workspace was trusted (or had no
 * such files at all) right before the write.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { globalStateDir, legacyWorkspaceStateDir, workspaceStateDir } from "../platform/paths.js";
import { envIs } from "../platform/environment.js";

/**
 * Workspace config keys that apply even when the workspace is untrusted:
 * they tune behaviour but cannot run code, loosen isolation, or send the
 * workspace anywhere. Every other key (including unknown future ones) needs
 * trust — fail closed.
 */
export const WORKSPACE_SAFE_KEYS: ReadonlySet<string> = new Set([
  "model",
  "theme",
  "quickModel",
  "toolSelectionMode",
  "maxActiveTools",
  "timeoutMs",
  "shellTimeoutSec",
  "writeScope", // can only narrow what the agent may write
  "enableLocalWorker",
  "enableVerifier",
  "enableSelfConsistency",
  "selfConsistencyN",
  "selfConsistencyThreshold",
  "availabilityCheckTtlMs",
  "enableAvailabilityCheck",
  "enableHeuristicGate",
  "pricing",
]);

export type WorkspaceTrustStatus =
  /** digest matches the recorded one */
  | "trusted"
  /** no trust-bearing files: nothing to trust */
  | "empty"
  /** never trusted */
  | "untrusted"
  /** trusted before, but the files changed since */
  | "changed";

export interface WorkspaceTrustState {
  /** Real path of the workspace root (the store key). */
  root: string;
  status: WorkspaceTrustStatus;
  /** True for "trusted" and "empty": workspace settings apply in full. */
  trusted: boolean;
  digest: string;
  /** Trust-bearing files present, relative to the root. */
  present: string[];
}

interface TrustRecord {
  digest: string;
  trustedAt: string;
  files: string[];
}

/** root (real path) → trust record, persisted as JSON outside every workspace. */
export class WorkspaceTrustStore {
  private cache: Record<string, TrustRecord> | undefined;

  private constructor(private readonly file: string | undefined) {}

  /** `~/.nexum/trusted-workspaces.json`; in-memory (nothing trusted) under NEXUM_TEST_NO_GLOBAL. */
  static global(): WorkspaceTrustStore {
    if (envIs("TEST_NO_GLOBAL", "true")) return new WorkspaceTrustStore(undefined);
    return new WorkspaceTrustStore(join(globalStateDir(), "trusted-workspaces.json"));
  }

  static at(file: string): WorkspaceTrustStore {
    return new WorkspaceTrustStore(file);
  }

  static inMemory(): WorkspaceTrustStore {
    return new WorkspaceTrustStore(undefined);
  }

  get(root: string): TrustRecord | undefined {
    return this.load()[root];
  }

  set(root: string, record: TrustRecord): void {
    this.load()[root] = record;
    this.persist();
  }

  delete(root: string): boolean {
    const all = this.load();
    if (!(root in all)) return false;
    delete all[root];
    this.persist();
    return true;
  }

  private load(): Record<string, TrustRecord> {
    if (this.cache) return this.cache;
    this.cache = {};
    if (this.file && existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, "utf8")) as { workspaces?: Record<string, TrustRecord> };
        for (const [root, rec] of Object.entries(data.workspaces ?? {})) {
          if (rec && typeof rec.digest === "string") this.cache[root] = rec;
        }
      } catch {
        // corrupt store: nothing is trusted (fail closed); the next trust rewrites it
      }
    }
    return this.cache;
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, workspaces: this.cache }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/** Every file whose contents configure Nexum for this workspace. */
export function trustBearingFiles(root: string, cwd: string = process.cwd()): string[] {
  const files = [
    join(workspaceStateDir(root), "config.json"),
    join(legacyWorkspaceStateDir(root), "config.json"),
    join(workspaceStateDir(root), "mcp-trust.json"),
    join(workspaceStateDir(root), "publisher-trust.json"),
    join(root, ".env"),
  ];
  // loadConfig also reads <cwd>/.env; cwd sits inside the workspace (the root
  // is found by walking up from it)
  const cwdEnv = join(resolve(cwd), ".env");
  if (!files.includes(cwdEnv)) files.push(cwdEnv);
  return files;
}

function fileFingerprint(path: string): string | undefined {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  const h = createHash("sha256");
  if (st.isSymbolicLink()) {
    // bind the link target too: re-pointing it is a change
    try {
      h.update(`link:${realpathSync(path)}\0`);
    } catch {
      h.update("link:dangling\0");
    }
  }
  try {
    h.update(readFileSync(path));
  } catch {
    h.update(`unreadable:${st.mode}`);
  }
  return h.digest("hex");
}

/** Digest over the presence and exact contents of every trust-bearing file. */
export function workspaceDigest(root: string, cwd?: string): { digest: string; present: string[] } {
  const base = realRoot(root);
  const entries = trustBearingFiles(root, cwd)
    .map((file) => ({ rel: relative(root, file).split("\\").join("/"), fp: fileFingerprint(file) }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash("sha256").update(`${base}\0`);
  for (const e of entries) h.update(`${e.rel}\0${e.fp ?? "-"}\n`);
  return { digest: h.digest("hex"), present: entries.filter((e) => e.fp !== undefined).map((e) => e.rel) };
}

export function workspaceTrustState(root: string, store: WorkspaceTrustStore, cwd?: string): WorkspaceTrustState {
  const key = realRoot(root);
  const { digest, present } = workspaceDigest(root, cwd);
  const record = store.get(key);
  let status: WorkspaceTrustStatus;
  if (present.length === 0) status = "empty";
  else if (record?.digest === digest) status = "trusted";
  else status = record ? "changed" : "untrusted";
  return { root: key, status, trusted: status === "trusted" || status === "empty", digest, present };
}

/** Record the workspace's current trust-bearing files as trusted. */
export function trustWorkspace(root: string, store: WorkspaceTrustStore, cwd?: string): WorkspaceTrustState {
  const { digest, present } = workspaceDigest(root, cwd);
  store.set(realRoot(root), { digest, trustedAt: new Date().toISOString(), files: present });
  return workspaceTrustState(root, store, cwd);
}

export function revokeWorkspaceTrust(root: string, store: WorkspaceTrustStore): boolean {
  return store.delete(realRoot(root));
}

/**
 * Run a write Nexum makes to a trust-bearing file on the user's behalf. If
 * the workspace was trusted (or had no such files) immediately before, the
 * result is re-stamped as trusted; otherwise it stays untrusted, so this can
 * never launder content somebody else wrote.
 */
export function preservingTrust<T>(root: string, store: WorkspaceTrustStore, fn: () => T, cwd?: string): T {
  const before = workspaceTrustState(root, store, cwd);
  const result = fn();
  if (before.trusted) trustWorkspace(root, store, cwd);
  return result;
}

/** Split a workspace config into what applies untrusted and what is withheld. */
export function partitionWorkspaceConfig<T extends object>(config: T): { safe: Partial<T>; withheld: string[] } {
  const safe: Partial<T> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (WORKSPACE_SAFE_KEYS.has(key)) (safe as Record<string, unknown>)[key] = value;
    else withheld.push(key);
  }
  return { safe, withheld };
}

// ── Review text (prompt and `nexum trust`) ──────────────────────────────────

const DANGEROUS_ENV =
  /^(PATH|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|GIT_.*|NEXUM_.*|DEVAGENT_.*|OLLAMA_.*|HOME|SHELL)$/;

function readJsonAny(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  const data = readJsonAny(path);
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
}

function envNames(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(l)?.[1])
      .filter((n): n is string => Boolean(n));
  } catch {
    return [];
  }
}

function show(key: string, value: unknown): string {
  if (/apiKey/i.test(key)) return "(set)";
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Human-readable summary of what trusting this workspace would apply (never secret values). */
export function describeWorkspaceTrust(root: string, state: WorkspaceTrustState, cwd?: string): string[] {
  const lines: string[] = [];
  const statusText: Record<WorkspaceTrustStatus, string> = {
    trusted: "trusted",
    empty: "nothing to trust (no workspace config or .env)",
    untrusted: "NOT trusted",
    changed: "NOT trusted — changed since you last trusted it",
  };
  lines.push(`Workspace: ${state.root}`);
  lines.push(`Status:    ${statusText[state.status]}`);
  for (const file of trustBearingFiles(root, cwd)) {
    if (!existsSync(file)) continue;
    const rel = relative(root, file) || file;
    if (file.endsWith(".env")) {
      const names = envNames(file);
      const risky = names.filter((n) => DANGEROUS_ENV.test(n));
      lines.push(`  ${rel}: ${names.length} variable(s) loaded into Nexum's own process`);
      if (risky.length) lines.push(`    ! affects how Nexum runs: ${risky.join(", ")}`);
      continue;
    }
    if (!rel.endsWith("config.json")) {
      const raw = readJsonAny(file);
      const count = Array.isArray(raw) ? raw.length : raw && typeof raw === "object" ? Object.keys(raw).length : 0;
      lines.push(`  ${rel}: ${count} entr${count === 1 ? "y" : "ies"}`);
      continue;
    }
    const data = readJson(file);
    if (!data) {
      lines.push(`  ${rel}: (unreadable or not a JSON object)`);
      continue;
    }
    const { withheld } = partitionWorkspaceConfig(data);
    if (withheld.length === 0) {
      lines.push(`  ${rel}: only settings that apply without trust`);
      continue;
    }
    lines.push(`  ${rel}: settings that need trust:`);
    for (const key of withheld) {
      if (key === "mcpServers" && Array.isArray(data.mcpServers)) {
        for (const s of data.mcpServers as Array<{ name?: unknown; command?: unknown; args?: unknown }>) {
          const args = Array.isArray(s?.args) ? ` ${s.args.join(" ")}` : "";
          lines.push(`    mcpServers: ${String(s?.name)} → runs \`${String(s?.command)}${args}\` on this machine`);
        }
      } else {
        lines.push(`    ${key}: ${show(key, data[key])}`);
      }
    }
  }
  return lines;
}
