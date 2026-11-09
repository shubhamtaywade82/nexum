/**
 * The documented plane rules, enforced on the import graph (docs/guide/architecture.md and
 * docs/guide/kernel.md). Each plane may depend only on the planes below it, and the kernel
 * (core) depends on no plane at all.
 *
 *   Evolution  (src/evolution)     above orchestration and runtime
 *   Control    (src/orchestration) above runtime
 *   Runtime    (src/runtime)       the composition root; knows no plane above it
 *   Core       (src/core)          domain-neutral contracts; knows no plane at all
 */
import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = resolve(process.cwd(), "src");

/** Each rule: a source plane and the planes it must not import. */
const RULES: Array<{ plane: string; forbids: string[] }> = [
  { plane: "core", forbids: ["runtime", "orchestration", "evolution", "domains", "cli", "host", "ui", "marketplace"] },
  { plane: "runtime", forbids: ["orchestration", "evolution", "domains", "cli", "host", "ui", "marketplace"] },
];

function sourceFiles(dir: string): string[] {
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

describe("plane layering (documented rules)", () => {
  for (const rule of RULES) {
    it(`${rule.plane} imports none of: ${rule.forbids.join(", ")}`, () => {
      const violations: string[] = [];
      for (const file of sourceFiles(join(SRC, rule.plane))) {
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
