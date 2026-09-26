/**
 * CLI surface for the trust & security layer.
 *
 * Wires the P2 subsystems into operator-facing commands:
 *
 *   nexum plugins sandbox <file>    — trial-run a plugin in the Tier-2 worker sandbox
 *   nexum plugins verify [id…]     — re-verify installed marketplace plugins
 *   nexum marketplace keys …       — publisher trust store management
 *   nexum mcp trust …              — MCP server approvals & policy preview
 *   nexum credentials …            — credential resolution preview (always redacted)
 *   nexum capabilities …           — capability attestation authority & ledger
 *
 * Design rules:
 *   - Exit codes: 0 = ok, 1 = verification/runtime failure, 2 = usage error.
 *   - `--json` prints pure JSON (no headers) so output is jq-able.
 *   - Never print raw secret values — previews use `redact()`.
 *   - All state lives under the workspace state dir (`.nexum/`), never the
 *     repo itself: `mcp-trust.json`, `publisher-trust.json`,
 *     `attestation-authority.pem`, `attestation-ledger.json`, `plugins/`.
 *   - I/O is injectable so tests run without touching process.stdout or the
 *     real workspace.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPublicKey } from "node:crypto";
import { loadConfig, type McpCliServerConfig } from "./config.js";
import { findWorkspaceRoot, workspaceStateDir } from "../platform/paths.js";
import { IsolatedPluginSandbox, type PluginSandboxPolicy, type IsolatedPlugin } from "../platform/plugins/sandbox.js";
import type { PluginContext, PluginHost, PluginLogger } from "../platform/plugins/types.js";
import { MarketplaceService, type InstalledPlugin } from "../marketplace/index.js";
import { PublisherTrustStore, keyIdFromSpki, type PublisherTrustLevel } from "../marketplace/trust.js";
import { McpApprovalStore, mcpServerFingerprint, mcpTrustPolicyFromConfig } from "../mcp/trust.js";
import {
  defaultCredentialProviders,
  KeychainCredentialProvider,
  HttpVaultClient,
  VaultCredentialProvider,
  redact,
  type CredentialProvider,
} from "../credentials/index.js";
import {
  AttestationAuthority,
  AttestationLedger,
  loadOrCreateAuthority,
  type AttestationSubjectType,
  type CapabilityAttestation,
} from "../core/capabilities/attestation.js";

// ── Shared context ──────────────────────────────────────────────────────────

export interface SecurityCliOptions {
  /** Line writer for normal output (default: console.log). */
  stdout?: (line?: string) => void;
  /** Line writer for errors + usage (default: console.error). */
  stderr?: (line?: string) => void;
  /** Working directory for resolving relative paths (default: process.cwd()). */
  cwd?: string;
  /** Workspace root override (default: findWorkspaceRoot(cwd)). */
  workspaceRoot?: string;
  /** Configured MCP servers (default: loadConfig().mcpServers). Injectable for tests. */
  mcpServers?: () => McpCliServerConfig[];
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

interface Ctx {
  out: (line?: string) => void;
  err: (line?: string) => void;
  cwd: string;
  root: string;
  stateDir: string;
  mcpServers: () => McpCliServerConfig[];
  now: () => Date;
}

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

/** Entry point — returns the process exit code. */
export async function runSecurityCli(area: string, argv: string[], opts: SecurityCliOptions = {}): Promise<number> {
  const out = opts.stdout ?? ((line?: string) => console.log(line ?? ""));
  const err = opts.stderr ?? ((line?: string) => console.error(line ?? ""));
  const cwd = opts.cwd ?? process.cwd();
  const root = opts.workspaceRoot ?? findWorkspaceRoot(cwd);
  const ctx: Ctx = {
    out,
    err,
    cwd,
    root,
    stateDir: workspaceStateDir(root),
    mcpServers: opts.mcpServers ?? (() => loadConfig().mcpServers ?? []),
    now: opts.now ?? (() => new Date()),
  };

  switch (area) {
    case "plugins":
      return runPluginsCommand(argv, ctx);
    case "marketplace":
      return runMarketplaceCommand(argv, ctx);
    case "mcp":
      return runMcpCommand(argv, ctx);
    case "credentials":
      return runCredentialsCommand(argv, ctx);
    case "capabilities":
      return runCapabilitiesCommand(argv, ctx);
    default:
      err(`Unknown command area "${area}".`);
      err(SECURITY_HELP);
      return EXIT_USAGE;
  }
}

