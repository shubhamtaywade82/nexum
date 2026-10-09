/**
 * MCP server environment resolution.
 *
 * `mcpServers[].env` values are literal strings, except `credential:NAME`,
 * which resolves through the CredentialService (env → trusted-workspace
 * credentials file → registered providers). Secrets then never have to be
 * written into config.json, and the server's trust fingerprint (command,
 * args, cwd) is unaffected by token rotation.
 */

export const CREDENTIAL_REF_PREFIX = "credential:";

export interface CredentialSource {
  get(name: string): Promise<string | undefined>;
}

export class McpEnvResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpEnvResolutionError";
  }
}

export async function resolveMcpEnv(
  env: Record<string, string> | undefined,
  credentials: CredentialSource | undefined,
): Promise<Record<string, string> | undefined> {
  if (!env || Object.keys(env).length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (typeof raw !== "string") throw new McpEnvResolutionError(`env ${key} must be a string`);
    if (!raw.startsWith(CREDENTIAL_REF_PREFIX)) {
      out[key] = raw;
      continue;
    }
    const name = raw.slice(CREDENTIAL_REF_PREFIX.length).trim();
    if (!name) throw new McpEnvResolutionError(`env ${key}: empty credential reference`);
    const value = credentials ? await credentials.get(name) : undefined;
    if (value === undefined || value === "") {
      throw new McpEnvResolutionError(`env ${key}: credential "${name}" is not set`);
    }
    out[key] = value;
  }
  return out;
}
