/**
 * Plugin Marketplace — discovery, install, update of remote plugins.
 *
 * Nexum's plugin system supports local plugins (registered in code) and
 * filesystem plugins (loaded from `.nexum/plugins/`). The marketplace adds
 * remote discovery + installation:
 *
 *   MarketplaceSource     ← a remote plugin registry (HTTP, git, npm)
 *   MarketplaceEntry      ← a catalog entry (id, version, description, ...)
 *   MarketplaceInstaller  ← downloads + extracts + verifies a plugin
 *   MarketplaceService    ← orchestrates sources + installer + local cache
 *
 * Sources:
 *   HttpMarketplaceSource  — fetch a catalog JSON from a URL
 *   NpmMarketplaceSource   — query npm registry for @nexum-plugin/* packages
 *   GitMarketplaceSource   — clone a git repo (read-only)
 *
 * Installation:
 *   - Plugin is downloaded to `.nexum/plugins/cache/<id>@<version>/`
 *   - Integrity is verified (sha256 from manifest)
 *   - Plugin is registered in `.nexum/plugins/installed.json`
 *   - On next host startup, the PluginLoader picks it up
 *
 * This module is intentionally network-light: heavy operations (git clone,
 * npm install) are stubbed and ready for future implementation.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// ── Contracts ───────────────────────────────────────────────────────────────

export type PluginVersion = string;

export interface MarketplaceEntry {
  /** Plugin id (kebab-case). */
  id: string;
  /** Display name. */
  name: string;
  /** Latest version. */
  version: PluginVersion;
  /** Description. */
  description?: string;
  /** Author. */
  author?: string;
  /** Homepage. */
  homepage?: string;
  /** License. */
  license?: string;
  /** Tags for filtering. */
  tags?: string[];
  /** sha256 of the artifact (integrity check on install). */
  sha256?: string;
  /** Download URL or git ref. */
  downloadUrl?: string;
  /** npm package name (for NpmMarketplaceSource). */
  npmPackage?: string;
  /** Git URL (for GitMarketplaceSource). */
  gitUrl?: string;
  /** Source registry id. */
  source: string;
}

export interface InstalledPlugin {
  id: string;
  version: PluginVersion;
  /** Path where the plugin is installed. */
  path: string;
  /** sha256 of the installed artifact. */
  sha256?: string;
  /** When the plugin was installed. */
  installedAt: string;
  /** Source marketplace id. */
  source: string;
}

export interface MarketplaceSource {
  readonly id: string;
  /** Fetch the full catalog of available plugins. */
  fetchCatalog(): Promise<MarketplaceEntry[]>;
  /** Fetch a single entry by id. */
  fetchEntry(id: string): Promise<MarketplaceEntry | undefined>;
  /** Download a plugin artifact to a local path. */
  download(entry: MarketplaceEntry, destPath: string): Promise<void>;
}

// ── MarketplaceService ──────────────────────────────────────────────────────

export interface MarketplaceServiceOptions {
  /** Root directory for the local plugin cache (e.g. workspaceRoot/.nexum). */
  rootDir?: string;
  /** Disable fs writes (in-memory). */
  inMemory?: boolean;
  /** Marketplace sources. */
  sources?: MarketplaceSource[];
}

export class MarketplaceService {
  private readonly sources: MarketplaceSource[] = [];
  private readonly cache: Map<string, InstalledPlugin> = new Map();
  private readonly cacheDir?: string;
  private readonly indexFile?: string;
  private readonly inMemory: boolean;

  constructor(opts: MarketplaceServiceOptions = {}) {
    this.inMemory = opts.inMemory ?? false;
    if (opts.rootDir && !this.inMemory) {
      this.cacheDir = join(opts.rootDir, "plugins", "cache");
      this.indexFile = join(opts.rootDir, "plugins", "installed.json");
      mkdirSync(this.cacheDir, { recursive: true });
      this.loadIndex();
    }
    for (const src of opts.sources ?? []) {
      this.sources.push(src);
    }
  }

  addSource(source: MarketplaceSource): this {
    if (this.sources.some((s) => s.id === source.id)) {
      throw new Error(`marketplace source "${source.id}" already registered`);
    }
    this.sources.push(source);
    return this;
  }

