/**
 * MAC v1 mission-plane layering rules (ADR-0001, docs/multi-agent/SPEC.md §3).
 *
 * The coordination layer stays thin: the mission plane orchestrates roles but
 * never reaches into presentation or domain planes, and the role agents and
 * the Kit adapter are likewise fenced off from the planes above them. These
 * rules are enforced here from day one (P0) so the directories can be created
 * empty and still be guarded; the guards apply to whatever lands in them later.
 *
 * Rules (ADR-0001 "Layering rules" and ROADMAP PR 0.2):
 *   mission plane      src/orchestration/mission/**   must not import ui, agents, domains
 *   role agents        src/agents/{tracker,predictor,commander}/**   must not import orchestration
 *   kit adapter        src/domains/agentic-sdlc-kit/**   must not import ui
 */
import { describe, it, expect } from "@jest/globals";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = resolve(process.cwd(), "src");

/** Each rule: a source subtree (relative to src) and the planes it must not import. */
const MISSION_RULES: Array<{ subtree: string; forbids: string[] }> = [
  { subtree: join("orchestration", "mission"), forbids: ["ui", "agents", "domains"] },
  { subtree: join("agents", "tracker"), forbids: ["orchestration", "ui", "domains"] },
  { subtree: join("agents", "predictor"), forbids: ["orchestration", "ui", "domains"] },
  { subtree: join("agents", "commander"), forbids: ["orchestration", "ui", "domains"] },
  { subtree: join("domains", "agentic-sdlc-kit"), forbids: ["ui", "host", "cli"] },
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every module specifier a file imports, type-only imports included: a type is still a dependency. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) found.push(match[1] ?? match[2]);
  return found;
}

/** The plane (first directory under src) a relative specifier resolves into, or null for external modules. */
function planeOf(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = relative(SRC, resolve(dirname(fromFile), specifier));
  if (target.startsWith("..")) return null;
  return target.split(sep)[0] ?? null;
}

describe("MAC v1 mission-plane layering (ADR-0001)", () => {
  for (const rule of MISSION_RULES) {
    it(`${rule.subtree} imports none of: ${rule.forbids.join(", ")}`, () => {
      const violations: string[] = [];
      for (const file of sourceFiles(join(SRC, rule.subtree))) {
        for (const spec of specifiers(readFileSync(file, "utf8"))) {
          const plane = planeOf(file, spec);
          if (plane && rule.forbids.includes(plane)) {
            violations.push(`${relative(SRC, file)} -> ${spec}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
