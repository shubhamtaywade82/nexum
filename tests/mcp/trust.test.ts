/**
 * Tests for the MCP trust policy (P2 trust tier): server trust levels,
 * TOFU approvals with fingerprint pinning, tool allow/deny patterns,
 * risk ceilings, and config→policy construction.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpTrustPolicy,
  McpApprovalStore,
  mcpTrustPolicyFromConfig,
  mcpServerFingerprint,
  matchesPattern,
  riskAtLeast,
} from "../../src/mcp/trust.js";
import type { McpTransportDescriptor } from "../../src/mcp/adapter/mcp-client-factory.js";

const STDIO: McpTransportDescriptor = { kind: "stdio", command: "npx", args: ["-y", "server-sqlite"] };

describe("matchesPattern", () => {
  it("matches * and ? wildcards and escapes specials", () => {
    expect(matchesPattern("drop_table", "drop_*")).toBe(true);
    expect(matchesPattern("query_rows", "drop_*")).toBe(false);
    expect(matchesPattern("read_file", "read_????")).toBe(true);
    expect(matchesPattern("read_file", "read_???")).toBe(false);
    expect(matchesPattern("a.b", "a.b")).toBe(true); // pattern dot is literal…
    expect(matchesPattern("axb", "a.b")).toBe(false); // …not a single-char wildcard
    expect(matchesPattern("a.b", "a*b")).toBe(true); // but * spans dots
    expect(matchesPattern("everything", "*")).toBe(true);
  });
});

describe("riskAtLeast", () => {
  it("orders the risk ladder", () => {
    expect(riskAtLeast("high", "medium")).toBe(true);
    expect(riskAtLeast("medium", "medium")).toBe(true);
    expect(riskAtLeast("read", "critical")).toBe(false);
  });
});

describe("mcpServerFingerprint", () => {
  it("is stable per command+args and changes when args change", () => {
    const a = mcpServerFingerprint(STDIO);
    const b = mcpServerFingerprint({ kind: "stdio", command: "npx", args: ["-y", "server-sqlite"] });
    const c = mcpServerFingerprint({ kind: "stdio", command: "npx", args: ["-y", "server-github"] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keys http servers by url", () => {
    expect(mcpServerFingerprint({ kind: "http", url: "https://mcp.example.com/sse" })).toBe(
      mcpServerFingerprint({ kind: "http", url: "https://mcp.example.com/sse" }),
    );
  });
});

describe("McpApprovalStore (TOFU)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexum-trust-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists approvals and matches only the pinned fingerprint", () => {
    const file = join(dir, "mcp-trust.json");
    const store = new McpApprovalStore(file);
    const fp = mcpServerFingerprint(STDIO);
    expect(store.isApproved("sqlite", fp)).toBe(false);
    store.approve("sqlite", fp);
    expect(store.isApproved("sqlite", fp)).toBe(true);
    // same server, different fingerprint (e.g. args changed) → NOT approved
    expect(store.isApproved("sqlite", "deadbeefdeadbeef")).toBe(false);
    expect(store.approvedServers()).toEqual(["sqlite"]);

    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(persisted.sqlite.fingerprint).toBe(fp);
  });

  it("survives restart and revocation works", () => {
    const file = join(dir, "mcp-trust.json");
    const fp = mcpServerFingerprint(STDIO);
    new McpApprovalStore(file).approve("sqlite", fp);
    // fresh instance reads the same file (TOFU across sessions)
    const reopened = new McpApprovalStore(file);
    expect(reopened.isApproved("sqlite", fp)).toBe(true);
    expect(reopened.revoke("sqlite")).toBe(true);
    expect(reopened.isApproved("sqlite", fp)).toBe(false);
    expect(reopened.revoke("sqlite")).toBe(false);
  });

  it("tolerates corrupt files without throwing", () => {
    const file = join(dir, "mcp-trust.json");
    writeFileSync(file, "{not json");
    const store = new McpApprovalStore(file);
    expect(store.isApproved("x", "y")).toBe(false);
    store.approve("x", "y"); // must not throw despite the corrupt prior content
    expect(existsSync(file)).toBe(true);
  });
});

describe("McpTrustPolicy — server decisions", () => {
  const fp = "aa11bb22cc33dd44";

  it("trusts everything when empty (backward compatible)", async () => {
    const policy = new McpTrustPolicy();
    const d = await policy.decideServer("anything", fp);
    expect(d.allowed).toBe(true);
    expect(d.source.kind).toBe("default");
  });

  it("honors per-server trust levels with pattern rules", async () => {
    const policy = new McpTrustPolicy({
      rules: [
        { match: "sqlite", trust: "trusted" },
        { match: "marketplace-*", trust: "untrusted" },
      ],
    });
    expect((await policy.decideServer("sqlite", fp)).allowed).toBe(true);
    const denied = await policy.decideServer("marketplace-evil", fp);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("untrusted by policy");
  });

  it("denies unapproved ask servers; TOFU approval unlocks them", async () => {
    const policy = new McpTrustPolicy({ rules: [{ match: "github", trust: "ask" }] });
    const denied = await policy.decideServer("github", fp);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("requires approval");

    const store = new McpApprovalStore(join(mkdtempSync(join(tmpdir(), "nexum-trust-")), "t.json"));
    store.approve("github", fp);
    const approved = await new McpTrustPolicy({
      rules: [{ match: "github", trust: "ask" }],
      approvals: store,
    }).decideServer("github", fp);
    expect(approved.allowed).toBe(true);
    expect(approved.source.kind).toBe("tofu");
  });

  it("re-prompts after a fingerprint change (approval is pinned)", async () => {
    const store = new McpApprovalStore(join(mkdtempSync(join(tmpdir(), "nexum-trust-")), "t.json"));
    store.approve("github", fp);
    const policy = new McpTrustPolicy({ rules: [{ match: "github", trust: "ask" }], approvals: store });
    expect((await policy.decideServer("github", fp)).allowed).toBe(true);
    // server binary/args changed → fingerprint differs → approval no longer applies
    expect((await policy.decideServer("github", "ff00ff00ff00ff00")).allowed).toBe(false);
  });

  it("consults the interactive approver and records the approval (TOFU)", async () => {
    const store = new McpApprovalStore(join(mkdtempSync(join(tmpdir(), "nexum-trust-")), "t.json"));
    const asked: Array<[string, string]> = [];
    const policy = new McpTrustPolicy({
      rules: [{ match: "github", trust: "ask" }],
      approvals: store,
      approver: (server, fingerprint) => {
        asked.push([server, fingerprint]);
        return true;
      },
    });
    const d = await policy.decideServer("github", fp);
    expect(d.allowed).toBe(true);
    expect(d.source.kind).toBe("approver");
    expect(asked).toEqual([["github", fp]]);
    // second decision must not re-ask (recorded in the store)
    const again = await policy.decideServer("github", fp);
    expect(again.allowed).toBe(true);
    expect(again.source.kind).toBe("tofu");
    expect(asked).toHaveLength(1);
  });

  it("an approver denial is final", async () => {
    const policy = new McpTrustPolicy({
      rules: [{ match: "github", trust: "ask" }],
      approver: () => false,
    });
    const d = await policy.decideServer("github", fp);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("denied");
  });

  it("defaultTrust tightens unknown servers without rules", async () => {
    const policy = new McpTrustPolicy({ defaultTrust: "untrusted" });
    expect((await policy.decideServer("unknown", fp)).allowed).toBe(false);
  });
});

describe("McpTrustPolicy — tool decisions", () => {
  it("deny patterns win over allow", () => {
    const policy = new McpTrustPolicy({
      rules: [{ match: "sqlite", tools: { allow: ["*"], deny: ["drop_*", "exec_*"] } }],
    });
    expect(policy.decideTool("sqlite", "query_rows", "low").allowed).toBe(true);
    expect(policy.decideTool("sqlite", "drop_table", "medium").allowed).toBe(false);
    expect(policy.decideTool("sqlite", "exec_shell", "medium").allowed).toBe(false);
  });

  it("an allow list alone is a whitelist", () => {
    const policy = new McpTrustPolicy({ rules: [{ match: "fs", tools: { allow: ["read_*", "list_*"] } }] });
    expect(policy.decideTool("fs", "read_file", "read").allowed).toBe(true);
    expect(policy.decideTool("fs", "write_file", "medium").allowed).toBe(false);
  });

  it("a deny list alone blacklists; everything else flows", () => {
    const policy = new McpTrustPolicy({ rules: [{ match: "fs", tools: { deny: ["write_*"] } }] });
    expect(policy.decideTool("fs", "read_file", "read").allowed).toBe(true);
    expect(policy.decideTool("fs", "write_file", "medium").allowed).toBe(false);
  });

  it("risk ceiling denies tools strictly above the ceiling", () => {
    const policy = new McpTrustPolicy({ rules: [{ match: "web", maxRisk: "medium" }] });
    expect(policy.decideTool("web", "fetch_url", "medium").allowed).toBe(true); // at the ceiling: allowed
    expect(policy.decideTool("web", "fetch_url", "low").allowed).toBe(true);
    expect(policy.decideTool("web", "delete_everything", "high").allowed).toBe(false);
    expect(policy.decideTool("web", "nuke", "critical").allowed).toBe(false);
  });

  it("exposes rule security overrides for allowed tools", () => {
    const policy = new McpTrustPolicy({
      rules: [{ match: "github", security: { risk: "high", confirmation: "required" } }],
    });
    const d = policy.decideTool("github", "create_issue", "medium");
    expect(d.allowed).toBe(true);
    expect(d.security).toEqual({ risk: "high", confirmation: "required" });
  });

  it("rules apply only to their matched servers", () => {
    const policy = new McpTrustPolicy({ rules: [{ match: "github", tools: { deny: ["*"] } }] });
    expect(policy.decideTool("other", "anything", "medium").allowed).toBe(true);
  });
});

describe("mcpTrustPolicyFromConfig", () => {
  it("builds rules only from gated entries; plain entries stay trusted", async () => {
    const policy = mcpTrustPolicyFromConfig([
      { name: "sqlite", command: "npx" }, // no gates → no rule
      { name: "risky", command: "npx", trust: "ask" },
      { name: "fs", command: "npx", tools: { deny: ["write_*"] } },
      { name: "web", command: "npx", maxRisk: "low" },
    ]);
    // plain entry: trusted via default
    const plain = await policy.decideServer("sqlite", "x");
    expect(plain.allowed).toBe(true);
    expect(plain.source.kind).toBe("default");
    // gated entries got rules
    expect((await policy.decideServer("risky", "x")).allowed).toBe(false); // ask + no approvals
    expect(policy.decideTool("fs", "write_file", "medium").allowed).toBe(false);
    expect(policy.decideTool("web", "fetch", "high").allowed).toBe(false);
  });

  it("carries the approval store through for ask servers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexum-trust-"));
    const store = new McpApprovalStore(join(dir, "t.json"));
    store.approve("risky", "x");
    const policy = mcpTrustPolicyFromConfig([{ name: "risky", command: "npx", trust: "ask" }], { approvals: store });
    expect((await policy.decideServer("risky", "x")).allowed).toBe(true);
  });
});
