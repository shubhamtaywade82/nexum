import { LspManager, SemanticOperation } from "../lsp/manager.js";
import type { SemanticPlugin, DiscoveredEntity, SemanticQuery, QueryResult, PluginKind } from "./types.js";

export class LspSemanticPlugin implements SemanticPlugin {
  readonly id = "lsp";
  readonly kind: PluginKind = "language";
  readonly name = "Language Server Protocol";

  constructor(private readonly lsp: LspManager) {}

  supportsOperation(filePath: string, op: SemanticOperation): boolean {
    return this.lsp.supports(filePath, op);
  }

  detect(): boolean {
    return true;
  }

  async discover(): Promise<DiscoveredEntity[]> {
    return [];
  }

  async update(_changedFiles: string[]): Promise<void> {}

  async query(query: SemanticQuery): Promise<QueryResult[]> {
    if (query.kind === "symbol" && query.term) {
      const symbols = await this.lsp.getWorkspaceSymbols(query.term);
      return symbols.map((s) => ({
        pluginId: this.id,
        entity: {
          type: symbolKindName(s.kind),
          name: s.name,
          filePath: s.location.uri,
          metadata: { kind: s.kind, containerName: s.containerName, range: s.location.range },
        },
        score: 1,
        relationships: [],
      }));
    }
    return [];
  }
}

function symbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  };
  return names[kind] ?? "Symbol";
}
