export type ExecutionNodeKind =
  | "intent"
  | "planner"
  | "context"
  | "intelligence"
  | "memory"
  | "router"
  | "orchestrator"
  | "tool"
  | "mcp"
  | "verification"
  | "reflection"
  | "git";

export type ExecutionNodeStatus =
  "pending" | "running" | "waiting" | "completed" | "failed" | "collapsed" | "paused" | "cancelled" | "retrying";

export interface ExecutionNodeDetails {
  prompt?: string;
  model?: string;
  rationale?: string;
  durationMs?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  diffPath?: string;
  diagnostics?: Array<{ severity: string; message: string }>;
  [key: string]: unknown;
}

export interface ExecutionNode {
  id: string;
  kind: ExecutionNodeKind;
  title: string;
  status: ExecutionNodeStatus;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  parentId?: string;
  details?: ExecutionNodeDetails;
  children?: ExecutionNode[];
}

export class ExecutionNodeGraph {
  private nodes = new Map<string, ExecutionNode>();
  private activeId?: string;

  startNode(
    id: string,
    kind: ExecutionNodeKind,
    title: string,
    parentId?: string,
    details?: ExecutionNodeDetails,
  ): ExecutionNode {
    const node: ExecutionNode = {
      id,
      kind,
      title,
      status: "running",
      startTime: Date.now(),
      parentId,
      details,
      children: [],
    };
    this.nodes.set(id, node);
    if (parentId && this.nodes.has(parentId)) {
      const parent = this.nodes.get(parentId)!;
      parent.children = parent.children || [];
      parent.children.push(node);
    }
    this.activeId = id;
    return node;
  }

  updateNode(id: string, status: ExecutionNodeStatus, details?: ExecutionNodeDetails): ExecutionNode | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    node.status = status;
    if (details) {
      node.details = { ...(node.details || {}), ...details };
    }
    if (status === "completed" || status === "failed") {
      node.endTime = Date.now();
      node.durationMs = node.endTime - node.startTime;
      if (this.activeId === id) {
        this.activeId = node.parentId;
      }
    }
    return node;
  }

  getNode(id: string): ExecutionNode | undefined {
    return this.nodes.get(id);
  }

  getActiveNode(): ExecutionNode | undefined {
    return this.activeId ? this.nodes.get(this.activeId) : undefined;
  }

  getAllNodes(): ExecutionNode[] {
    return Array.from(this.nodes.values());
  }

  getRootNodes(): ExecutionNode[] {
    return Array.from(this.nodes.values()).filter((n) => !n.parentId);
  }
}

// ── Derivation from runtime state ──────────────────────────────────────────

const PHASE_KIND: Record<string, ExecutionNodeKind> = {
  understand: "intent",
  inspect: "context",
  plan: "planner",
  execute: "orchestrator",
  validate: "verification",
  repair: "reflection",
  review: "verification",
  complete: "verification",
};

const STEP_STATUS: Record<string, ExecutionNodeStatus> = {
  pending: "pending",
  completed: "completed",
  failed: "failed",
  skipped: "collapsed",
  cancelled: "cancelled",
  rolledback: "failed",
  blocked: "waiting",
  paused: "paused",
  rejected: "failed",
};

interface StateLike {
  mission: {
    goal: string;
    phases: Array<{ id: string; status: string; startedAt?: number; endedAt?: number }>;
    steps: Array<{ id: string; description: string; status: string }>;
  };
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: string;
    startedAt: number;
    endedAt?: number;
    result?: Record<string, unknown>;
    error?: string;
  }>;
}

/**
 * Flatten the live runtime state (mission phases, plan steps, tool calls)
 * into ExecutionNodes for the DAG overlay, oldest first. Pure: the same
 * state always yields the same nodes.
 */
export function executionNodesFromState(state: StateLike, maxToolCalls = 50): ExecutionNode[] {
  const nodes: ExecutionNode[] = [];
  const { mission } = state;
  const rootId = mission.goal ? "mission" : undefined;
  if (rootId) {
    const started = mission.phases.find((p) => p.startedAt)?.startedAt ?? 0;
    nodes.push({ id: rootId, kind: "intent", title: mission.goal, status: "running", startTime: started });
  }
  let executeId: string | undefined;
  for (const phase of mission.phases) {
    if (phase.status === "pending") continue;
    const id = `phase:${phase.id}`;
    if (phase.id === "execute") executeId = id;
    nodes.push({
      id,
      kind: PHASE_KIND[phase.id] ?? "orchestrator",
      title: `phase: ${phase.id}`,
      status: phase.status as ExecutionNodeStatus,
      startTime: phase.startedAt ?? 0,
      ...(phase.endedAt ? { endTime: phase.endedAt } : {}),
      ...(phase.startedAt && phase.endedAt ? { durationMs: phase.endedAt - phase.startedAt } : {}),
      ...(rootId ? { parentId: rootId } : {}),
    });
  }
  for (const step of mission.steps) {
    nodes.push({
      id: `step:${step.id}`,
      kind: "orchestrator",
      title: `${step.id}: ${step.description}`,
      status: STEP_STATUS[step.status] ?? "running",
      startTime: 0,
      ...(executeId ? { parentId: executeId } : rootId ? { parentId: rootId } : {}),
    });
  }
  for (const call of state.toolCalls.slice(-maxToolCalls)) {
    const result = call.result ? JSON.stringify(call.result) : undefined;
    nodes.push({
      id: `tool:${call.id}`,
      kind: call.name.includes("__") ? "mcp" : call.name.startsWith("git_") ? "git" : "tool",
      title: call.name,
      status: call.status as ExecutionNodeStatus,
      startTime: call.startedAt,
      ...(call.endedAt ? { endTime: call.endedAt, durationMs: call.endedAt - call.startedAt } : {}),
      ...(executeId ? { parentId: executeId } : rootId ? { parentId: rootId } : {}),
      details: {
        toolName: call.name,
        toolArgs: call.args,
        ...(result ? { toolResult: result.slice(0, 400) } : {}),
        ...(call.error ? { rationale: call.error } : {}),
      },
    });
  }
  if (rootId) {
    const done = mission.phases.find((p) => p.id === "complete");
    if (done?.status === "completed" || done?.status === "failed") nodes[0].status = done.status as ExecutionNodeStatus;
  }
  return nodes;
}
