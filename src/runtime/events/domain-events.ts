/**
 * DomainEvent — what the *world* looks like (review item 12).
 *
 * Domain events report observable state of the environment and the
 * workspace: git state, MCP servers, LSP servers, the Rails index,
 * memory, skills, detected project type. They are produced by domain
 * producers (git watchers, MCP connectors) and consumed by state
 * projections; they are NOT execution acts and are never re-emitted
 * during replay of a run.
 */

import type { GitState, LspServerState, McpServerState, MemoryItem, ProjectInfo, SkillState } from "../types.js";

export type DomainEvent =
  | { type: "git.changed"; git: GitState }
  | { type: "memory.updated"; items?: MemoryItem[]; summary?: string }
  | { type: "mcp.changed"; servers: McpServerState[] }
  | { type: "lsp.changed"; servers: LspServerState[] }
  | { type: "lsp.diagnostics"; path: string; count: number }
  | {
      type: "rails.index";
      status: "building" | "ready" | "updated" | "disabled" | "error";
      entityCount?: number;
      edgeCount?: number;
      scannerErrors?: string[];
      durationMs?: number;
      railsVersion?: string;
      rubyVersion?: string;
      testFramework?: string;
      byType?: Record<string, number>;
    }
  | { type: "skills.changed"; skills: SkillState[] }
  | { type: "project.detected"; info: ProjectInfo }
  | { type: "sandbox.detected"; available: boolean; enabled?: boolean }
  // which model the operator/product selected (world state, not a call)
  | { type: "model.changed"; provider?: string; name: string };
