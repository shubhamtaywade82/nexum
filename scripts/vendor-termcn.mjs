#!/usr/bin/env node
/**
 * Vendor termcn (ink-ui) components into Nexum's src/ui/ui/.
 *
 * termcn is a shadcn-style registry: each component is a JSON manifest whose
 * `files[]` carry full source. The shadcn CLI normally installs these with
 * `shadcn add @termcn/ink/<name>`; this script performs the same copy-paste
 * install locally so the vendored components become Nexum-owned source:
 *
 *   components/ui/<x>.tsx          -> src/ui/ui/<x>.tsx
 *   hooks/<x>.ts                   -> src/ui/ui/hooks/<x>.ts
 *   lib/<x>.ts                     -> src/ui/ui/lib/<x>.ts
 *   lib/terminal-themes/<x>.ts     -> src/ui/ui/lib/terminal-themes/<x>.ts
 *   providers/<x>.tsx              -> src/ui/ui/providers/<x>.tsx
 *
 * Import paths are rewritten from the registry's `@/` alias convention to
 * Node16-style relative imports with explicit `.js` extensions (required by
 * Nexum's tsconfig module resolution), and a classic-JSX React import is
 * prepended where a file uses JSX without importing React.
 *
 * Usage:
 *   node scripts/vendor-termcn.mjs <component>... [--allow-dep=<pkg>,<pkg>]
 *
 * Registry dependencies are vendored recursively. Bare package imports other
 * than ink/react (plus any passed via --allow-dep) are reported as warnings.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = join(REPO_ROOT, "src", "ui", "ui");
const CACHE_DIR = join(REPO_ROOT, "scripts", "termcn-cache");
const RAW_BASE = "https://raw.githubusercontent.com/shadcn-labs/termcn/main/apps/web/public/r/ink";

const argv = process.argv.slice(2);
const allowDepArg = argv.find((a) => a.startsWith("--allow-dep="));
const EXTRA_ALLOWED_DEPS = (allowDepArg ? allowDepArg.slice("--allow-dep=".length) : "").split(",").filter(Boolean);
const COMPONENTS = argv.filter((a) => !a.startsWith("--"));

if (COMPONENTS.length === 0) {
  console.error("Usage: node scripts/vendor-termcn.mjs <component>... [--allow-dep=pkg,pkg]");
  process.exit(1);
}

/** Map a termcn install target to its path under src/ui/ui/. */
function mapTarget(target) {
  if (target.startsWith("components/ui/")) return target.slice("components/ui/".length);
  return target;
}

/** Infer the install target from the registry source path when `target` is absent. */
function inferTarget(path, type) {
  const m = path.match(/^registry\/(ui|hooks|lib|providers|themes)\/(.+)$/);
  if (!m) throw new Error(`Cannot infer target for registry path: ${path} (type: ${type})`);
  const [, kind, rest] = m;
  switch (kind) {
    case "ui":
      return `components/ui/${rest}`;
    case "hooks":
      return `hooks/${rest}`;
    case "lib":
      return `lib/${rest}`;
    case "providers":
      return `providers/${rest}`;
    case "themes":
      return `lib/terminal-themes/${rest}`;
  }
}

async function fetchJson(name) {
  const cachePath = join(CACHE_DIR, `${name}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, "utf-8"));
  }
  const url = `${RAW_BASE}/${name}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const json = await res.json();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(json, null, 2));
  return json;
}

/**
 * Rewrite `@/...` registry imports into Node16 relative imports with .js
 * extensions, relative to the importing file's output location. Relative
 * registry-internal imports (e.g. `./spinner`) gain their `.js` too.
 */
