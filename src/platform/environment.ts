/**
 * Environment-variable resolution with one-major-version DevAgent → Nexum
 * compatibility (docs/REBRANDING.md §3).
 *
 * Precedence for every product variable:
 *
 *     NEXUM_<KEY>  >  DEVAGENT_<KEY>  >  (config file / built-in default)
 *
 * Reading a DEVAGENT_* variable emits a once-per-variable deprecation warning
 * on stderr. Warnings are suppressed by NEXUM_NO_DEPRECATION_WARNINGS=1 or
 * programmatically (tests) via suppressDeprecationWarnings().
 */

import { BRAND } from "./brand.js";

const warnedKeys = new Set<string>();
let warningsSuppressed = false;

/** Programmatically (de)authorize deprecation warnings — for tests and CLI. */
export function suppressDeprecationWarnings(suppress: boolean): void {
  warningsSuppressed = suppress;
}

/** Test helper: forget which legacy keys were already warned about. */
export function resetDeprecationWarnings(): void {
  warnedKeys.clear();
}

function warnLegacy(legacyName: string, canonicalName: string): void {
  if (warningsSuppressed || process.env.NEXUM_NO_DEPRECATION_WARNINGS === "1" || warnedKeys.has(legacyName)) return;
  warnedKeys.add(legacyName);
  // stderr, not stdout — never corrupts piped/JSON output.
  console.error(`${legacyName} is deprecated. Use ${canonicalName} instead.`);
}

/**
 * Read a product environment variable by its key suffix (without prefix).
 *
 *   readEnv("MODEL")        → NEXUM_MODEL ?? DEVAGENT_MODEL (warned)
 *
 * `??` semantics: a canonical variable that is set — even to the empty
 * string — wins over the legacy variable, mirroring the documented contract.
 */
export function readEnv(key: string): string | undefined {
  const canonical = process.env[`${BRAND.envPrefix}${key}`];
  if (canonical !== undefined) return canonical;
  const legacy = process.env[`${BRAND.legacyEnvPrefix}${key}`];
  if (legacy !== undefined) {
    warnLegacy(`${BRAND.legacyEnvPrefix}${key}`, `${BRAND.envPrefix}${key}`);
    return legacy;
  }
  return undefined;
}

/** True when either form of the variable is set to exactly `value`. */
export function envIs(key: string, value: string): boolean {
  return readEnv(key) === value;
}

/**
 * Every currently-set DEVAGENT_* product variable (full names), for
 * `nexum migrate` reporting. Does not warn — it reports, it doesn't read.
 */
export function activeLegacyEnvVariables(): string[] {
  return Object.keys(process.env)
    .filter((k) => k.startsWith(BRAND.legacyEnvPrefix))
    .sort();
}

/**
 * Boolean flag parsed in both directions ("true"/"1" on, "false"/"0" off,
 * anything else → fallback), preserving the historical CLI flag semantics
 * across the prefix migration.
 */
export function readEnvFlag(key: string, fallback: boolean): boolean {
  const raw = readEnv(key);
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}
