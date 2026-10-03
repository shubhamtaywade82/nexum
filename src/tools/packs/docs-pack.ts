/**
 * DocsPack (review item 21) — workspace documentation search/retrieval.
 */

import { SearchDocsTool, GetDocTool, ListDocSourcesTool } from "../docs-tools.js";
import { DocsStore } from "../../docs/store.js";
import { ToolPack, packOf } from "../gateway/tool-pack.js";

export function docsPack(store: DocsStore, workspaceRoot: string): ToolPack {
  return packOf(
    "docs",
    "Workspace documentation search and retrieval.",
    "docs",
    [
      [new SearchDocsTool(store, workspaceRoot), { policy: { uiInvocable: true } }],
      [new GetDocTool(store), { policy: { uiInvocable: true } }],
      [new ListDocSourcesTool(store, workspaceRoot), { policy: { uiInvocable: true } }],
    ],
    "Docs",
  );
}
