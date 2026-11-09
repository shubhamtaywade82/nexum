/**
 * ToolCatalog — answers "what tools exist?".
 *
 * Deliberately separate from the ToolGateway (which answers "may this agent
 * execute this tool now?"). The catalog is a pure registry: definitions +
 * handlers, indexed for discovery. It holds no authority and performs no
 * policy checks.
 *
 * Legacy `Tool` class instances (src/tools/tool.ts) are admitted through
 * `registerLegacy`, which derives a ToolDefinition from the class metadata
 * and wraps `tool.call` as the handler.
 */

import type { OllamaToolSchema } from "../../models/adapters/provider.js";
import { Tool } from "../tool.js";
import {
  NO_SIDE_EFFECTS,
  ToolDefinition,
  ToolHandler,
  ToolRisk,
  defineToolMetadata,
  toolRiskAtLeast,
} from "../../core/tools/tool-contract.js";

export interface ToolCatalogEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/** Metadata overrides used when registering a legacy Tool instance. */
export interface LegacyToolMetadata {
  risk?: ToolRisk;
  sideEffects?: Partial<ToolDefinition["sideEffects"]>;
  execution?: Partial<ToolDefinition["execution"]>;
  policy?: Partial<ToolDefinition["policy"]>;
  network?: Partial<ToolDefinition["network"]>;
  capabilities?: string[];
  pack?: string;
}

/** Categories that imply mutating side effects when a legacy tool is registered without explicit metadata. */
const MUTATING_CATEGORIES = new Set(["Filesystem", "Shell", "Git", "Docker", "Database", "Project", "Ruby", "Rails"]);

function legacyRiskFor(category: string, toolName: string): ToolRisk {
  if (toolName === "run_shell") return "high";
  if (toolName === "delete_file") return "high";
  if (toolName === "git" || toolName === "github") return "high";
  if (toolName === "binance_paper_trade") return "critical";
  if (category === "Filesystem" || category === "Git" || category === "Docker") return "medium";
  return "read";
}

function legacySideEffectsFor(category: string): ToolDefinition["sideEffects"] {
  const sideEffects = { ...NO_SIDE_EFFECTS };
  if (MUTATING_CATEGORIES.has(category)) sideEffects.filesystem = true;
  if (category === "Shell" || category === "Project" || category === "Ruby") sideEffects.process = true;
  if (category === "Market") sideEffects.network = true;
  if (category === "Browser") {
    sideEffects.network = true;
    sideEffects.process = true;
  }
  if (category === "MCP") {
    sideEffects.network = true;
    sideEffects.externalMutation = true;
  }
  return sideEffects;
}

/** Network requirements implied by legacy categories (review item 5). */
function legacyNetworkFor(category: string): NonNullable<ToolDefinition["network"]> {
  if (category === "Market") return { required: true, egress: ["binance.com"], proxyable: true };
  if (category === "MCP") return { required: true, egress: [], proxyable: false };
  if (category === "Browser") return { required: true, egress: [], proxyable: false };
  if (category === "Git" || category === "GitHub") return { required: true, egress: ["github.com"], proxyable: true };
  return { required: false, proxyable: false };
}

export class ToolCatalog {
  private readonly entries = new Map<string, ToolCatalogEntry>();

  register(definition: ToolDefinition, handler: ToolHandler): this {
    this.entries.set(definition.id, { definition, handler });
    return this;
  }

  /**
   * Admit a legacy Tool instance. Risk/side-effects are inferred from the
   * legacy category unless explicit metadata is supplied — explicit always
   * wins so packs can tighten (never loosen) the defaults.
   */
  registerLegacy(tool: Tool, category = "General", meta: LegacyToolMetadata = {}): this {
    const inferred = defineToolMetadata({
      risk: legacyRiskFor(category, tool.name),
      sideEffects: legacySideEffectsFor(category),
      policy: { confirmation: toolRiskAtLeast(legacyRiskFor(category, tool.name), "high") ? "required" : "optional" },
    });

    const definition: ToolDefinition = {
      id: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      capabilities: meta.capabilities ?? tool.capabilities,
      pack: meta.pack ?? category,
      tags: tool.tags,
      risk: meta.risk ?? inferred.risk,
      sideEffects: { ...inferred.sideEffects, ...(meta.sideEffects ?? {}) },
      execution: { ...inferred.execution, ...(meta.execution ?? {}) },
      policy: { ...inferred.policy, ...(meta.policy ?? {}) },
      network: (() => {
        const inferred = legacyNetworkFor(category);
        return {
          required: meta.network?.required ?? inferred.required,
          egress: meta.network?.egress ?? inferred.egress,
          proxyable: meta.network?.proxyable ?? inferred.proxyable,
        };
      })(),
    };

    return this.register(definition, async (args, callCtx) => tool.call(args, callCtx));
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): ToolCatalogEntry | undefined {
    return this.entries.get(id);
  }

  definition(id: string): ToolDefinition | undefined {
    return this.entries.get(id)?.definition;
  }

  handler(id: string): ToolHandler | undefined {
    return this.entries.get(id)?.handler;
  }

  all(): ToolCatalogEntry[] {
    return [...this.entries.values()];
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  byPack(pack: string): ToolCatalogEntry[] {
    return this.all().filter((e) => e.definition.pack === pack);
  }

  byCapability(capability: string): ToolCatalogEntry[] {
    return this.all().filter((e) => e.definition.capabilities.includes(capability));
  }

  byRiskAtLeast(floor: ToolRisk): ToolCatalogEntry[] {
    return this.all().filter((e) => e.definition.risk === floor);
  }

  /** Function-call schemas for model prompts (same shape as Registry.schemas). */
  schemas(ids?: Iterable<string>): OllamaToolSchema[] {
    const selected = ids
      ? [...ids].map((id) => this.entries.get(id)).filter((e): e is ToolCatalogEntry => !!e)
      : this.all();
    return selected.map(({ definition }) => ({
      type: "function" as const,
      function: {
        name: definition.id,
        description: definition.description,
        parameters: definition.inputSchema,
      },
    }));
  }

  size(): number {
    return this.entries.size;
  }
}
