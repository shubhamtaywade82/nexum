/**
 * Environment-variable resolution for product settings. Every product variable
 * is read as `NEXUM_<KEY>`.
 */

import { BRAND } from "./brand.js";

/** Read a product environment variable by its key suffix (without prefix). */
export function readEnv(key: string): string | undefined {
  return process.env[`${BRAND.envPrefix}${key}`];
}

/** True when the variable is set to exactly `value`. */
export function envIs(key: string, value: string): boolean {
  return readEnv(key) === value;
}

/**
 * Boolean flag parsed in both directions ("true"/"1" on, "false"/"0" off,
 * anything else → fallback).
 */
export function readEnvFlag(key: string, fallback: boolean): boolean {
  const raw = readEnv(key);
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}
