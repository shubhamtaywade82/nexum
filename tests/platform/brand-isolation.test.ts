import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";

/**
 * Brand-isolation guard (docs/REBRANDING.md §2 and §9).
 *
 * Every decision about where persistent state lives is made exclusively by
 * `src/platform/` (BRAND constants + the paths.ts helpers + WorkspaceManager).
 * Hardcoding a brand path literal anywhere else is exactly how the 2.0.0 TUI
 * shipped creating state directories under a stale brand name — the class of
 * regression this test exists to catch in CI instead of in a user's workspace.
 *
 * Rule enforced: outside `src/platform/`, no TypeScript source may contain a
 * string or template literal that IS (or starts with) a brand state path:
 * `.nexum` or `.nexum_history`.
 *
 * Not flagged:
 *   - message text that merely mentions a directory mid-sentence
 *     (e.g. "no .nexum directory exists") — the literal
 *     must START with the path for the regex to hit;
 *   - comments — stripped (crudely) before scanning. The stripping can be
 *     fooled by a `//` inside a string literal, which at worst produces a
 *     false negative; a regression guard may lean that way, never the other.
 */
describe("platform/brand-isolation — no brand-path literals outside src/platform", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const scanRoots = [join(repoRoot, "src"), join(repoRoot, "bin")];
  const platformDir = join(repoRoot, "src", "platform");

  /** A quoted literal that is (or begins with) a brand state path,
   *  including "/<path>" concatenation forms. */
  const BRAND_PATH_LITERAL = /["'`]\/?\.nexum(?:_history)?[/"'`]/;

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  }

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  function scandirs(): string[] {
    const files: string[] = [];
    for (const root of scanRoots) {
      const st = statSync(root);
      if (st.isDirectory()) files.push(...walk(root));
      else if (/\.(ts|tsx|js|mjs)$/.test(root)) files.push(root);
    }
    return files;
  }

  it("src/ and bin/ contain no hardcoded .nexum path literals outside src/platform", () => {
    const offenders: string[] = [];

    for (const file of scandirs()) {
      if (file.startsWith(platformDir)) continue; // src/platform owns the path helpers
      const code = stripComments(readFileSync(file, "utf8"));
      const lines = code.split("\n");
      lines.forEach((line, i) => {
        const m = line.match(BRAND_PATH_LITERAL);
        if (m) {
          offenders.push(`${file.replace(repoRoot + "/", "")}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }

    if (offenders.length > 0) {
      const guidance = [
        "Brand-path literals are forbidden outside src/platform/ (docs/REBRANDING.md §2, §9).",
        "Route through src/platform/paths.ts (workspaceStateDir / historyFile / globalStateDir) or through",
        "WorkspaceManager — never hardcode where state lives.",
        "",
        "Offending lines:",
        ...offenders,
      ].join("\n");
      throw new Error(guidance);
    }

    expect(offenders).toEqual([]);
  });

  it("the guard actually detects the historic violations it was written for", () => {
    // Self-check: the exact patterns from the 2.0.0 TUI regression must match.
    const historic = [
      'const p = path.join(cfg.workspaceRoot, ".nexum", "models.json");',
      'writeFileSync(root + "/.nexum_history", "");',
      'const BACKUP_DIR = ".nexum/backups";',
    ];
    for (const line of historic) {
      expect(BRAND_PATH_LITERAL.test(stripComments(line))).toBe(true);
    }
    // And legitimate prose mentions must NOT be flagged.
    const benign = [
      'throw new Error("no .nexum directory exists at " + root);',
      "// see .nexum/history.json for the persisted entries",
    ];
    for (const line of benign) {
      expect(BRAND_PATH_LITERAL.test(stripComments(line))).toBe(false);
    }
  });
});