  removeSource(id: string): boolean {
    const idx = this.sources.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    this.sources.splice(idx, 1);
    return true;
  }

  listSources(): string[] {
    return this.sources.map((s) => s.id);
  }

  /** Search across all sources. */
  async search(query: string, opts?: { tags?: string[]; limit?: number }): Promise<MarketplaceEntry[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const limit = opts?.limit ?? 50;
    const all: MarketplaceEntry[] = [];
    for (const source of this.sources) {
      try {
        const catalog = await source.fetchCatalog();
        for (const entry of catalog) {
          const text =
            `${entry.id} ${entry.name} ${entry.description ?? ""} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
          if (terms.every((t) => text.includes(t))) {
            if (opts?.tags && !opts.tags.every((t) => entry.tags?.includes(t))) continue;
            all.push(entry);
          }
        }
      } catch {
        // source failed — skip
      }
    }
    return all.slice(0, limit);
  }

  /** Install a plugin from a marketplace source. */
  async install(entry: MarketplaceEntry): Promise<InstalledPlugin> {
    if (!this.cacheDir || !this.indexFile) {
      throw new Error("marketplace not configured with a rootDir — cannot install");
    }
    const source = this.sources.find((s) => s.id === entry.source);
    if (!source) {
      throw new Error(`marketplace source "${entry.source}" not registered`);
    }

    const installDir = join(this.cacheDir, `${entry.id}@${entry.version}`);
    if (existsSync(installDir)) {
      // Already installed — return existing record.
      const existing = this.cache.get(`${entry.id}@${entry.version}`);
      if (existing) return existing;
    }

    mkdirSync(installDir, { recursive: true });
    const artifactPath = join(installDir, "plugin.tar.gz");
    await source.download(entry, artifactPath);

    // Verify integrity.
    if (entry.sha256) {
      const actual = sha256File(artifactPath);
      if (actual !== entry.sha256) {
        rmSync(installDir, { recursive: true, force: true });
        throw new Error(`integrity check failed: expected ${entry.sha256}, got ${actual}`);
      }
    }

    const record: InstalledPlugin = {
      id: entry.id,
      version: entry.version,
      path: installDir,
      sha256: entry.sha256,
      installedAt: new Date().toISOString(),
      source: entry.source,
    };
    this.cache.set(`${entry.id}@${entry.version}`, record);
    this.persistIndex();
    return record;
  }

  /** Uninstall a plugin. */
  uninstall(id: string, version?: string): boolean {
    const key = version ? `${id}@${version}` : this.findLatestKey(id);
    if (!key) return false;
    const record = this.cache.get(key);
    if (!record) return false;
    if (record.path && existsSync(record.path)) {
      try {
        rmSync(record.path, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    this.cache.delete(key);
    this.persistIndex();
    return true;
  }

  /** List installed plugins. */
  listInstalled(): InstalledPlugin[] {
    return [...this.cache.values()];
  }

  /** Check if a plugin is installed. */
  isInstalled(id: string, version?: string): boolean {
    if (version) return this.cache.has(`${id}@${version}`);
    return [...this.cache.keys()].some((k) => k.startsWith(`${id}@`));
  }

  /** Get an installed plugin record. */
  getInstalled(id: string, version?: string): InstalledPlugin | undefined {
    if (version) return this.cache.get(`${id}@${version}`);
    const key = this.findLatestKey(id);
    return key ? this.cache.get(key) : undefined;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private findLatestKey(id: string): string | undefined {
    const keys = [...this.cache.keys()].filter((k) => k.startsWith(`${id}@`));
    if (keys.length === 0) return undefined;
    // Pick the highest version (lexicographic for now).
    keys.sort();
    return keys[keys.length - 1];
  }

  private loadIndex(): void {
    if (!this.indexFile || !existsSync(this.indexFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.indexFile, "utf8"));
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (entry.id && entry.version) {
            this.cache.set(`${entry.id}@${entry.version}`, entry);
          }
        }
      }
    } catch {
      // corrupt — start fresh
    }
  }

  private persistIndex(): void {
    if (this.inMemory || !this.indexFile) return;
    try {
      const tmp = `${this.indexFile}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.cache.values()], null, 2));
      renameSync(tmp, this.indexFile);
    } catch {
      // best-effort
    }
  }
}

