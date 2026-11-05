/**
 * `nexum trust` and the startup trust prompt (see ./workspace-trust.ts).
 *
 *   nexum trust            review the workspace's settings and trust them
 *   nexum trust status     show what is trusted / withheld (exit 1 if untrusted)
 *   nexum trust revoke     forget the trust decision for this workspace
 *
 * On interactive startup an untrusted workspace that ships settings gets a
 * one-time y/N prompt; non-interactive runs (rpc, CI, piped) never prompt:
 * they continue without the workspace's settings and say so on stderr.
 */

import { createInterface } from "node:readline/promises";
import { findWorkspaceRoot } from "../platform/paths.js";
import {
  describeWorkspaceTrust,
  revokeWorkspaceTrust,
  trustWorkspace,
  workspaceTrustState,
  WorkspaceTrustStore,
  type WorkspaceTrustState,
} from "./workspace-trust.js";

export interface TrustIo {
  out?: (line: string) => void;
  err?: (line: string) => void;
  cwd?: string;
  store?: WorkspaceTrustStore;
}

const USAGE = `Usage:
  nexum trust            review this workspace's settings and trust them
  nexum trust status     show the trust state (exit 1 when not trusted)
  nexum trust revoke     forget the trust decision for this workspace`;

export async function runTrustCli(argv: string[], io: TrustIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  const cwd = io.cwd ?? process.cwd();
  const store = io.store ?? WorkspaceTrustStore.global();
  const root = findWorkspaceRoot(cwd);
  const sub = argv[0] ?? "allow";

  if (sub === "status") {
    const state = workspaceTrustState(root, store, cwd);
    for (const line of describeWorkspaceTrust(root, state, cwd)) out(line);
    return state.trusted ? 0 : 1;
  }
  if (sub === "allow") {
    const before = workspaceTrustState(root, store, cwd);
    for (const line of describeWorkspaceTrust(root, before, cwd)) out(line);
    if (before.status === "empty") {
      out("Nothing to trust: this workspace ships no Nexum settings or .env.");
      return 0;
    }
    trustWorkspace(root, store, cwd);
    out("Trusted. Any change to these files makes the workspace untrusted again until you re-run `nexum trust`.");
    return 0;
  }
  if (sub === "revoke") {
    out(revokeWorkspaceTrust(root, store) ? `Revoked trust for ${root}.` : `${root} was not trusted.`);
    return 0;
  }
  err(USAGE);
  return 2;
}

export interface PromptOptions {
  /** Allow an interactive y/N prompt (only when stdin and stdout are TTYs). */
  interactive: boolean;
  cwd?: string;
  store?: WorkspaceTrustStore;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
  /** Where the non-interactive notice goes (default stderr). */
  notice?: (line: string) => void;
}

/** Called once at startup, before the config is loaded. */
export async function ensureWorkspaceTrust(opts: PromptOptions): Promise<WorkspaceTrustState> {
  const cwd = opts.cwd ?? process.cwd();
  const store = opts.store ?? WorkspaceTrustStore.global();
  const root = findWorkspaceRoot(cwd);
  const state = workspaceTrustState(root, store, cwd);
  if (state.trusted) return state;

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const notice = opts.notice ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (!opts.interactive || !input.isTTY || !output.isTTY) {
    notice(
      `nexum: workspace ${state.status === "changed" ? "changed since it was trusted" : "is not trusted"} — ` +
        `running without its settings (${state.present.join(", ")}). ` +
        "Review with `nexum trust status`, allow with `nexum trust`.",
    );
    return state;
  }

  const write = (line: string) => output.write(`${line}\n`);
  write("");
  write(
    state.status === "changed"
      ? "This workspace's Nexum settings changed since you trusted them."
      : "This workspace ships its own Nexum settings.",
  );
  for (const line of describeWorkspaceTrust(root, state, cwd)) write(line);
  write("Untrusted, Nexum ignores these (safe settings such as model and theme still apply).");
  const rl = createInterface({ input, output });
  let answer: string;
  try {
    answer = (await rl.question("Trust this workspace and apply them? [y/N] ")).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (answer === "y" || answer === "yes") {
    const trusted = trustWorkspace(root, store, cwd);
    write("Trusted.");
    return trusted;
  }
  write("Continuing without them. Run `nexum trust` later to allow.");
  return state;
}
