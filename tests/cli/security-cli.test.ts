/**
 * CLI surface for the trust & security layer (src/cli/security.ts).
 *
 * All tests run against throwaway workspaces — no real .nexum state, no
 * network, no OS keychain. MCP servers come from an injected config, plugin
 * files are temp .mjs modules, marketplace installs use a fake source.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecurityCli, parseDuration, parseSubject } from "../../src/cli/security.js";
import type { McpCliServerConfig } from "../../src/cli/config.js";
import { MarketplaceService, type MarketplaceEntry, type MarketplaceSource } from "../../src/marketplace/index.js";
import { generatePublisherKeyPair, signEntry, PublisherTrustStore } from "../../src/marketplace/trust.js";
import { mcpServerFingerprint } from "../../src/mcp/trust.js";

let dir: string;
let root: string;
let out: string[];
let errLines: string[];
let servers: McpCliServerConfig[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexum-security-cli-"));
  root = join(dir, "ws");
  mkdirSync(root, { recursive: true });
  out = [];
  errLines = [];
  servers = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCli(area: string, ...argv: string[]): Promise<number> {
  return runSecurityCli(area, argv, {
    stdout: (l) => out.push(l ?? ""),
    stderr: (l) => errLines.push(l ?? ""),
    cwd: dir,
    workspaceRoot: root,
    mcpServers: () => servers,
  });
}

function writePlugin(name: string, body: string): string {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return file;
}

// ── helpers (unit) ──────────────────────────────────────────────────────────

describe("security CLI helpers", () => {
  it("parseDuration converts s/m/h/d and raw ms", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("45m")).toBe(2_700_000);
    expect(parseDuration("12h")).toBe(43_200_000);
    expect(parseDuration("30d")).toBe(2_592_000_000);
    expect(parseDuration("1500")).toBe(1500);
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
  });

  it("parseSubject accepts known types and rejects garbage", () => {
    expect(parseSubject("plugin:my-plugin")).toEqual({ type: "plugin", id: "my-plugin" });
    expect(parseSubject("mcp-server:github")).toEqual({ type: "mcp-server", id: "github" });
    expect(() => parseSubject("alien:thing")).toThrow(/invalid subject type/);
    expect(() => parseSubject("nocolon")).toThrow(/invalid subject/);
  });

  it("unknown area exits 2 with usage", async () => {
    expect(await runCli("bogus", "x")).toBe(2);
    expect(errLines.some((l) => l.includes("Unknown command area"))).toBe(true);
  });
});

// ── nexum plugins sandbox ───────────────────────────────────────────────────

describe("security CLI — plugins sandbox", () => {
  it("runs a clean plugin and passes", async () => {
    const file = writePlugin(
      "simple",
      `export default { manifest: { id: "simple", name: "Simple", version: "1.2.3" } };`,
    );
    const code = await runCli("plugins", "sandbox", file);
    expect(code).toBe(0);
    expect(out.some((l) => l.startsWith("plugin: simple@1.2.3"))).toBe(true);
    expect(out.some((l) => l === "result: PASS (clean lifecycle)")).toBe(true);
    expect(out.some((l) => l.startsWith("audit: 0 operations"))).toBe(true);
  });

  it("records a policy denial and fails even when the plugin swallows it", async () => {
    const file = writePlugin(
      "sneaky",
      `export default {
        manifest: { id: "sneaky", name: "Sneaky", version: "0.1.0" },
        async setup(ctx) { try { await ctx.lookup("secret-token"); } catch { /* swallowed */ } },
      };`,
    );
    const code = await runCli("plugins", "sandbox", file);
    expect(code).toBe(1);
    expect(out.some((l) => l.includes("lookup secret-token → DENIED"))).toBe(true);
    expect(out.some((l) => l.includes("policy violations were recorded"))).toBe(true);
  });

  it("contains a crashing worker: unhandled rejection kills only the sandbox", async () => {
    const file = writePlugin(
      "crashy",
      `export default {
        manifest: { id: "crashy", name: "Crashy", version: "0.2.0" },
        setup(ctx) { ctx.lookup("secret-token"); /* rejection deliberately not awaited */ },
      };`,
    );
    const code = await runCli("plugins", "sandbox", file);
    expect(code).toBe(1);
    expect(out.some((l) => l.startsWith("setup: ok"))).toBe(true);
    expect(out.some((l) => l.includes("result: FAIL (lifecycle failed)"))).toBe(true);
    // the host process survived — the CLI ran to completion
    expect(out.some((l) => l.startsWith("audit:"))).toBe(true);
  });

  it("allows lookups matching --allow-lookup patterns", async () => {
    const file = writePlugin(
      "lookupy",
      `export default {
        manifest: { id: "lookupy", name: "Lookupy", version: "0.2.0" },
        async setup(ctx) { await ctx.lookup("cache:tokens"); },
      };`,
    );
    const code = await runCli("plugins", "sandbox", file, "--allow-lookup", "cache:*");
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("lookup cache:tokens → ALLOWED"))).toBe(true);
    expect(out.some((l) => l === "result: PASS (clean lifecycle)")).toBe(true);
  });

  it("reports a failing setup phase", async () => {
    const file = writePlugin(
      "boom",
      `export default {
        manifest: { id: "boom", name: "Boom", version: "0.0.1" },
        setup() { throw new Error("kaboom"); },
      };`,
    );
    const code = await runCli("plugins", "sandbox", file);
    expect(code).toBe(1);
    expect(out.some((l) => l.startsWith("setup: FAILED") && l.includes("kaboom"))).toBe(true);
  });

  it("emits machine-readable JSON with --json", async () => {
    const file = writePlugin("jsony", `export default { manifest: { id: "jsony", name: "Jsony", version: "3.1.4" } };`);
    const code = await runCli("plugins", "sandbox", file, "--json");
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as {
      plugin: { id: string; version: string };
      phases: { phase: string; ok: boolean }[];
      audit: unknown[];
      pass: boolean;
    };
    expect(parsed.plugin.id).toBe("jsony");
    expect(parsed.phases.map((p) => p.phase)).toEqual(["setup", "start", "stop"]);
    expect(parsed.pass).toBe(true);
  });

  it("exits 2 on usage errors and 1 on missing files", async () => {
    expect(await runCli("plugins")).toBe(2);
    expect(await runCli("plugins", "sandbox")).toBe(2);
    expect(await runCli("plugins", "sandbox", join(dir, "nope.mjs"))).toBe(1);
  });
});

// ── nexum plugins verify ────────────────────────────────────────────────────

class FakeSource implements MarketplaceSource {
  readonly id = "fake";

  async fetchCatalog(): Promise<MarketplaceEntry[]> {
    return [];
  }

  async fetchEntry(id: string): Promise<MarketplaceEntry | undefined> {
    return { id, name: id, version: "1.0.0", source: this.id };
  }

  async download(entry: MarketplaceEntry, destPath: string): Promise<void> {
    writeFileSync(destPath, `artifact-bytes:${entry.id}:${entry.version}`);
  }
}

async function installSigned(stateDir: string): Promise<void> {
  const source = new FakeSource();
  const keys = generatePublisherKeyPair();
  const store = PublisherTrustStore.inMemory([
    { keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "alice", trust: "verified" },
  ]);
  const service = new MarketplaceService({
    rootDir: stateDir,
    sources: [source],
    installPolicy: { trustStore: store },
  });
  // The signature covers SIGNED_FIELDS (incl. sha256) — build the complete
  // entry first, then sign it.
  const full: MarketplaceEntry = {
    id: "cool-tools",
    name: "Cool Tools",
    version: "1.4.2",
    source: "fake",
    author: "alice",
    sha256: createHash("sha256").update("artifact-bytes:cool-tools:1.4.2").digest("hex"),
  };
  await service.install({ ...full, signature: signEntry(full, keys.privateKeyPem), publisher: "alice" });
}

describe("security CLI — plugins verify", () => {
  it("reports an empty install set as ok", async () => {
    expect(await runCli("plugins", "verify")).toBe(0);
    expect(out.some((l) => l === "no plugins installed")).toBe(true);
  });

  it("verifies a signed installed plugin", async () => {
    await installSigned(join(root, ".nexum"));
    const code = await runCli("plugins", "verify");
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("cool-tools@1.4.2") && l.includes("valid"))).toBe(true);
    expect(out.some((l) => l === "all installed plugins verified")).toBe(true);
  });

  it("detects a tampered artifact", async () => {
    await installSigned(join(root, ".nexum"));
    const index = JSON.parse(readFileSync(join(root, ".nexum", "plugins", "installed.json"), "utf8")) as {
      path: string;
    }[];
    writeFileSync(join(index[0].path, "plugin.tar.gz"), "tampered-bytes");
    const code = await runCli("plugins", "verify");
    expect(code).toBe(1);
    expect(out.some((l) => l.includes("FAIL"))).toBe(true);
  });

  it("fails for a plugin that is not installed", async () => {
    const code = await runCli("plugins", "verify", "ghost");
    expect(code).toBe(1);
    expect(errLines.some((l) => l.includes('"ghost" is not installed'))).toBe(true);
  });

  it("supports --json output", async () => {
    await installSigned(join(root, ".nexum"));
    const code = await runCli("plugins", "verify", "--json");
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { ok: boolean; rows: { plugin: string; signature: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.rows[0].plugin).toBe("cool-tools@1.4.2");
    expect(parsed.rows[0].signature).toBe("valid");
  });
});

// ── nexum marketplace keys ──────────────────────────────────────────────────

describe("security CLI — marketplace keys", () => {
  it("lists an empty store", async () => {
    expect(await runCli("marketplace", "keys", "list")).toBe(0);
    expect(out.some((l) => l === "no publisher keys registered")).toBe(true);
  });

  it("adds a PEM public key and lists it", async () => {
    const keys = generatePublisherKeyPair();
    const pemFile = join(dir, "publisher.pem");
    // generatePublisherKeyPair exposes base64 DER; wrap as PEM for the CLI path.
    writeFileSync(
      pemFile,
      `-----BEGIN PUBLIC KEY-----\n${keys.publicKeyBase64.replace(/(.{64})/g, "$1\n")}\n-----END PUBLIC KEY-----\n`,
    );
    const code = await runCli("marketplace", "keys", "add", pemFile, "--publisher", "alice", "--level", "verified");
    expect(code).toBe(0);
    expect(out.some((l) => l.includes(keys.keyId))).toBe(true);

    expect(await runCli("marketplace", "keys", "list")).toBe(0);
    expect(out.some((l) => l.includes(keys.keyId) && l.includes("alice") && l.includes("verified"))).toBe(true);
    // persisted in the workspace state dir
    const store = JSON.parse(readFileSync(join(root, ".nexum", "publisher-trust.json"), "utf8")) as unknown[];
    expect(store).toHaveLength(1);
  });

  it("rejects an invalid key file", async () => {
    const bad = join(dir, "bad.pem");
    writeFileSync(bad, "not a key at all");
    expect(await runCli("marketplace", "keys", "add", bad, "--publisher", "x")).toBe(1);
    expect(errLines.some((l) => l.includes("not a valid SPKI public key"))).toBe(true);
  });

  it("removes a registered key and complains about unknown ones", async () => {
    const keys = generatePublisherKeyPair();
    const store = PublisherTrustStore.open(join(root, ".nexum", "publisher-trust.json"));
    store.add({ keyId: keys.keyId, publicKey: keys.publicKeyBase64, publisher: "bob", trust: "community" });
    expect(await runCli("marketplace", "keys", "remove", keys.keyId)).toBe(0);
    expect(await runCli("marketplace", "keys", "remove", keys.keyId)).toBe(1);
  });
});

// ── nexum mcp trust ─────────────────────────────────────────────────────────

describe("security CLI — mcp trust", () => {
  beforeEach(() => {
    servers = [
      { name: "plain-server", command: "npx", args: ["plain"] },
      { name: "ask-server", command: "npx", args: ["askme"], trust: "ask" },
      { name: "deny-server", command: "npx", args: ["deny"], trust: "untrusted" },
    ];
  });

  it("lists an empty approval store", async () => {
    expect(await runCli("mcp", "trust", "list")).toBe(0);
    expect(out.some((l) => l.includes("no approved servers"))).toBe(true);
  });

  it("approves a configured server with its pinned fingerprint", async () => {
    expect(await runCli("mcp", "trust", "approve", "ask-server")).toBe(0);
    const expected = mcpServerFingerprint({ kind: "stdio", command: "npx", args: ["askme"] });
    expect(out.some((l) => l.includes(`fingerprint ${expected} pinned`))).toBe(true);

    expect(await runCli("mcp", "trust", "list")).toBe(0);
    expect(out.some((l) => l.includes("ask-server") && l.includes(expected))).toBe(true);
  });

  it("refuses to approve an unconfigured server without --fingerprint", async () => {
    expect(await runCli("mcp", "trust", "approve", "stranger")).toBe(1);
    expect(errLines.some((l) => l.includes("not configured"))).toBe(true);
    // explicit fingerprint escape hatch works
    expect(await runCli("mcp", "trust", "approve", "stranger", "--fingerprint", "abc123")).toBe(0);
  });

  it("revokes approvals", async () => {
    await runCli("mcp", "trust", "approve", "ask-server");
    expect(await runCli("mcp", "trust", "revoke", "ask-server")).toBe(0);
    expect(await runCli("mcp", "trust", "revoke", "ask-server")).toBe(1);
  });

  it("previews the effective policy: trusted default, ask gate, deny", async () => {
    expect(await runCli("mcp", "trust", "policy")).toBe(0);
    const plain = out.find((l) => l.startsWith("plain-server"));
    const ask = out.find((l) => l.startsWith("ask-server"));
    const deny = out.find((l) => l.startsWith("deny-server"));
    expect(plain).toContain("trusted");
    expect(plain).toContain("yes");
    expect(ask).toContain("ask");
    expect(ask).toContain("no");
    expect(deny).toContain("untrusted");
    expect(deny).toContain("no");
  });

  it("policy honors recorded TOFU approvals", async () => {
    await runCli("mcp", "trust", "approve", "ask-server");
    expect(await runCli("mcp", "trust", "policy")).toBe(0);
    const ask = out.find((l) => l.startsWith("ask-server"));
    expect(ask).toContain("yes");
    expect(out.some((l) => l.includes("approved earlier"))).toBe(true);
  });
});

// ── nexum credentials ───────────────────────────────────────────────────────

describe("security CLI — credentials", () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_NAMES = ["NEXUM_TEST_SECRET"];

  beforeEach(() => {
    for (const name of ENV_NAMES) saved[name] = process.env[name];
    process.env.NEXUM_TEST_SECRET = "super-secret-value-123";
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("resolves a credential and prints a redacted preview", async () => {
    expect(await runCli("credentials", "get", "TEST_SECRET")).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("provider: env");
    expect(joined).toContain("supe***-123");
    expect(joined).not.toContain("super-secret-value-123");
  });

  it("fails for unresolvable credentials", async () => {
    expect(await runCli("credentials", "get", "MISSING_SECRET")).toBe(1);
    expect(errLines.some((l) => l.includes("not resolved by any provider"))).toBe(true);
  });

  it("lists enumerable credentials with previews", async () => {
    expect(await runCli("credentials", "list")).toBe(0);
    const row = out.find((l) => l.includes("TEST_SECRET"));
    expect(row).toContain("env");
    expect(row).not.toContain("super-secret-value-123");
  });

  it("requires VAULT_TOKEN with --vault", async () => {
    const hadToken = process.env.VAULT_TOKEN;
    delete process.env.VAULT_TOKEN;
    try {
      expect(await runCli("credentials", "get", "x", "--vault", "http://127.0.0.1:8200")).toBe(2);
      expect(errLines.some((l) => l.includes("VAULT_TOKEN"))).toBe(true);
    } finally {
      if (hadToken !== undefined) process.env.VAULT_TOKEN = hadToken;
    }
  });
});

// ── nexum capabilities ──────────────────────────────────────────────────────

describe("security CLI — capabilities", () => {
  it("attests a grant, records it in the ledger, and round-trips verification", async () => {
    expect(
      await runCli(
        "capabilities",
        "attest",
        "--subject",
        "plugin:my-plugin",
        "--grant",
        "tools",
        "--grant",
        "memory",
        "--expires-in",
        "30d",
        "--json",
      ),
    ).toBe(0);
    const attestation = JSON.parse(out.join("\n")) as { grant: { id: string; subject: { type: string; id: string } } };
    expect(attestation.grant.subject).toEqual({ type: "plugin", id: "my-plugin" });

    // authority key + ledger persisted in the workspace state dir
    expect(() => readFileSync(join(root, ".nexum", "attestation-authority.pem"))).not.toThrow();
    const ledger = JSON.parse(readFileSync(join(root, ".nexum", "attestation-ledger.json"), "utf8")) as unknown[];
    expect(ledger).toHaveLength(1);

    // verify from a file
    const file = join(dir, "attestation.json");
    writeFileSync(file, JSON.stringify(attestation));
    expect(await runCli("capabilities", "verify", file)).toBe(0);
    expect(out.some((l) => l.includes("valid:   yes"))).toBe(true);

    // verify by grant id from the ledger
    expect(await runCli("capabilities", "verify", "--id", attestation.grant.id)).toBe(0);
  });

  it("revocations survive a fresh process (ledger replay)", async () => {
    await runCli("capabilities", "attest", "--subject", "plugin:doomed", "--grant", "tools", "--json");
    const attestation = JSON.parse(out.join("\n")) as { grant: { id: string } };

    expect(await runCli("capabilities", "revoke", "--grant-id", attestation.grant.id)).toBe(0);

    // fresh CLI invocation = fresh authority; revocation must still hold
    const file = join(dir, "attestation.json");
    writeFileSync(file, JSON.stringify(attestation));
    expect(await runCli("capabilities", "verify", file)).toBe(1);
    expect(out.some((l) => l.includes("revoked"))).toBe(true);
  });

  it("verify fails cleanly for unknown grant ids and bad files", async () => {
    expect(await runCli("capabilities", "verify", "--id", "nope")).toBe(1);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(await runCli("capabilities", "verify", bad)).toBe(1);
  });

  it("lists ledger entries including revocations", async () => {
    await runCli("capabilities", "attest", "--subject", "agent:helper", "--grant", "memory", "--json");
    await runCli("capabilities", "revoke", "--subject", "agent:helper");
    expect(await runCli("capabilities", "list")).toBe(0);
    expect(out.some((l) => l.includes("attestation") && l.includes("agent:helper"))).toBe(true);
    expect(out.some((l) => l.includes("revocation") && l.includes("subject=helper"))).toBe(true);
  });

  it("validates usage (bad subject, missing grants, conflicting revoke args)", async () => {
    expect(await runCli("capabilities", "attest", "--subject", "weird:x", "--grant", "tools")).toBe(2);
    expect(await runCli("capabilities", "attest", "--subject", "plugin:x")).toBe(2);
    expect(await runCli("capabilities", "revoke", "--grant-id", "a", "--subject", "plugin:b")).toBe(2);
  });
});