// ── Stub marketplace sources ─────────────────────────────────────────────────

/**
 * HttpMarketplaceSource — fetches a catalog JSON from a URL.
 * Uses Node's built-in fetch.
 */
export class HttpMarketplaceSource implements MarketplaceSource {
  readonly id: string;
  private cache: MarketplaceEntry[] | null = null;

  constructor(
    id: string,
    private readonly catalogUrl: string,
  ) {
    this.id = id;
  }

  async fetchCatalog(): Promise<MarketplaceEntry[]> {
    if (this.cache) return this.cache;
    try {
      const response = await fetch(this.catalogUrl);
      const data = await response.json();
      if (Array.isArray(data)) {
        this.cache = data as MarketplaceEntry[];
        return this.cache;
      }
    } catch {
      // network failed
    }
    return [];
  }

  async fetchEntry(id: string): Promise<MarketplaceEntry | undefined> {
    const catalog = await this.fetchCatalog();
    return catalog.find((e) => e.id === id);
  }

  async download(entry: MarketplaceEntry, destPath: string): Promise<void> {
    if (!entry.downloadUrl) {
      throw new Error(`entry "${entry.id}" has no downloadUrl`);
    }
    const response = await fetch(entry.downloadUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(destPath, buffer);
  }
}

/**
 * StubNpmMarketplaceSource — placeholder for npm-based discovery.
 */
export class NpmMarketplaceSource implements MarketplaceSource {
  readonly id = "npm";
  async fetchCatalog(): Promise<MarketplaceEntry[]> {
    return []; // TODO: query npm registry for @nexum-plugin/* packages
  }
  async fetchEntry(_id: string): Promise<MarketplaceEntry | undefined> {
    return undefined;
  }
  async download(_entry: MarketplaceEntry, _destPath: string): Promise<void> {
    throw new Error("NpmMarketplaceSource.download() not yet implemented");
  }
}

/**
 * GitMarketplaceSource — clones a remote git repo to discover + download
 * plugins. Each entry's `gitUrl` is a git remote (HTTPS or SSH); each entry
 * may reference a subdirectory within the repo via `downloadUrl` (interpreted
 * as `path/to/subdir` within the clone).
 *
 * Catalog discovery:
 *   - The source's `repoUrl` is cloned (shallow, depth=1) to a temp dir.
 *   - The repo's root is scanned for `marketplace.json` (a JSON array of
 *     MarketplaceEntry) or for individual `<id>/plugin.json` manifests.
 *   - Results are cached (TTL configurable, default 5 min).
 *
 * Download:
 *   - For an entry, the repo is cloned again (or reuses the cached clone)
 *     and the entry's `downloadUrl` (subdirectory path) is tarred into the
 *     destPath. The caller (MarketplaceService) verifies sha256.
 *
 * Requires `git` on PATH. Uses child_process.spawn — no native bindings.
 */
export interface GitMarketplaceSourceOptions {
  /** Cache TTL in ms (default 5 min). */
  cacheTtlMs?: number;
  /** Extra args passed to git clone (e.g. ["--branch", "main"]). */
  cloneArgs?: string[];
  /** Whether to use shallow clones (default true, --depth=1). */
  shallow?: boolean;
}

export class GitMarketplaceSource implements MarketplaceSource {
  readonly id: string;
  private readonly repoUrl: string;
  private readonly opts: GitMarketplaceSourceOptions;
  private cache: { entries: MarketplaceEntry[]; clonedAt: number } | null = null;

  constructor(id: string, repoUrl: string, opts: GitMarketplaceSourceOptions = {}) {
    this.id = id;
    this.repoUrl = repoUrl;
    this.opts = opts;
  }

