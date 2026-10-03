import { toolRiskAtLeast, type ToolDefinition, type ToolResult } from "../core/tools/tool-contract.js";
import { canonicalToolName, type ToolGateway } from "../tools/gateway/tool-gateway.js";
import { ErrorCodes } from "../protocol/types.js";

export type UiToolResponse =
  { status: 200; body: ToolResult } | { status: 403 | 404; body: { error: string; message: string } };

/**
 * The single rule for which tools a rendered UI may call directly; capabilities report the same answer.
 * A tool must opt in, and even then high-risk tools stay agent-only, so a mislabelled tool cannot slip through.
 */
export function isUiInvocable(definition: ToolDefinition): boolean {
  return definition.policy.uiInvocable === true && !toolRiskAtLeast(definition.risk, "high");
}

/**
 * Invokes a tool on behalf of a rendered UI (e.g. an OpenUI `Query`) outside
 * any agent run. Only tools that opted in qualify (see `isUiInvocable`): anything else,
 * and anything that changes state, must go through a run, where policy confirmations
 * and approvals apply.
 */
export async function invokeUiTool(
  gateway: ToolGateway,
  name: string,
  args: Record<string, unknown>,
): Promise<UiToolResponse> {
  const definition = gateway.discover().find((d) => d.id === canonicalToolName(name));
  if (!definition) {
    return { status: 404, body: { error: ErrorCodes.TOOL_NOT_FOUND, message: `no tool "${name}"` } };
  }
  if (!isUiInvocable(definition)) {
    return {
      status: 403,
      body: {
        error: ErrorCodes.TOOL_REQUIRES_RUN,
        message: `tool "${definition.id}" is not available to generated UI (risk: ${definition.risk}); ask the agent instead (e.g. @ToAssistant) so policy and approvals apply`,
      },
    };
  }
  // Policy stays on: a read tool can still be denied or need confirmation, which surfaces as a failed result.
  return { status: 200, body: await gateway.invoke(definition.id, args) };
}
