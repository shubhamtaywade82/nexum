/**
 * Permanent quality gate for Nexum's authorization boundary.
 *
 * Invariant: no agent, execution strategy, MCP server, unattended workflow or UI entry point can bypass the
 * gateway's policy engine, its budget ceilings or its execution isolation. These checks read the source and
 * fail when a construction, flag or fallback that would reopen the boundary appears again.
 *
 * Each check names the rule it protects, so a failure says what to restore, not only where.
 */
import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(process.cwd());
const SRC = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((path) => ({
  path,
  rel: relative(ROOT, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

/** The source text of one gateway construction: from `new DefaultToolGateway({` to its matching `})`. */
function constructionsIn(text: string): string[] {
  const out: string[] = [];
  const opener = "new DefaultToolGateway({";
  let from = text.indexOf(opener);
  while (from !== -1) {
    let depth = 0;
    let i = from + opener.length - 1; // at the "{"
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(from, i + 1));
    from = text.indexOf(opener, i);
  }
  return out;
}

/** Lines of `text` that match `pattern`, as "file:line" strings. */
function hits(pattern: RegExp, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const file of FILES) {
    if (skip(file.rel)) continue;
    file.text.split("\n").forEach((line, idx) => {
      if (pattern.test(line)) out.push(`${file.rel}:${idx + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe("authorization boundary invariants", () => {
  it("every production gateway is constructed with an explicit policy engine", () => {
    const missing: string[] = [];
    let constructions = 0;
    for (const file of FILES) {
      for (const construction of constructionsIn(file.text)) {
        constructions++;
        if (!/\bpolicyEngine\s*:/.test(construction)) missing.push(`${file.rel}: ${construction.split("\n")[0]}`);
      }
    }
    // Rule: a gateway without an engine cannot run anything (fail closed). Adding a gateway is fine; omitting its
    // engine is not.
    expect(constructions).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("no production gateway runs unattended calls under an unattended-unaware engine", () => {
    const unwrapped: string[] = [];
    for (const file of FILES) {
      for (const construction of constructionsIn(file.text)) {
        const engine = construction.match(/policyEngine\s*:\s*([^,\n]+(?:\([^)]*\))?)/);
        if (engine && !/withUnattendedPolicy\(/.test(engine[1]) && !/withUnattendedPolicy\(/.test(construction)) {
          unwrapped.push(`${file.rel}: policyEngine: ${engine[1].trim()}`);
        }
      }
    }
    // Rule: an unattended run is governed by an explicit UnattendedPolicy (DENY_ALL when nothing is granted).
    // The flag alone is never permission.
    expect(unwrapped).toEqual([]);
  });

  it("no per-call policy bypass flag exists anywhere in the source", () => {
    // Rule: authorization cannot be skipped by a caller. Test fixtures use the explicit testOnlyAllowAll() engine.
    expect(hits(/\bskipPolicy\b|\bskipCapabilityCheck\b/)).toEqual([]);
  });

  it("the gateway's confirmation gate never reads the unattended flag", () => {
    // Rule: unattended is not approval. The gateway returns ConfirmationRequired whatever the flag says; an
    // unattended engine turns confirmations into escalations before they reach the gateway.
    const gateway = FILES.find((f) => f.rel === "src/tools/gateway/tool-gateway.ts");
    expect(gateway).toBeDefined();
    const gate = gateway!.text
      .split("\n")
      .filter((line) => /requireConfirmation/.test(line) && /unattended/.test(line));
    expect(gate).toEqual([]);
  });

  it("no code outside the policy module constructs an allow-all engine", () => {
    // Rule: AllowAllPolicyEngine exists for tests and external embedders. Nexum's own code never constructs it.
    const offenders = hits(/new\s+AllowAllPolicyEngine\s*\(/, (rel) => rel === "src/core/policy/policy-engine.ts");
    expect(offenders).toEqual([]);
  });

  it("the execution context carries no second policy engine", () => {
    // Rule: one source of truth for authorization: the gateway's engine.
    const ctxFile = FILES.find((f) => f.rel === "src/runtime/context/execution-context.ts");
    expect(ctxFile).toBeDefined();
    expect(/\bpolicyEngine\b/.test(ctxFile!.text)).toBe(false);
  });

  it("the ReAct strategy authorizes every tool call with the run's typed invocation context", () => {
    // Rule: every policy input the run owns travels with the call, built in one place (toolInvocationFor).
    const strategy = FILES.find((f) => f.rel === "src/runtime/strategies/execution-strategy.ts");
    expect(strategy).toBeDefined();
    const invokes = strategy!.text.split("\n").filter((line) => /toolGateway\.invoke\(/.test(line));
    expect(invokes.length).toBeGreaterThan(0);
    for (const line of invokes) {
      expect(line).toMatch(/invocation/);
    }
    expect(strategy!.text).toMatch(/toolInvocationFor\(ctx\)/);
  });

  it("task transitions go through transitionTask, so refusals and propagated changes are never dropped", () => {
    // Rule: observability. applyTaskTransition discards transition records and rejections; callers must not use it.
    const offenders = hits(/\bapplyTaskTransition\(/, (rel) => rel === "src/runtime/task-machine.ts");
    expect(offenders).toEqual([]);
  });

  it("an unattended run's ceilings are applied where runs are created", () => {
    // Rule: unattended runs are bounded. The creation point must apply the ceilings to unattended requests.
    const ctxFile = FILES.find((f) => f.rel === "src/runtime/context/execution-context.ts");
    expect(ctxFile!.text).toMatch(/request\.unattended === true \? applyUnattendedCeilings/);
  });
});
