/**
 * EvolutionVerificationProfile — the canonical, repository-defined verification
 * gates for the self-development actuator (v2.3.1).
 *
 * v2.2/v2.3 shipped `verifyCommands: [["node", "--version"]]` as the default
 * mutation gate. That is a smoke check: it proves the worktree can execute
 * node, not that the mutation produced a valid Nexum candidate. This module
 * makes the distinction explicit and reproducible between local evolution runs
 * and CI:
 *
 *   CLI (--verify-profile)
 *     ↓
 *   EvolutionVerificationProfile
 *     ↓
 *   GitWorktreeMutationExecutor.verifyCommands
 *     ↓
 *   sequential gates INSIDE the candidate worktree
 *
 * Tiers:
 *   smoke — the historical default; process-level liveness only.
 *   fast  — format + lint + typecheck: the mutation is a well-formed Nexum
 *           change. Default for local/interactive mutation runs.
 *   full  — fast + the repository's canonical test suite (the same command CI
 *           runs). Default when `--github` delivery is requested: a PR is only
 *           opened for a candidate that passes the CI-equivalent gate.
 */

export interface EvolutionVerificationProfile {
  /** Profile name accepted by `nexum evolve --mutate --verify-profile <name>`. */
  name: "smoke" | "fast" | "full";
  /** Human-readable summary of what the gate chain proves. */
  description: string;
  /**
   * Sequential command gates (argv-style, run with cwd = candidate worktree).
   * Every command must exit 0 for verification to pass.
   */
  commands: string[][];
}

/** Process-liveness only — proves the worktree can execute, nothing more. */
export const NEXUM_SMOKE_PROFILE: EvolutionVerificationProfile = {
  name: "smoke",
  description: "node liveness smoke check (historical v2.2/v2.3 default)",
  commands: [["node", "--version"]],
};

/** Well-formed Nexum change: formatting, lint, and typecheck all clean. */
export const NEXUM_FAST_PROFILE: EvolutionVerificationProfile = {
  name: "fast",
  description: "format + lint + typecheck inside the candidate worktree",
  commands: [
    ["npx", "prettier", "--check", "src", "tests"],
    ["npx", "eslint", "src", "tests"],
    ["npx", "tsc", "--noEmit"],
  ],
};

/** CI-equivalent gate: fast plus the repository's canonical test suite. */
export const NEXUM_FULL_PROFILE: EvolutionVerificationProfile = {
  name: "full",
  description: "fast gates + the canonical npm test suite (CI-equivalent)",
  commands: [...NEXUM_FAST_PROFILE.commands, ["npm", "test"]],
};

const PROFILES: Record<EvolutionVerificationProfile["name"], EvolutionVerificationProfile> = {
  smoke: NEXUM_SMOKE_PROFILE,
  fast: NEXUM_FAST_PROFILE,
  full: NEXUM_FULL_PROFILE,
};

/**
 * Resolves a verification profile by name. Absent/empty resolves to `fast`
 * (the meaningful default). Unknown names throw loudly so a typo can never
 * silently downgrade the mutation gate to a weaker tier.
 */
export function verificationProfileByName(name?: string): EvolutionVerificationProfile {
  if (!name || name === "fast") return NEXUM_FAST_PROFILE;
  const profile = PROFILES[name as EvolutionVerificationProfile["name"]];
  if (!profile) {
    throw new Error(`Unknown verification profile "${name}" (expected "smoke", "fast", or "full").`);
  }
  return profile;
}
