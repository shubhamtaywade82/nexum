/**
 * CredentialService — managed credentials with provider adapters.
 *
 * Nexum currently has environment-based credentials (.env, NEXUM_* env vars)
 * and model-provider configuration. For a general agent runtime, this should
 * be elevated to a first-class service so tools never need to know whether
 * a credential came from env, file, OS keychain, vault, OAuth, GitHub App,
 * or cloud secret manager.
 *
 * API:
 *   get(name)         → string | undefined  (raw credential value)
 *   resolve(spec)     → string              (with redaction metadata)
 *   redact(value)     → string              (mask for logging)
 *   rotate(name, fn)  → void                (hot-swap a credential)
 *   scope(tags)       → CredentialScope     (filter visible credentials)
 *
 * Provider adapters:
 *   EnvCredentialProvider      ← process.env / NEXUM_* / DEVAGENT_*
 *   FileCredentialProvider     ← .nexum/credentials.json (gitignored)
 *   KeychainCredentialProvider ← OS keychain (stub — future impl)
 *   VaultCredentialProvider    ← HashiCorp Vault / cloud secret manager (stub)
 *
 * Redaction: every credential value is wrapped so that accidental logging
 * shows `***REDACTED***` instead of the secret. The raw value is only
 * available via explicit `get()` / `resolve()` calls.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Contracts ───────────────────────────────────────────────────────────────

export interface CredentialSpec {
  /** Logical name (e.g. "OPENAI_API_KEY", "binance-api-key"). */
  name: string;
  /** Optional scope tags (e.g. ["trading", "binance"]). */
  tags?: string[];
  /** Optional description (for `nexum credentials list`). */
  description?: string;
}

export interface CredentialRecord extends CredentialSpec {
  /** The raw value (NEVER log this directly). */
  value: string;
  /** Which provider supplied this credential. */
  provider: string;
  /** When the credential was last resolved. */
  resolvedAt: string;
}

export interface CredentialScope {
  /** Only credentials matching ALL of these tags are visible. */
  tags: string[];
  /** Only credentials matching these names are visible (empty = all). */
  names: string[];
}

export interface CredentialProvider {
  readonly id: string;
  /** Resolve a credential by name. Returns undefined if not found. */
  resolve(name: string): string | undefined | Promise<string | undefined>;
  /** List all credential names this provider knows about. */
  list?(): string[] | Promise<string[]>;
}

// ── Redaction ───────────────────────────────────────────────────────────────

const REDACTED = "***REDACTED***";

