import { URI } from "vscode-uri";

export function pathToUri(workspaceRoot: string, filePath: string): string {
  const absolute = filePath.startsWith("/") ? filePath : `${workspaceRoot}/${filePath}`;
  return URI.file(absolute).toString();
}

export function uriToPath(uri: string): string {
  return URI.parse(uri).fsPath;
}

export interface LspServerState {
  language: string;
  status: "starting" | "running" | "idle" | "stopped" | "error";
  documentsCount: number;
  errorCount: number;
  /** True while the server has an open $/progress span (e.g. project
   * indexing) — "running" alone can't tell "no results" from "not indexed
   * yet"; queries made while this is true may return incomplete results. */
  indexing: boolean;
}
