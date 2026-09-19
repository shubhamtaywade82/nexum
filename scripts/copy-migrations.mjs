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
console.log(`[copy-migrations] ${src} -> ${dest}`);