export function redact(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

// ── CredentialService ───────────────────────────────────────────────────────

export interface CredentialServiceOptions {
  /** Root directory for file-based credentials (e.g. workspaceRoot). */
  rootDir?: string;
  /** Additional providers (env is always included). */
  providers?: CredentialProvider[];
  /** Default scope (applied when no scope is specified). */
  defaultScope?: CredentialScope;
}

export class CredentialService {
  private readonly providers: CredentialProvider[] = [];
  private readonly cache = new Map<string, CredentialRecord>();
  private readonly rootDir?: string;
  private readonly defaultScope?: CredentialScope;
  private readonly rotators = new Map<string, () => Promise<string>>();

  constructor(opts: CredentialServiceOptions = {}) {
    this.rootDir = opts.rootDir;
    this.defaultScope = opts.defaultScope;
    // Env provider is always first (lowest priority — file/vault override).
    this.providers.push(new EnvCredentialProvider());
    if (this.rootDir) {
      this.providers.push(new FileCredentialProvider(this.rootDir));
    }
    for (const p of opts.providers ?? []) {
      this.providers.push(p);
    }
  }

  registerProvider(provider: CredentialProvider): this {
    this.providers.push(provider);
    return this;
  }

  /** Get a credential value by name (raw). Returns undefined if not found. */
  async get(name: string): Promise<string | undefined> {
    const cached = this.cache.get(name);
    if (cached) return cached.value;

    for (const provider of this.providers) {
      try {
        const value = await provider.resolve(name);
        if (value !== undefined) {
          this.cache.set(name, {
            name,
            value,
            provider: provider.id,
            resolvedAt: new Date().toISOString(),
          });
          return value;
        }
      } catch {
        // provider failed — try next
      }
    }
    return undefined;
  }

  /** Require a credential (throws if not found). */
  async require(name: string): Promise<string> {
    const value = await this.get(name);
    if (value === undefined) {
      throw new Error(
        `required credential "${name}" not found. ` +
          `Checked providers: ${this.providers.map((p) => p.id).join(", ")}`,
      );
    }
    return value;
  }

  /** Resolve a credential spec, returning the record (with redaction helpers). */
  async resolve(spec: CredentialSpec): Promise<CredentialRecord | undefined> {
    const value = await this.get(spec.name);
    if (value === undefined) return undefined;
    return {
      ...spec,
      value,
      provider: this.cache.get(spec.name)?.provider ?? "env",
      resolvedAt: new Date().toISOString(),
    };
  }

  /** List all known credential names (across all providers). */
  async list(): Promise<string[]> {
    const names = new Set<string>();
    for (const provider of this.providers) {
      if (provider.list) {
        try {
          const list = await provider.list();
          for (const name of list) names.add(name);
        } catch {
          // provider failed — skip
        }
      }
    }
    return [...names].sort();
  }

  /** List credential records with redacted values (safe for display). */
  async listRedacted(): Promise<Array<{ name: string; provider: string; preview: string }>> {
    const names = await this.list();
    const records: Array<{ name: string; provider: string; preview: string }> = [];
    for (const name of names) {
      const value = await this.get(name);
      const provider = this.cache.get(name)?.provider ?? "unknown";
      records.push({
        name,
        provider,
        preview: value ? redact(value) : "(not found)",
      });
    }
    return records;
  }

  /** Register a rotation function for a credential. */
  rotate(name: string, rotator: () => Promise<string>): this {
    this.rotators.set(name, rotator);
    return this;
  }

  /** Execute rotation for a credential (hot-swap the value). */
  async refresh(name: string): Promise<void> {
    const rotator = this.rotators.get(name);
    if (!rotator) {
      throw new Error(`no rotator registered for credential "${name}"`);
    }
    const newValue = await rotator();
    const existing = this.cache.get(name);
    this.cache.set(name, {
      name,
      value: newValue,
      provider: existing?.provider ?? "rotated",
      resolvedAt: new Date().toISOString(),
    });
  }

  /** Create a scoped view (only credentials matching the scope are visible). */
  scope(scope: CredentialScope): ScopedCredentialService {
    return new ScopedCredentialService(this, scope);
  }

  /** Invalidate the cache (force re-resolution on next get). */
  invalidate(): void {
    this.cache.clear();
  }
}

/** A scoped view of the CredentialService (filters by tags/names). */
export class ScopedCredentialService {
  constructor(
    private readonly parent: CredentialService,
    private readonly scope: CredentialScope,
  ) {}

  async get(name: string): Promise<string | undefined> {
    if (this.scope.names.length > 0 && !this.scope.names.includes(name)) {
      return undefined;
    }
    return this.parent.get(name);
  }

  async require(name: string): Promise<string> {
    if (this.scope.names.length > 0 && !this.scope.names.includes(name)) {
      throw new Error(`credential "${name}" is not in scope (tags: ${this.scope.tags.join(",")})`);
    }
    return this.parent.require(name);
  }
}

// ── Env provider ────────────────────────────────────────────────────────────

export class EnvCredentialProvider implements CredentialProvider {
  readonly id = "env";

  resolve(name: string): string | undefined {
    // Direct name first.
    if (process.env[name]) return process.env[name];
    // NEXUM_ prefix.
    if (process.env[`NEXUM_${name}`]) return process.env[`NEXUM_${name}`]!;
    // DEVAGENT_ legacy prefix.
    if (process.env[`DEVAGENT_${name}`]) return process.env[`DEVAGENT_${name}`]!;
    return undefined;
  }

  list(): string[] {
    const names: string[] = [];
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("NEXUM_") || key.startsWith("DEVAGENT_")) {
        names.push(key.replace(/^(NEXUM|DEVAGENT)_/, ""));
      } else if (key.includes("API_KEY") || key.includes("SECRET") || key.includes("TOKEN")) {
        names.push(key);
      }
    }
    return names;
  }
}