function rewriteImports(content, outFile) {
  // JSX appears after an opening paren, assignment, comma, arrow, or return —
  // never directly after an identifier the way TS generics do (`Record<…>`).
  const usesJsx =
    /\(\s*<[A-Za-z>/]|[=,]\s*<[A-Za-z>/]|=>\s*<[A-Za-z>/]|return\s+<[A-Za-z>/]/.test(content);
  const hasReactImport =
    /^import\s+\*\s+as\s+React\b/m.test(content) || /^import\s+React\b/m.test(content) || /^import\s+type\s+React\b/m.test(content) || /^import\s+\{[^}]*\bdefault\b[^}]*\}\s+from\s+["']react["']/m.test(content);

  let rewritten = content.replace(/(["'])(\.{1,2}\/[^"']*)\1/g, (full, quote, spec) => {
    // Relative import inside the registry tree: keep it relative to the same
    // output directory, ensure the .js extension Node16 requires.
    if (/\.(js|json|css)$/.test(spec)) return full;
    return `${quote}${spec}.js${quote}`;
  });

  rewritten = rewritten.replace(/(["'])@\/([^"']+)\1/g, (full, quote, spec) => {
    let mapped;
    if (spec.startsWith("components/ui/")) mapped = spec.slice("components/ui/".length);
    else mapped = spec;
    const targetModule = posix.join("src/ui/ui", mapped);
    const normOut = outFile.replaceAll("\\", "/");
    const fromDir = posix.dirname(normOut.slice(REPO_ROOT.replaceAll("\\", "/").length + 1));
    let rel = posix.relative(fromDir, targetModule);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    if (!/\.(js|json)$/.test(rel)) rel = `${rel}.js`;
    return `${quote}${rel}${quote}`;
  });

  if (usesJsx && !hasReactImport) {
    rewritten = `import React from "react";\n${rewritten}`;
  }
  rewritten = applyNexumPatches(rewritten, mapTargetRelativeToUi(outFile));
  return rewritten;
}

/** Path of outFile relative to src/ui/ui/ (for targeted patches). */
function mapTargetRelativeToUi(outFile) {
  const norm = outFile.replaceAll("\\", "/");
  const idx = norm.indexOf("src/ui/ui/");
  return idx === -1 ? "" : norm.slice(idx + "src/ui/ui/".length);
}

/**
 * Nexum-specific adaptations applied on every (re)vendor so manual fixes
 * never get clobbered by a later run pulling the same registry entry:
 *
 *  1. use-theme falls back to the Nexum default palette (registry) rather
 *     than termcn's hex default, so provider-less renders match the app.
 *  2. use-unicode's browser `typeof window` probe doesn't typecheck under
 *     Nexum's no-DOM lib; `typeof process === "undefined"` is equivalent.
 */
function applyNexumPatches(content, relTarget) {
  if (relTarget === "hooks/use-theme.ts") {
    content = content
      .replace(
        /import \{ defaultTheme \} from "[^"]*terminal-themes\/default\.js";/,
        `import { getTheme } from "../theme-registry.js";`,
      )
      .replace("theme: defaultTheme,", `theme: getTheme("default"),`);
  }
  if (relTarget === "hooks/use-unicode.ts") {
    content = content.replace(
      'if (typeof window !== "undefined") {',
      'if (typeof process === "undefined") {',
    );
  }
  if (relTarget === "hooks/use-interaction.tsx") {
    // TS function overloads trip eslint's base no-redeclare rule.
    if (!content.startsWith("/* eslint-disable")) {
      content = `/* eslint-disable no-redeclare -- TS function overloads */\n${content}`;
    }
  }
  return content;
}

/** Report bare imports outside the allowlist so surprises surface immediately. */
function checkExternalImports(content, name) {
  const allowed = new Set([
    "ink",
    "react",
    "node:fs",
    "node:path",
    "node:child_process",
    "node:util",
    "node:os",
    "node:process",
    ...EXTRA_ALLOWED_DEPS,
  ]);
  const specs = [...content.matchAll(/from\s+["']([^"'.][^"']*)["']/g)].map((m) => m[1]);
  const external = specs.filter((s) => !s.startsWith(".") && !s.startsWith("@/") && !allowed.has(s));
  if (external.length > 0) {
    console.warn(`  ⚠ ${name} imports non-vendored packages: ${external.join(", ")}`);
  }
}

const vendored = new Set();

async function vendor(name, stack) {
  if (vendored.has(name)) return;
  if (stack.includes(name)) {
    console.warn(`  ⚠ circular registry dependency skipped: ${stack.join(" -> ")} -> ${name}`);
    return;
  }
  const json = await fetchJson(name);
  const files = json.files ?? [];
  if (files.length === 0) {
    console.warn(`  ⚠ ${name}: no files in registry entry`);
    return;
  }
  for (const f of files) {
    const target = f.target ?? inferTarget(f.path, json.type);
    const outPath = join(OUT_ROOT, mapTarget(target));
    const content = rewriteImports(f.content ?? "", outPath);
    checkExternalImports(content, name);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content.endsWith("\n") ? content : `${content}\n`);
    console.log(`  ✓ ${name} -> src/ui/ui/${mapTarget(target)}`);
  }
  vendored.add(name);

  for (const depUrl of json.registryDependencies ?? []) {
    const m = depUrl.match(/\/r\/ink\/([^/.]+)\.json$/);
    if (m) {
      await vendor(m[1], [...stack, name]);
    }
  }
}

console.log(`Vendoring ${COMPONENTS.length} termcn component(s) into src/ui/ui/ ...`);
for (const c of COMPONENTS) {
  await vendor(c, []);
}
console.log(`Done. ${vendored.size} registry entries vendored (${[...vendored].join(", ")}).`);
