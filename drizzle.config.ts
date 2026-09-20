import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the Nexum Host's Postgres schema
 * (src/persistence/schema). Generate migrations with:
 *   npx drizzle-kit generate
 * Migrations are applied automatically on startup by
 * src/persistence/database.ts's openDatabase().
 */
export default defineConfig({
  schema: "./src/persistence/schema/index.ts",
  out: "./src/persistence/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://nexum:nexum@localhost:5432/nexum",
  },
});