const SECURITY_HELP = `Trust & security commands:
  nexum plugins sandbox <file> [flags]   Trial-run a plugin in the worker sandbox
  nexum plugins verify [id…]             Re-verify installed marketplace plugins
  nexum marketplace keys list|add|remove Publisher trust store management
  nexum mcp trust list|policy|approve|revoke  MCP server trust approvals
  nexum credentials list|get <name>      Credential resolution preview (redacted)
  nexum capabilities attest|verify|revoke|list  Capability attestation authority

Run a subcommand with --help-less flags mistake to see its usage on error.`;

// ── Small helpers ───────────────────────────────────────────────────────────

function usageError(err: (line?: string) => void, usage: string): number {
  err(usage);
  return EXIT_USAGE;
}

/** Render rows as an aligned text table (padEnd columns, two-space gutters). */
function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  return [line(headers), ...rows.map(line)];
}

function flagInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${flag} expects a non-negative integer, got "${value}"`);
  return n;
}

/** Parse "30d" / "12h" / "45m" / "90s" / "1500" (raw ms) into milliseconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+)(s|m|h|d)?$/.exec(input.trim());
  if (!m) throw new Error(`invalid duration "${input}" — expected e.g. 90s, 45m, 12h, 30d`);
  const n = Number.parseInt(m[1], 10);
  switch (m[2]) {
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return n;
  }
}

/** Parse "plugin:my-plugin" into an attestation subject. */
export function parseSubject(input: string): { type: AttestationSubjectType; id: string } {
  const idx = input.indexOf(":");
  if (idx <= 0 || idx === input.length - 1) {
    throw new Error(`invalid subject "${input}" — expected <type>:<id>, e.g. plugin:my-plugin`);
  }
  const type = input.slice(0, idx) as AttestationSubjectType;
  const id = input.slice(idx + 1);
  const valid: AttestationSubjectType[] = ["plugin", "agent", "tool", "mcp-server", "host"];
  if (!valid.includes(type)) {
    throw new Error(`invalid subject type "${type}" — expected one of ${valid.join(", ")}`);
  }
  return { type, id };
}

// ── nexum plugins ───────────────────────────────────────────────────────────

const PLUGINS_USAGE = `Usage:
  nexum plugins sandbox <file> [--allow-lookup p]… [--allow-provide p]… [--allow-declare p]…
                            [--max-provides N] [--setup-timeout-ms N] [--start-timeout-ms N]
                            [--stop-timeout-ms N] [--json]
  nexum plugins verify [id…] [--json]`;

function runPluginsCommand(argv: string[], ctx: Ctx): Promise<number> | number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "allow-lookup": { type: "string", multiple: true },
      "allow-provide": { type: "string", multiple: true },
      "allow-declare": { type: "string", multiple: true },
      "max-provides": { type: "string" },
      "setup-timeout-ms": { type: "string" },
      "start-timeout-ms": { type: "string" },
      "stop-timeout-ms": { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const sub = positionals[0];
  if (sub === "sandbox") {
    return runPluginSandbox(positionals.slice(1), values, ctx);
  }
  if (sub === "verify") {
    return runPluginsVerify(positionals.slice(1), values, ctx);
  }
  return usageError(ctx.err, PLUGINS_USAGE);
}

type SandboxFlags = {
  "allow-lookup"?: string[];
  "allow-provide"?: string[];
  "allow-declare"?: string[];
  "max-provides"?: string;
  "setup-timeout-ms"?: string;
  "start-timeout-ms"?: string;
  "stop-timeout-ms"?: string;
  json?: boolean;
};

async function runPluginSandbox(args: string[], values: SandboxFlags, ctx: Ctx): Promise<number> {
  const file = args[0];
  if (!file || args.length > 1) return usageError(ctx.err, PLUGINS_USAGE);
  const pluginFile = isAbsolute(file) ? file : resolve(ctx.cwd, file);
  if (!existsSync(pluginFile)) {
    ctx.err(`plugin file not found: ${pluginFile}`);
    return EXIT_FAIL;
  }

  const policy: PluginSandboxPolicy = {
    provide: values["allow-provide"],
    lookup: values["allow-lookup"],
    declare: values["allow-declare"],
    maxProvides: flagInt(values["max-provides"], "max-provides"),
  };

  let plugin: IsolatedPlugin;
  try {
    plugin = await IsolatedPluginSandbox.load(pluginFile, {
      policy,
      setupTimeoutMs: flagInt(values["setup-timeout-ms"], "setup-timeout-ms"),
      startTimeoutMs: flagInt(values["start-timeout-ms"], "start-timeout-ms"),
      stopTimeoutMs: flagInt(values["stop-timeout-ms"], "stop-timeout-ms"),
    });
  } catch (err) {
    ctx.err(`failed to load plugin: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_FAIL;
  }

  /**
   * Trial-mode PluginContext: the bridge binds provide/lookup host-side, so
   * we hand it a stand-in — provides are recorded for the report, lookups
   * resolve undefined (no live host in a trial run), host access fails loud.
   */
  const provided = new Map<string, unknown>();
  const trialLogger: PluginLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const trialHost = new Proxy({} as PluginHost, {
    get: () => {
      throw new Error("host access is not available in sandbox trial mode");
    },
  });
  const trialContext: PluginContext = {
    manifest: plugin.manifest,
    host: trialHost,
    workspaceRoot: ctx.root,
    log: trialLogger,
    provide: (token, value) => {
      provided.set(token, value);
    },
    lookup: () => undefined,
    declareCapability: () => undefined,
  };

  const phases: Array<{ phase: "setup" | "start" | "stop"; ok: boolean; ms: number; error?: string }> = [];
  const runPhase = async (phase: "setup" | "start" | "stop") => {
    const t0 = Date.now();
    try {
      if (phase === "setup") await plugin.setup?.(trialContext);
      else if (phase === "start") await plugin.start?.();
      else await plugin.stop?.();
      phases.push({ phase, ok: true, ms: Date.now() - t0 });
    } catch (err) {
      phases.push({
        phase,
        ok: false,
        ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  await runPhase("setup");
  await runPhase("start");
  await runPhase("stop");
  await plugin.sandbox.terminate().catch(() => undefined);

  const audit = plugin.sandbox.audit();
  const denied = audit.filter((a) => a.decision === "denied");
  const pass = phases.every((p) => p.ok) && denied.length === 0;

  if (values.json) {
    ctx.out(
      JSON.stringify(
        {
          plugin: {
            id: plugin.manifest.id,
            name: plugin.manifest.name,
            version: plugin.manifest.version,
          },
          file: pluginFile,
          policy,
          phases,
          audit,
          provided: Object.fromEntries(provided),
          pass,
        },
        null,
        2,
      ),
    );
    return pass ? EXIT_OK : EXIT_FAIL;
  }

  ctx.out("=== Nexum Plugin Sandbox ===");
  ctx.out(`plugin: ${plugin.manifest.id}@${plugin.manifest.version} (${plugin.manifest.name})`);
  ctx.out(`file: ${pluginFile}`);
  ctx.out(
    `policy: provide=${JSON.stringify(policy.provide ?? [])} lookup=${JSON.stringify(policy.lookup ?? [])} ` +
      `declare=${JSON.stringify(policy.declare ?? [])} maxProvides=${policy.maxProvides ?? "default"}`,
  );
  ctx.out("trial: lookups resolve undefined (no live host); provides are recorded, not mounted");
  for (const p of phases) {
    ctx.out(`${p.phase.padEnd(5)}: ${p.ok ? "ok" : "FAILED"} (${p.ms}ms)${p.error ? ` — ${p.error}` : ""}`);
  }
  ctx.out(`audit: ${audit.length} operations (${audit.length - denied.length} allowed, ${denied.length} denied)`);
  for (const entry of audit) {
    ctx.out(
      `  ${entry.operation} ${entry.target} → ${entry.decision.toUpperCase()}${entry.reason ? ` (${entry.reason})` : ""}`,
    );
  }
  const note = pass
    ? "clean lifecycle"
    : phases.every((p) => p.ok)
      ? "lifecycle completed, but policy violations were recorded"
      : "lifecycle failed";
  ctx.out(`result: ${pass ? "PASS" : "FAIL"} (${note})`);
  return pass ? EXIT_OK : EXIT_FAIL;
}

async function runPluginsVerify(ids: string[], values: { json?: boolean }, ctx: Ctx): Promise<number> {
  const svc = new MarketplaceService({ rootDir: ctx.stateDir });
  const all = svc.listInstalled();
  const records: InstalledPlugin[] = [];
  let missing = false;
  if (ids.length === 0) {
    records.push(...all);
    if (all.length === 0) {
      ctx.out("no plugins installed");
      return EXIT_OK;
    }
  } else {
    for (const id of ids) {
      const matches = all.filter((r) => r.id === id);
      if (matches.length === 0) {
        ctx.err(`plugin "${id}" is not installed`);
        missing = true;
      }
      records.push(...matches);
    }
  }

  const rows: Array<Record<string, unknown>> = [];
  let failures = 0;
  for (const record of records) {
    const verdict = svc.verifyInstalled(record.id, record.version);
    const signature = record.verification?.status ?? "unsigned";
    if (!verdict.ok) failures++;
    rows.push({
      plugin: `${record.id}@${record.version}`,
      source: record.source,
      integrity: verdict.ok ? "ok" : "FAIL",
      reason: verdict.ok ? undefined : verdict.reason,
      signature,
      publisher: record.publisher ?? "",
      trustScore: record.trustScore ?? "",
    });
  }

  if (values.json) {
    ctx.out(JSON.stringify({ ok: failures === 0 && !missing, rows }, null, 2));
  } else {
    ctx.out("=== Nexum Plugin Verification ===");
    for (const line of renderTable(
      ["plugin", "integrity", "signature", "publisher", "trust", "source"],
      rows.map((r) => [
        String(r.plugin),
        r.integrity === "ok" ? "ok" : `FAIL: ${r.reason}`,
        String(r.signature),
        String(r.publisher || "—"),
        r.trustScore === "" ? "—" : String(r.trustScore),
        String(r.source),
      ]),
    )) {
      ctx.out(line);
    }
    const unsigned = rows.filter((r) => r.signature === "unsigned").length;
    if (unsigned > 0) {
      ctx.out(
        `note: ${unsigned} plugin(s) unsigned — install policy "warn" allows them (see docs/guide/marketplace.md)`,
      );
    }
    ctx.out(failures === 0 && !missing ? "all installed plugins verified" : "verification FAILED");
  }
  return failures === 0 && !missing ? EXIT_OK : EXIT_FAIL;
}

// ── nexum marketplace ───────────────────────────────────────────────────────

const MARKETPLACE_USAGE = `Usage:
  nexum marketplace keys list [--json]
  nexum marketplace keys add <public-key-file> --publisher <name> [--level verified|community] [--note <text>]
  nexum marketplace keys remove <keyId>`;

function runMarketplaceCommand(argv: string[], ctx: Ctx): Promise<number> | number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      publisher: { type: "string" },
      level: { type: "string" },
      note: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const sub = positionals[0];
  const rest = positionals.slice(1);
  if (sub === "keys") return runMarketplaceKeys(rest, values, ctx);
  return usageError(ctx.err, MARKETPLACE_USAGE);
}

async function runMarketplaceKeys(
  args: string[],
  values: { publisher?: string; level?: string; note?: string; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const store = PublisherTrustStore.open(join(ctx.stateDir, "publisher-trust.json"));
  const sub = args[0];

  if (sub === "list") {
    const records = store.list();
    if (values.json) {
      ctx.out(JSON.stringify({ keys: records }, null, 2));
      return EXIT_OK;
    }
    ctx.out("=== Nexum Publisher Trust Store ===");
    if (records.length === 0) {
      ctx.out("no publisher keys registered");
      return EXIT_OK;
    }
    for (const line of renderTable(
      ["keyId", "publisher", "trust", "addedAt", "note"],
      records.map((r) => [r.keyId, r.publisher, r.trust, r.addedAt, r.note ?? ""]),
    )) {
      ctx.out(line);
    }
    return EXIT_OK;
  }

  if (sub === "add") {
    const file = args[1];
    if (!file || !values.publisher) return usageError(ctx.err, MARKETPLACE_USAGE);
    const level = (values.level ?? "community") as PublisherTrustLevel;
    if (level !== "verified" && level !== "community") {
      ctx.err(`--level must be "verified" or "community", got "${level}"`);
      return EXIT_USAGE;
    }
    const keyFile = isAbsolute(file) ? file : resolve(ctx.cwd, file);
    if (!existsSync(keyFile)) {
      ctx.err(`public key file not found: ${keyFile}`);
      return EXIT_FAIL;
    }
    const content = readFileSync(keyFile, "utf8").trim();
    let publicKeyBase64: string;
    try {
      // Accept either a PEM SPKI public key or a raw base64 DER SPKI blob.
      // Both paths validate by constructing the key — garbage is rejected.
      publicKeyBase64 = content.includes("-----BEGIN")
        ? createPublicKey(content).export({ type: "spki", format: "der" }).toString("base64")
        : createPublicKey({ key: Buffer.from(content, "base64"), format: "der", type: "spki" })
            .export({
              type: "spki",
              format: "der",
            })
            .toString("base64");
      const keyId = keyIdFromSpki(publicKeyBase64);
      store.add({ keyId, publicKey: publicKeyBase64, publisher: values.publisher, trust: level, note: values.note });
      ctx.out(`added publisher key ${keyId} (${values.publisher}, ${level})`);
      return EXIT_OK;
    } catch (err) {
      ctx.err(`not a valid SPKI public key: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT_FAIL;
    }
  }

  if (sub === "remove") {
    const keyId = args[1];
    if (!keyId) return usageError(ctx.err, MARKETPLACE_USAGE);
    if (!store.remove(keyId)) {
      ctx.err(`no publisher key "${keyId}" in the trust store`);
      return EXIT_FAIL;
    }
    ctx.out(`removed publisher key ${keyId}`);
    return EXIT_OK;
  }

  return usageError(ctx.err, MARKETPLACE_USAGE);
}

// ── nexum mcp ───────────────────────────────────────────────────────────────

const MCP_USAGE = `Usage:
  nexum mcp trust list [--json]
  nexum mcp trust policy [--json]
  nexum mcp trust approve <server> [--fingerprint <hex>]
  nexum mcp trust revoke <server>`;

async function runMcpCommand(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: "boolean" }, fingerprint: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals[0] !== "trust") return usageError(ctx.err, MCP_USAGE);
  const sub = positionals[1];
  const arg = positionals[2];
  const store = new McpApprovalStore(join(ctx.stateDir, "mcp-trust.json"));

  if (sub === "list") {
    const entries = store.list();
    if (values.json) {
      ctx.out(JSON.stringify({ approvals: entries }, null, 2));
      return EXIT_OK;
    }
    ctx.out("=== Nexum MCP Trust Approvals ===");
    if (entries.length === 0) {
      ctx.out("no approved servers (TOFU store is empty)");
      return EXIT_OK;
    }
    for (const line of renderTable(
      ["server", "fingerprint", "approvedAt"],
      entries.map((e) => [e.server, e.fingerprint, e.approvedAt]),
    )) {
      ctx.out(line);
    }
    return EXIT_OK;
  }

  if (sub === "policy") {
    const servers = ctx.mcpServers();
    if (servers.length === 0) {
      ctx.out("no MCP servers configured (add mcpServers to .nexum/config.json)");
      return EXIT_OK;
    }
    const policy = mcpTrustPolicyFromConfig(servers, { approvals: store });
    const rows: Array<Record<string, unknown>> = [];
    for (const server of servers) {
      const fingerprint = mcpServerFingerprint({
        kind: "stdio",
        command: server.command,
        args: server.args,
      });
      const decision = await policy.decideServer(server.name, fingerprint);
      rows.push({
        server: server.name,
        fingerprint,
        level: decision.level,
        allowed: decision.allowed ? "yes" : "no",
        reason: decision.reason,
        toolGates: decision.rule?.tools
          ? `allow=${JSON.stringify(decision.rule.tools.allow ?? [])} deny=${JSON.stringify(decision.rule.tools.deny ?? [])}`
          : "",
        maxRisk: decision.rule?.maxRisk ?? "",
      });
    }
    if (values.json) {
      ctx.out(JSON.stringify({ servers: rows }, null, 2));
      return EXIT_OK;
    }
    ctx.out("=== Nexum MCP Trust Policy (effective) ===");
    for (const line of renderTable(
      ["server", "level", "connect", "maxRisk", "tool gates"],
      rows.map((r) => [
        String(r.server),
        String(r.level),
        String(r.allowed),
        String(r.maxRisk || "—"),
        String(r.toolGates || "—"),
      ]),
    )) {
      ctx.out(line);
    }
    for (const r of rows) ctx.out(`${r.server}: ${r.reason}`);
    return EXIT_OK;
  }

  if (sub === "approve") {
    if (!arg) return usageError(ctx.err, MCP_USAGE);
    const configured = ctx.mcpServers().find((s) => s.name === arg);
    let fingerprint = values.fingerprint;
    if (!fingerprint) {
      if (!configured) {
        ctx.err(`server "${arg}" is not configured — pass --fingerprint <hex> to approve it explicitly`);
        return EXIT_FAIL;
      }
      fingerprint = mcpServerFingerprint({ kind: "stdio", command: configured.command, args: configured.args });
    }
    store.approve(arg, fingerprint);
    ctx.out(`approved MCP server "${arg}" (fingerprint ${fingerprint} pinned)`);
    return EXIT_OK;
  }

  if (sub === "revoke") {
    if (!arg) return usageError(ctx.err, MCP_USAGE);
    if (!store.revoke(arg)) {
      ctx.err(`no approval recorded for server "${arg}"`);
      return EXIT_FAIL;
    }
    ctx.out(`revoked MCP server approval "${arg}"`);
    return EXIT_OK;
  }

  return usageError(ctx.err, MCP_USAGE);
}

// ── nexum credentials ───────────────────────────────────────────────────────

const CREDENTIALS_USAGE = `Usage:
  nexum credentials list [--json] [--keychain] [--vault <address>]
  nexum credentials get <name> [--keychain] [--vault <address>]

Providers: env (NEXUM_*/DEVAGENT_* variables) + file (.nexum/credentials.json) are always
in the chain. --keychain adds the OS keychain; --vault <addr> adds HashiCorp Vault KV v2
(token read from VAULT_TOKEN). Values are always printed redacted.`;

/** Walk the provider chain exactly like CredentialService: first hit wins. */
async function resolveCredential(
  providers: CredentialProvider[],
  name: string,
): Promise<{ value: string; provider: string } | undefined> {
  for (const provider of providers) {
    try {
      const value = await provider.resolve(name);
      if (value !== undefined) return { value, provider: provider.id };
    } catch {
      // provider failed — try next (chain semantics)
    }
  }
  return undefined;
}

async function runCredentialsCommand(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      keychain: { type: "boolean" },
      vault: { type: "string" },
    },
    allowPositionals: true,
  });
  const sub = positionals[0];

  const providers = defaultCredentialProviders(ctx.stateDir);
  if (values.keychain) providers.push(new KeychainCredentialProvider());
  if (values.vault) {
    const token = process.env.VAULT_TOKEN ?? "";
    if (!token) {
      ctx.err("--vault requires VAULT_TOKEN to be set");
      return EXIT_USAGE;
    }
    providers.push(new VaultCredentialProvider(new HttpVaultClient({ baseUrl: values.vault, token })));
  }

  if (sub === "list") {
    const names = new Set<string>();
    for (const provider of providers) {
      if (!provider.list) continue;
      try {
        for (const name of await provider.list()) names.add(name);
      } catch {
        // provider enumeration failed — skip
      }
    }
    const rows: Array<{ name: string; provider: string; preview: string }> = [];
    for (const name of [...names].sort()) {
      const hit = await resolveCredential(providers, name);
      rows.push({
        name,
        provider: hit?.provider ?? "unknown",
        preview: hit ? redact(hit.value) : "(not found)",
      });
    }
    if (values.json) {
      ctx.out(JSON.stringify({ credentials: rows }, null, 2));
      return EXIT_OK;
    }
    ctx.out("=== Nexum Credentials (redacted) ===");
    if (rows.length === 0) {
      ctx.out(
        "no enumerable credentials found (env provider lists NEXUM_*/DEVAGENT_* names; keychain/vault are not enumerable)",
      );
      return EXIT_OK;
    }
    for (const line of renderTable(
      ["name", "provider", "preview"],
      rows.map((r) => [r.name, r.provider, r.preview]),
    )) {
      ctx.out(line);
    }
    return EXIT_OK;
  }

  if (sub === "get") {
    const name = positionals[1];
    if (!name) return usageError(ctx.err, CREDENTIALS_USAGE);
    const hit = await resolveCredential(providers, name);
    if (!hit) {
      ctx.err(`credential "${name}" not resolved by any provider`);
      return EXIT_FAIL;
    }
    if (values.json) {
      ctx.out(JSON.stringify({ name, provider: hit.provider, preview: redact(hit.value) }, null, 2));
      return EXIT_OK;
    }
    ctx.out(`name:     ${name}`);
    ctx.out(`provider: ${hit.provider}`);
    ctx.out(`preview:  ${redact(hit.value)} (raw values are never printed)`);
    return EXIT_OK;
  }

  return usageError(ctx.err, CREDENTIALS_USAGE);
}

// ── nexum capabilities ──────────────────────────────────────────────────────

const CAPABILITIES_USAGE = `Usage:
  nexum capabilities attest --subject <type:id> --grant <cap>… [--granted-by <who>]
                            [--expires-in <30d|12h|45m|90s|ms>] [--conditions <text>] [--json]
  nexum capabilities verify <attestation.json> [--json]     (or: --id <grantId>)
  nexum capabilities revoke (--grant-id <id> | --subject <type:id>)
  nexum capabilities list [--json]`;

/**
 * Workspace authority: loads (or creates) `.nexum/attestation-authority.pem`
 * and replays revocations recorded in the ledger so a fresh process still
 * honors them.
 */
function loadWorkspaceAuthority(ctx: Ctx): { authority: AttestationAuthority; ledger: AttestationLedger } {
  const ledger = new AttestationLedger(join(ctx.stateDir, "attestation-ledger.json"));
  const grantIds: string[] = [];
  const subjects: string[] = [];
  for (const entry of ledger.list()) {
    if (entry.kind === "revocation") {
      if (entry.grantId) grantIds.push(entry.grantId);
      if (entry.subject) subjects.push(entry.subject);
    }
  }
  const authority = loadOrCreateAuthority(join(ctx.stateDir, "attestation-authority.pem"), {
    ledger,
    revocations: { grantIds, subjects },
    now: ctx.now,
  });
  return { authority, ledger };
}

async function runCapabilitiesCommand(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      subject: { type: "string" },
      grant: { type: "string", multiple: true },
      "granted-by": { type: "string" },
      "expires-in": { type: "string" },
      conditions: { type: "string" },
      id: { type: "string" },
      "grant-id": { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const sub = positionals[0];
  const { authority, ledger } = loadWorkspaceAuthority(ctx);

  if (sub === "attest") {
    if (!values.subject || !values.grant || values.grant.length === 0) {
      return usageError(ctx.err, CAPABILITIES_USAGE);
    }
    let subject;
    try {
      subject = parseSubject(values.subject);
    } catch (err) {
      ctx.err(err instanceof Error ? err.message : String(err));
      return EXIT_USAGE;
    }
    let expiresAt: string | undefined;
    if (values["expires-in"]) {
      try {
        expiresAt = new Date(ctx.now().getTime() + parseDuration(values["expires-in"])).toISOString();
      } catch (err) {
        ctx.err(err instanceof Error ? err.message : String(err));
        return EXIT_USAGE;
      }
    }
    const attestation = authority.attest({
      subject,
      grants: values.grant,
      grantedBy: values["granted-by"] ?? "nexum-cli",
      expiresAt,
      conditions: values.conditions,
    });
    if (values.json) {
      ctx.out(JSON.stringify(attestation, null, 2));
    } else {
      ctx.out("=== Nexum Capability Attestation ===");
      ctx.out(`grant:    ${attestation.grant.id}`);
      ctx.out(`subject:  ${attestation.grant.subject.type}:${attestation.grant.subject.id}`);
      ctx.out(`grants:   ${attestation.grant.grants.join(", ")}`);
      ctx.out(`authority: ${attestation.keyId}`);
      ctx.out(`signedAt: ${attestation.signedAt}`);
      if (attestation.grant.expiresAt) ctx.out(`expires:  ${attestation.grant.expiresAt}`);
      ctx.out(`ledger:   ${join(ctx.stateDir, "attestation-ledger.json")}`);
    }
    return EXIT_OK;
  }

  if (sub === "verify") {
    let attestation: CapabilityAttestation | undefined;
    const file = positionals[1];
    if (values.id) {
      const matches = ledger
        .list()
        .filter((e) => e.kind === "attestation" && e.attestation.grant.id === values.id)
        .map((e) => (e.kind === "attestation" ? e.attestation : undefined));
      attestation = matches[matches.length - 1];
      if (!attestation) {
        ctx.err(`no attestation for grant "${values.id}" in the ledger`);
        return EXIT_FAIL;
      }
    } else if (file) {
      const path = isAbsolute(file) ? file : resolve(ctx.cwd, file);
      if (!existsSync(path)) {
        ctx.err(`attestation file not found: ${path}`);
        return EXIT_FAIL;
      }
      try {
        attestation = JSON.parse(readFileSync(path, "utf8")) as CapabilityAttestation;
      } catch (err) {
        ctx.err(`invalid attestation JSON: ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_FAIL;
      }
    } else {
      return usageError(ctx.err, CAPABILITIES_USAGE);
    }
    const verdict = authority.verify(attestation);
    if (values.json) {
      ctx.out(JSON.stringify({ valid: verdict.valid, reason: verdict.reason, grant: attestation.grant }, null, 2));
    } else {
      ctx.out("=== Nexum Attestation Verification ===");
      ctx.out(`grant:   ${attestation.grant.id}`);
      ctx.out(`subject: ${attestation.grant.subject.type}:${attestation.grant.subject.id}`);
      ctx.out(`valid:   ${verdict.valid ? "yes" : "NO"}${verdict.reason ? ` — ${verdict.reason}` : ""}`);
    }
    return verdict.valid ? EXIT_OK : EXIT_FAIL;
  }

  if (sub === "revoke") {
    if (!values["grant-id"] && !values.subject) return usageError(ctx.err, CAPABILITIES_USAGE);
    if (values["grant-id"] && values.subject) {
      ctx.err("use either --grant-id or --subject, not both");
      return EXIT_USAGE;
    }
    let subject: string | undefined;
    if (values.subject) {
      try {
        subject = parseSubject(values.subject).id;
      } catch (err) {
        ctx.err(err instanceof Error ? err.message : String(err));
        return EXIT_USAGE;
      }
    }
    authority.revoke({ grantId: values["grant-id"], subject });
    const what = values["grant-id"] ? `grant "${values["grant-id"]}"` : `all grants of subject "${subject}"`;
    ctx.out(`revoked ${what} (recorded in ledger — irreversible)`);
    return EXIT_OK;
  }

  if (sub === "list") {
    const entries = ledger.list();
    if (values.json) {
      ctx.out(JSON.stringify({ entries }, null, 2));
      return EXIT_OK;
    }
    ctx.out("=== Nexum Attestation Ledger ===");
    if (entries.length === 0) {
      ctx.out("ledger is empty (attest a grant with: nexum capabilities attest)");
      return EXIT_OK;
    }
    for (const entry of entries) {
      if (entry.kind === "attestation") {
        const g = entry.attestation.grant;
        ctx.out(
          `[${entry.at}] attestation ${g.id} ${g.subject.type}:${g.subject.id} ` +
            `caps=[${g.grants.join(",")}] key=${entry.attestation.keyId}`,
        );
      } else {
        const target = entry.grantId ? `grant=${entry.grantId}` : "";
        const subj = entry.subject ? ` subject=${entry.subject}` : "";
        ctx.out(`[${entry.at}] revocation ${target}${subj}`);
      }
    }
    return EXIT_OK;
  }

  return usageError(ctx.err, CAPABILITIES_USAGE);
}
