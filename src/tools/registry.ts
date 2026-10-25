import { Tool, ToolError } from "./tool.js";
import { OllamaToolSchema } from "../models/adapters/provider.js";
import { canonicalToolName } from "../core/tools/tool-aliases.js";
import type { ToolCallContext } from "../core/tools/tool-contract.js";

/*
 * Canonical names + compatibility aliases now live in ONE place:
 * core/tools/tool-aliases.ts (review item 36). This legacy registry
 * consumes the same table so both execution paths resolve identically.
 */

function normalizeArgs(tool: Tool, rawArgs: unknown): Record<string, unknown> {
  if (typeof rawArgs !== "object" || rawArgs === null) return {};

  const properties = (tool.parameters?.properties ?? {}) as Record<string, unknown>;
  const propKeys = Object.keys(properties);

  if (Array.isArray(rawArgs)) {
    const mapped: Record<string, unknown> = {};
    rawArgs.forEach((val, idx) => {
      if (propKeys[idx]) mapped[propKeys[idx]] = val;
    });
    return mapped;
  }

  const keys = Object.keys(rawArgs);
  const isNumericKeys = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
  if (isNumericKeys) {
    const mapped: Record<string, unknown> = {};
    keys.forEach((k) => {
      const idx = Number(k);
      if (propKeys[idx]) mapped[propKeys[idx]] = (rawArgs as Record<string, unknown>)[k];
    });
    return mapped;
  }

  return rawArgs as Record<string, unknown>;
}

export class Registry {
  private readonly tools = new Map<string, Tool>();
  private readonly categories = new Map<string, string>();

  register(tool: Tool, category = "General"): this {
    this.tools.set(tool.name, tool);
    this.categories.set(tool.name, category);
    return this;
  }

  unregister(name: string): boolean {
    this.categories.delete(name);
    return this.tools.delete(name);
  }

  getTools(): Tool[] {
    return [...this.tools.values()];
  }

  categoryOf(name: string): string {
    return this.categories.get(name) ?? "General";
  }

  schemas(): OllamaToolSchema[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    callCtx?: ToolCallContext,
  ): Promise<Record<string, unknown>> {
    try {
      const targetName = canonicalToolName(name);
      let tool = this.tools.get(targetName) ?? this.tools.get(name);

      if (!tool) {
        const lower = targetName.toLowerCase();
        for (const [k, v] of this.tools.entries()) {
          if (k.toLowerCase() === lower) {
            tool = v;
            break;
          }
        }
      }

      if (!tool) {
        const available = [...this.tools.keys()].sort().join(", ");
        throw new ToolError(`unknown tool: ${name}. Available tools: ${available}`);
      }

      const effectiveArgs = normalizeArgs(tool, args);
      return await tool.call(effectiveArgs, callCtx);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return { error: err.constructor.name, message: err.message };
    }
  }
}
