/**
 * Environment policy for every process the healer starts on a repository's behalf.
 *
 * The daemon keeps GitHub and SSH credentials for its own gh and git calls. Child
 * processes get an allowlisted environment instead, so a prompt-injected agent or a
 * repo test script cannot read GH_TOKEN from its environment.
 *
 *   agentEnv        the agent: model configuration (NEXUM_*, OLLAMA_*, provider keys)
 *   repoCommandEnv  verify and setup commands: no model configuration at all
 *
 * HARD_DENY applies last, so no allowlist entry can re-admit a GitHub or SSH
 * credential. This covers environment variables only. File-based credentials under
 * HOME (for example ~/.config/gh) are not covered.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

const COMMON_EXACT = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "TMPDIR", "TZ"]);
const COMMON_PREFIXES = ["LC_"];
const AGENT_PREFIXES = ["NEXUM_", "OLLAMA_"];

const HARD_DENY: readonly RegExp[] = [
  /^(GH|GITHUB|GITLAB|SSH|GPG)_/,
  /^GIT_(ASKPASS|SSH|CONFIG|DIR|WORK_TREE|CREDENTIAL)/,
  /GITHUB/,
  /_AUTH_SOCK$/,
];

export function hardDenied(name: string): boolean {
  return HARD_DENY.some((pattern) => pattern.test(name));
}

export function agentEnv(source: EnvSource = process.env, allow: readonly string[] = []): Record<string, string> {
  return build(source, COMMON_EXACT, [...COMMON_PREFIXES, ...AGENT_PREFIXES], allow);
}

export function repoCommandEnv(source: EnvSource = process.env): Record<string, string> {
  return build(source, COMMON_EXACT, COMMON_PREFIXES, []);
}

function build(
  source: EnvSource,
  exact: ReadonlySet<string>,
  prefixes: readonly string[],
  extra: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || hardDenied(name)) continue;
    if (exact.has(name) || extra.includes(name) || prefixes.some((prefix) => name.startsWith(prefix))) {
      env[name] = value;
    }
  }
  return env;
}

/** The daemon's own environment, for gh and git, which need their credentials. */
export function inheritedEnv(source: EnvSource = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined) env[name] = value;
  return env;
}