  async fetchCatalog(): Promise<MarketplaceEntry[]> {
    const ttl = this.opts.cacheTtlMs ?? 5 * 60 * 1000;
    if (this.cache && Date.now() - this.cache.clonedAt < ttl) {
      return this.cache.entries;
    }
    // Clone the repo to a temp dir and scan for plugin manifests.
    const cloneDir = mkdtempSync(join(tmpdir(), "nexum-mkt-git-"));
    try {
      const rc = await gitClone(this.repoUrl, cloneDir, {
        shallow: this.opts.shallow ?? true,
        extraArgs: this.opts.cloneArgs,
      });
      if (rc !== 0) return [];
      // Look for marketplace.json (single catalog file).
      const catalogPath = join(cloneDir, "marketplace.json");
      let entries: MarketplaceEntry[] = [];
      if (existsSync(catalogPath)) {
        try {
          const data = JSON.parse(readFileSync(catalogPath, "utf8"));
          if (Array.isArray(data)) {
            // Tag every entry with the source id so callers know where it came from.
            entries = (data as MarketplaceEntry[]).map((e) => ({ ...e, source: this.id }));
          }
        } catch {
          // corrupt — fall through to per-directory scan
        }
      }
      // Fall back to scanning each top-level directory for plugin.json.
      if (entries.length === 0) {
        const subdirs = listSubdirectories(cloneDir);
        for (const dir of subdirs) {
          const manifestPath = join(dir, "plugin.json");
          if (!existsSync(manifestPath)) continue;
          try {
            const data = JSON.parse(readFileSync(manifestPath, "utf8"));
            if (isValidEntry(data)) {
              entries.push({
                ...data,
                gitUrl: this.repoUrl,
                source: this.id,
              } as MarketplaceEntry);
            }
          } catch {
            // skip corrupt
          }
        }
      }
      this.cache = { entries, clonedAt: Date.now() };
      return entries;
    } finally {
      // Best-effort cleanup of the temp clone.
      try {
        rmSync(cloneDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  async fetchEntry(id: string): Promise<MarketplaceEntry | undefined> {
    const catalog = await this.fetchCatalog();
    return catalog.find((e) => e.id === id);
  }

  async download(entry: MarketplaceEntry, destPath: string): Promise<void> {
    // Clone the entry's gitUrl (or the source's repoUrl if entry has none)
    // to a temp dir, then copy the entry's subdirectory (downloadUrl) into
    // a tarball at destPath.
    const gitUrl = entry.gitUrl ?? this.repoUrl;
    const subDir = entry.downloadUrl ?? ""; // subdirectory within the clone
    const cloneDir = mkdtempSync(join(tmpdir(), "nexum-mkt-dl-"));
    try {
      const rc = await gitClone(gitUrl, cloneDir, {
        shallow: this.opts.shallow ?? true,
        extraArgs: this.opts.cloneArgs,
      });
      if (rc !== 0) {
        throw new Error(`git clone failed (exit code ${rc}) for ${gitUrl}`);
      }
      // Locate the subdir within the clone.
      const srcDir = subDir ? join(cloneDir, subDir) : cloneDir;
      if (!existsSync(srcDir)) {
        throw new Error(`subdirectory "${subDir}" not found in cloned repo`);
      }
      // Tar the directory to destPath.
      const tarRc = await runCommand("tar", ["-czf", destPath, "-C", srcDir, "."]);
      if (tarRc !== 0) {
        throw new Error(`tar failed (exit code ${tarRc})`);
      }
    } finally {
      try {
        rmSync(cloneDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

/** Run `git clone <url> <dest>` with optional shallow flag. Returns exit code. */
function gitClone(url: string, dest: string, opts: { shallow?: boolean; extraArgs?: string[] }): Promise<number> {
  const args = ["clone", ...(opts.shallow ? ["--depth", "1"] : []), ...(opts.extraArgs ?? []), url, dest];
  return runCommand("git", args);
}

/** Spawn a command, capture stdout/stderr, return exit code. */
function runCommand(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", (err) => {
      reject(new Error(`failed to spawn "${cmd}": ${err.message}`));
    });
    child.on("exit", (code) => {
      resolve(code ?? 0);
    });
  });
}

/** List immediate subdirectories of a path (skips .git). */
function listSubdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ".git")
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** Quick structural validation of a marketplace entry. */
function isValidEntry(value: unknown): value is MarketplaceEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" && typeof v.version === "string";
}

// Re-export `tmpdir` consumer so imports stay used.
void statSync;

// ── Helpers ─────────────────────────────────────────────────────────────────

function sha256File(path: string): string {
  const buffer = readFileSync(path);
  return createHash("sha256").update(buffer).digest("hex");
}

void readdirSync; // keep import
