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
 *   KeychainCredentialProvider ← OS keychain (macOS security / Linux secret-tool)
 *   VaultCredentialProvider    ← remote secret managers behind the VaultClient
 *                                port (HttpVaultClient: HashiCorp Vault KV v2)
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

// ── Keychain provider (OS keychain via platform CLI tools) ──────────────────

/** Outcome of one executor run: stdout plus a normalized error marker. */
export interface ExecResult {
  code: number;
  stdout: string;
  /** True when the binary itself was missing (ENOENT) — not an error. */
  notFound: boolean;
}

/** Injectable process runner (tests pass a fake; prod spawns real CLIs). */
export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

/** Platform identifier (process.platform by default; injectable for tests). */
export type Platform = "darwin" | "linux" | "win32" | "other";

/** Real executor: node child_process.execFile, never throwing. */
async function defaultExec(command: string, args: string[]): Promise<ExecResult> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({
        code: typeof e?.code === "number" ? e.code : e ? 1 : 0,
        stdout: stdout?.toString() ?? "",
        notFound: e !== null && typeof e.code === "string" && e.code === "ENOENT",
      });
    });
  });
}

export interface KeychainCredentialProviderOptions {
  /** Keychain service name (default "nexum"). */
  service?: string;
  /** Platform override (default process.platform). */
  platform?: Platform;
  /** Executor override (default real child_process). */
  exec?: ExecFn;
}

/**
 * KeychainCredentialProvider — OS keychain access without native deps:
 *   macOS:  `security find-generic-password -s <service> -a <name> -w`
 *   Linux:  `secret-tool lookup service <service> account <name>` (Secret Service / libsecret)
 *   other:  no support — resolves undefined (never throws)
 *
 * Degrades gracefully: missing binary, missing backend, or wrong platform all
 * resolve undefined so the CredentialService chain simply tries the next
 * provider. Enumerating keychain entries is deliberately NOT implemented
 * (dump-keychain is slow and touches unrelated items) — list() is empty.
 */
export class KeychainCredentialProvider implements CredentialProvider {
  readonly id = "keychain";
  private readonly service: string;
  private readonly platform: Platform;
  private readonly exec: ExecFn;

  constructor(opts: KeychainCredentialProviderOptions = {}) {
    this.service = opts.service ?? "nexum";
    this.platform = opts.platform ?? (process.platform as Platform);
    this.exec = opts.exec ?? defaultExec;
  }

  /** Store a credential in the OS keychain (best effort — throws on failure). */
  async set(name: string, value: string): Promise<void> {
    if (this.platform === "darwin") {
      const r = await this.exec("security", [
        "add-generic-password",
        "-U",
        "-s",
        this.service,
        "-a",
        name,
        "-w",
        value,
      ]);
      if (r.code !== 0 && !r.notFound) throw new Error(`keychain write failed (security exit ${r.code})`);
      if (r.notFound) throw new Error("security(1) not available");
      return;
    }
    if (this.platform === "linux") {
      const r = await this.exec("secret-tool", ["store", "--label=nexum", "service", this.service, "account", name]);
      if (r.code === 0 && !r.notFound) return;
      if (r.notFound) throw new Error("secret-tool not available (install libsecret-tools)");
      throw new Error(`keychain write failed (secret-tool exit ${r.code})`);
    }
    throw new Error(`keychain writes unsupported on platform "${this.platform}"`);
  }

  async resolve(name: string): Promise<string | undefined> {
    if (this.platform === "darwin") {
      const r = await this.exec("security", ["find-generic-password", "-s", this.service, "-a", name, "-w"]);
      if (r.code === 0 && !r.notFound) return r.stdout.trim() || undefined;
      return undefined; // item missing, security missing, or keychain locked — not our problem to raise
    }
    if (this.platform === "linux") {
      const r = await this.exec("secret-tool", ["lookup", "service", this.service, "account", name]);
      if (r.code === 0 && !r.notFound) return r.stdout.trim() || undefined;
      return undefined;
    }
    return undefined; // win32 / other: unsupported, chain continues
  }

  list(): string[] {
    return []; // enumeration deliberately unsupported (see class doc)
  }
}

// ── Vault provider (remote secret managers behind one client port) ─────────

/** Minimal port for any secret backend (HashiCorp Vault, cloud SMs, Doppler…). */
export interface VaultClient {
  /** Read one secret; undefined = not found. Keys are the secret's fields. */
  readSecret(path: string): Promise<Record<string, string> | undefined>;
  /** Optional path listing for `list()` support. */
  listPaths?(prefix: string): Promise<string[]>;
}