// ── File provider ───────────────────────────────────────────────────────────

const CREDENTIALS_FILE = "credentials.json";

export class FileCredentialProvider implements CredentialProvider {
  readonly id = "file";
  private readonly filePath: string;
  private cache: Record<string, string> | null = null;

  constructor(rootDir: string) {
    this.filePath = join(rootDir, CREDENTIALS_FILE);
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const content = readFileSync(this.filePath, "utf8");
      this.cache = JSON.parse(content) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  resolve(name: string): string | undefined {
    return this.load()[name];
  }

  list(): string[] {
    return Object.keys(this.load());
  }

  /** Write a credential to the file (atomic). */
  write(name: string, value: string): void {
    const data = this.load();
    data[name] = value;
    mkdirSync(join(this.filePath, ".."), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    this.cache = data;
  }

  /** Remove a credential from the file. */
  remove(name: string): boolean {
    const data = this.load();
    if (!(name in data)) return false;
    delete data[name];
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    this.cache = data;
    return true;
  }
}

// ── Future providers (not yet implemented — see STABILITY.md) ───────────────
//
// These providers are explicitly INCOMPLETE. They are exported so consumers
// can see the intended API shape, but they throw on use. To track their
// implementation status, see https://github.com/shubhamtaywade82/nexum
// issues labeled `credentials:keychain` / `credentials:vault`.

/**
 * @experimental
 * @incomplete Throws on use — see STABILITY.md.
 *
 * KeychainCredentialProvider — reads credentials from the OS keychain
 * (macOS Keychain, Windows Credential Manager, Linux Secret Service).
 *
 * Planned implementation: use `keytar` (npm) to access the OS keychain.
 * The provider will store each credential under a service name derived
 * from the workspace root + the credential name.
 */
export class KeychainCredentialProvider implements CredentialProvider {
  readonly id = "keychain";
  resolve(): string | undefined {
    // INCOMPLETE: throws until keytar integration is wired up.
    throw new Error(
      "KeychainCredentialProvider is not yet implemented. " +
        "Use EnvCredentialProvider or FileCredentialProvider instead. " +
        "Track implementation: https://github.com/shubhamtaywade82/nexum/issues",
    );
  }
  list(): string[] {
    return [];
  }
}

/**
 * @experimental
 * @incomplete Throws on use — see STABILITY.md.
 *
 * VaultCredentialProvider — reads credentials from a remote secret manager
 * (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, Doppler, etc.).
 *
 * Planned implementation: accept a `VaultClient` adapter (so the consumer
 * can plug in any backend). The provider will cache resolved credentials
 * with a configurable TTL.
 */
export class VaultCredentialProvider implements CredentialProvider {
  readonly id = "vault";
  resolve(): string | undefined {
    // INCOMPLETE: throws until the VaultClient adapter interface is finalized.
    throw new Error(
      "VaultCredentialProvider is not yet implemented. " +
        "Use EnvCredentialProvider or FileCredentialProvider instead. " +
        "Track implementation: https://github.com/shubhamtaywade82/nexum/issues",
    );
  }
  list(): string[] {
    return [];
  }
}

/** Default providers (env + file, if rootDir given). */
export function defaultCredentialProviders(rootDir?: string): CredentialProvider[] {
  const providers: CredentialProvider[] = [new EnvCredentialProvider()];
  if (rootDir) providers.push(new FileCredentialProvider(rootDir));
  return providers;
}

void homedir; // keep import for future use
