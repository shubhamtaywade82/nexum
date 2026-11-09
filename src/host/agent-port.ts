/**
 * The Agent surface the host drives: starting and cancelling a run, its events, approvals and clarifications,
 * the MCP and model catalogue the host reports, and the session plumbing that restores a conversation.
 *
 * The host depends on this port and not on the Agent facade, so the facade can change behind it without the
 * host following, and host tests can fake exactly what the host uses. Agent satisfies it structurally: the
 * server's agent factory builds an Agent.
 */
import type { Agent } from "../cli/agent.js";

export type AgentPort = Pick<
  Agent,
  | "on"
  | "startHost"
  | "stopHost"
  | "runUserMessage"
  | "resolveApproval"
  | "resolveClarification"
  | "startExecutionRun"
  | "endExecutionRun"
  | "cancelExecutionRun"
  | "approvalMode"
  | "completeOnce"
  | "listModels"
  | "modelCapabilities"
  | "mcpHostConfig"
  | "getSkillsRegistry"
  | "resumeSessionById"
> & {
  readonly execution: Pick<Agent["execution"], "signal">;
  readonly conversation: Pick<Agent["conversation"], "getMessages" | "loadMessages" | "presentationInstructions">;
  readonly tools: Pick<Agent["tools"], "gateway" | "registerMcpTools">;
  readonly sessions: Pick<Agent["sessions"], "adopt">;
};
