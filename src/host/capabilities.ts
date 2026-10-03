import type { Agent } from "../cli/agent.js";
import type { NexumCapabilities } from "../protocol/types.js";
import { isUiInvocable } from "./ui-tools.js";

export type DiscoveredCapabilities = Pick<NexumCapabilities, "tools" | "skills" | "models" | "mcp">;

const MODEL_LIST_TIMEOUT_MS = 5_000;

/**
 * What an agent can do, for clients to discover instead of hard-coding.
 * Metadata only: no file paths, commands, arguments, environment or keys.
 */
export async function discoverCapabilities(
  agent: Agent,
  opts: { modelListTimeoutMs?: number } = {},
): Promise<DiscoveredCapabilities> {
  return {
    tools: agent.tools.gateway
      .discover()
      .map((d) => ({
        id: d.id,
        description: d.description,
        pack: d.pack,
        risk: d.risk,
        uiInvocable: isUiInvocable(d),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    skills: agent
      .getSkillsRegistry()
      .list()
      .map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags, scope: s.scope })),
    models: await listModels(agent, opts.modelListTimeoutMs ?? MODEL_LIST_TIMEOUT_MS),
    mcp: agent.describeMcpServers(),
  };
}

/** Model discovery calls out to Ollama; a slow or unreachable provider must not stall the whole response. */
async function listModels(agent: Agent, timeoutMs: number): Promise<DiscoveredCapabilities["models"]> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs);
  });
  const names = await Promise.race([agent.listModels(), timedOut]).finally(() => clearTimeout(timer));
  const capabilities = await agent.modelCapabilities(names);
  return names.map((name) => ({ name, capabilities: capabilities[name] ?? [] }));
}
