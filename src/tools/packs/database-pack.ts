/**
 * DatabasePack (review item 21) — sqlite queries against workspace databases.
 */

import { SqliteQueryTool } from "../database-tools.js";
import { ToolPack, packOf } from "../gateway/tool-pack.js";
import type { WorkspaceBoundary } from "../path-utils.js";

export function databasePack(boundary: WorkspaceBoundary): ToolPack {
  return packOf(
    "database",
    "SQLite queries against workspace databases.",
    "data",
    [[new SqliteQueryTool(boundary), { risk: "medium", sideEffects: { filesystem: true } }]],
    "Database",
  );
}
