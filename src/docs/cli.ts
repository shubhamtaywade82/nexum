#!/usr/bin/env node
import { loadConfig } from "../cli/config.js";
import { DocsStore } from "./store.js";
import { ingestDocSource } from "./ingest.js";
import { DOC_CATALOG } from "./catalog.js";
import { WorkspaceManager } from "../platform/workspace.js";

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.log("Usage: npm run docs:ingest -- <doc-id> [doc-id ...]");
    console.log("Available doc ids: " + DOC_CATALOG.map((e) => e.id).join(", "));
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  // Resolve .nexum — the store path is owned by the WorkspaceManager.
  const statePaths = new WorkspaceManager(cfg.workspaceRoot).ensure();
  const store = new DocsStore(statePaths.docsDb);

  try {
    for (const id of ids) {
      process.stdout.write(`Ingesting "${id}"... `);
      const result = await ingestDocSource(store, id);
      console.log(`done — ${result.name} (${result.sectionCount} sections)`);
    }
  } finally {
    store.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
