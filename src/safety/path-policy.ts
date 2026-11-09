import { basename } from "node:path";

/**
 * The single definition of "sensitive" (credentials, keys, secret stores).
 * Used by WorkspaceGuard (every filesystem tool), patch safety, and search
 * exclusions — keep it the only list.
 */
const BLOCKED_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
]);

// Every pattern is case-insensitive: on macOS and Windows volumes (default
// case-insensitive) `.AWS/credentials` and `ID_RSA` are the same files as
// `.aws/credentials` and `id_rsa`, so a case-sensitive match is a bypass.
const BLOCKED_PATTERNS = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])secrets?[\\/]/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])\.aws[\\/]/i,
  /(^|[\\/])\.gnupg[\\/]/i,
  /\.(pem|key|p12|pfx)$/i,
];

export function isSensitivePath(path: string): boolean {
  // BLOCKED_BASENAMES holds lowercase names only; compare against the lowercased basename.
  if (BLOCKED_BASENAMES.has(basename(path).toLowerCase())) return true;
  return BLOCKED_PATTERNS.some((re) => re.test(path));
}

/** ripgrep globs that keep sensitive files out of content search results. */
export const SENSITIVE_SEARCH_EXCLUDES: readonly string[] = [
  "!**/.env",
  "!**/.env.*",
  "!**/credentials.json",
  "!**/id_rsa",
  "!**/id_ed25519",
  "!**/id_ecdsa",
  "!**/secret/**",
  "!**/secrets/**",
  "!**/.ssh/**",
  "!**/.aws/**",
  "!**/.gnupg/**",
  "!**/*.pem",
  "!**/*.key",
  "!**/*.p12",
  "!**/*.pfx",
];
