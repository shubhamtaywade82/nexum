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

const BLOCKED_PATTERNS = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])secrets?[\\/]/i,
  /(^|[\\/])\.ssh[\\/]/,
  /(^|[\\/])\.aws[\\/]/,
  /(^|[\\/])\.gnupg[\\/]/,
  /\.(pem|key|p12|pfx)$/i,
];

export function isSensitivePath(path: string): boolean {
  const base = basename(path);
  if (BLOCKED_BASENAMES.has(base)) return true;
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