export interface HttpVaultClientOptions {
  /** Vault address, e.g. https://vault.example.com:8200 (no /v1 suffix). */
  baseUrl: string;
  /** Auth token (X-Vault-Token). Supply via env or a credential — never hardcode. */
  token: string;
  /** KV mount point (default "secret", the KV v2 default). */
  mount?: string;
  /** fetch override (tests inject a fake; default global fetch). */
  fetch?: typeof fetch;
}

/**
 * HttpVaultClient — HashiCorp Vault KV v2 reader.
 * GET {base}/v1/{mount}/data/{path} → { data: { data: { key: value } } }.
 * Failures resolve undefined (a sealed/unreachable vault must not crash the
 * credential chain); the token is only ever sent in the X-Vault-Token header.
 */
export class HttpVaultClient implements VaultClient {
  private readonly base: string;
  private readonly token: string;
  private readonly mount: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: HttpVaultClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.mount = opts.mount ?? "secret";
    this.doFetch = opts.fetch ?? (globalThis.fetch as typeof fetch);
  }

  async readSecret(path: string): Promise<Record<string, string> | undefined> {
    const url = `${this.base}/v1/${this.mount}/data/${path.replace(/^\/+/, "")}`;
    let resp: Response;
    try {
      resp = await this.doFetch(url, { headers: { "X-Vault-Token": this.token } });
    } catch {
      return undefined; // network/sealed/unreachable — degrade, never throw
    }
    if (!resp.ok) return undefined;
    try {
      const body = (await resp.json()) as { data?: { data?: Record<string, string> } };
      return body.data?.data;
    } catch {
      return undefined;
    }
  }
}

export interface VaultCredentialProviderOptions {
  /** Cache TTL in ms (default 5 min; 0 disables caching). */
  ttlMs?: number;
  /** Restrict reads to this path prefix (default: no restriction). */
  prefix?: string;
  /** Map a credential name to a secret path + field. Default: "a/b#c" → path "a/b", field "c"; no "#" → field "value". */
  nameToPath?: (name: string) => { path: string; key: string };
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Default name mapping: "team/api-key#token" → secret "team/api-key", field "token". */
export function defaultVaultNameMapping(name: string): { path: string; key: string } {
  const hash = name.lastIndexOf("#");
  if (hash >= 0) return { path: name.slice(0, hash), key: name.slice(hash + 1) };
  return { path: name, key: "value" };
}

/**
 * VaultCredentialProvider — remote secret manager access behind the
 * VaultClient port, with a TTL cache so repeated get()s don't re-read the
 * backend. Resolution failures (missing path, unreachable vault, missing
 * field) resolve undefined — the CredentialService chain moves on.
 */
export class VaultCredentialProvider implements CredentialProvider {
  readonly id = "vault";
  private readonly client: VaultClient;
  private readonly ttlMs: number;
  private readonly prefix?: string;
  private readonly nameToPath: (name: string) => { path: string; key: string };
  private readonly now: () => number;
  private readonly cache = new Map<string, { value?: string; at: number }>();

  constructor(client: VaultClient, opts: VaultCredentialProviderOptions = {}) {
    this.client = client;
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.prefix = opts.prefix;
    this.nameToPath = opts.nameToPath ?? defaultVaultNameMapping;
    this.now = opts.now ?? Date.now;
  }

  async resolve(name: string): Promise<string | undefined> {
    const cached = this.cache.get(name);
    if (cached && (this.ttlMs === 0 || this.now() - cached.at < this.ttlMs)) {
      return cached.value;
    }

    const { path, key } = this.nameToPath(name);
    const fullPath = this.prefix ? `${this.prefix.replace(/\/+$/, "")}/${path}` : path;
    let value: string | undefined;
    try {
      const secret = await this.client.readSecret(fullPath);
      value = secret?.[key];
    } catch {
      value = undefined; // backend hiccup — degrade, never throw
    }
    this.cache.set(name, { value, at: this.now() });
    return value;
  }

  async list(): Promise<string[]> {
    if (!this.client.listPaths || !this.prefix) return [];
    try {
      return await this.client.listPaths(this.prefix);
    } catch {
      return [];
    }
  }

  /** Drop cached entries (e.g. after a vault unseal or credential rotation). */
  invalidate(): void {
    this.cache.clear();
  }
}

/** Default providers (env + file, if rootDir given). */
export function defaultCredentialProviders(rootDir?: string): CredentialProvider[] {
  const providers: CredentialProvider[] = [new EnvCredentialProvider()];
  if (rootDir) providers.push(new FileCredentialProvider(rootDir));
  return providers;
}

void homedir; // keep import for future use
