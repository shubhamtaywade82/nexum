// tsc only emits .ts -> .js/.d.ts; the Drizzle migration .sql files under
// src/persistence/migrations need to ship in dist/ too (database.ts
// resolves its migrations folder relative to its own compiled location),
// or a package-installed `nexum serve` can never find them.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src", "persistence", "migrations");
const dest = join(root, "dist", "persistence", "migrations");

if (!existsSync(src)) {
  console.error(`[copy-migrations] no migrations found at ${src} — nothing to copy`);
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
// stderr, not stdout: this script runs as part of `npm run build`, which
// `npm pack`'s prepack hook triggers — a stdout line here lands ahead of
// `npm pack --json`'s own JSON output and breaks JSON.parse on it (see
// scripts/check-package.mjs, which does exactly that).
console.error(`[copy-migrations] ${src} -> ${dest}`);
