/**
 * ApprovalManager service (review item 1) — human-in-the-loop gates the
 * Agent god class used to own inline.
 *
 * Owns: pending approvals (approve/reject promise map, deny-by-default
 * with no UI listener), pending clarifications, AUTO_APPROVE bypass, and
 * the kernel ApprovalBroker responder wiring.
 */

import { ApprovalBroker, describeConfirmation } from "../../core/policy/approval-broker.js";
import type { McpElicitationRequest, McpElicitationResponse } from "../../core/user-input.js";
import { ApprovalRequest, ClarificationRequest, ClarificationResponse } from "../../runtime/types.js";

export interface ApprovalManagerOptions {
  autoApprove: boolean;
  onApprovalRequested?: (request: ApprovalRequest) => void;
  onClarificationRequested?: (request: ClarificationRequest) => void;
  /** Has any listener been registered (checked before deadlocking waits)? */
  hasApprovalListener: () => boolean;
  hasClarificationListener: () => boolean;
  onMcpElicitationRequested?: (request: McpElicitationRequest) => void;
  /** Optional for backwards-compatible callers; absence is fail-closed. */
  hasMcpElicitationListener?: () => boolean;
  /** Maximum time an MCP elicitation may wait for a UI response (default 5 min). */
  mcpElicitationTimeoutMs?: number;
}

export class ApprovalManager {
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  private readonly pendingClarifications = new Map<string, (resp: ClarificationResponse) => void>();
  private readonly pendingMcpElicitations = new Map<string, (resp: McpElicitationResponse) => void>();
  private readonly mcpElicitationQueue: McpElicitationRequest[] = [];
  private readonly mcpElicitationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeMcpElicitationId: string | null = null;
  readonly broker: ApprovalBroker;

  constructor(private readonly opts: ApprovalManagerOptions) {
    this.broker = new ApprovalBroker(false);
    this.broker.setResponder(async (spec) => this.requestApproval(spec.title, spec.summary));
  }

  /**
   * Pause until the UI resolves the request (approve/reject keypress).
   * Deny by default when nobody can answer — without a listener the
   * promise would never resolve and headless consumers would deadlock.
   */
  async requestApproval(title: string, summary: string): Promise<boolean> {
    if (this.opts.autoApprove) return true;
    if (!this.opts.hasApprovalListener()) return false;

    const id = `appr${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const request: ApprovalRequest = { id, title, summary, filesChanged: 0, additions: 0, deletions: 0 };
    const approved = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(id, resolve);
      this.opts.onApprovalRequested?.(request);
    });
    this.pendingApprovals.delete(id);
    return approved;
  }

  /** Called by the UI when the user presses approve/reject. */
  resolveApproval(id: string, approved: boolean): void {
    this.pendingApprovals.get(id)?.(approved);
  }

  /** Kernel confirmation-hook adapter: describe + request. */
  async resolveConfirmation(name: string, args: Record<string, unknown>, reason: string): Promise<boolean> {
    // describeConfirmation returns the legacy {title, summary} pair
    const spec = describeConfirmation(name, args, reason);
    return this.requestApproval(spec.title, spec.summary);
  }

  /** Pause until the UI answers a clarification (options picker). */
  async requestClarification(request: ClarificationRequest): Promise<ClarificationResponse> {
    if (!this.opts.hasClarificationListener()) {
      return { id: request.id, selectedId: request.options[0]?.id ?? "default" };
    }
    return new Promise<ClarificationResponse>((resolve) => {
      this.pendingClarifications.set(request.id, resolve);
      this.opts.onClarificationRequested?.(request);
    });
  }

  resolveClarification(response: ClarificationResponse): void {
    const handler = this.pendingClarifications.get(response.id);
    if (handler) {
      this.pendingClarifications.delete(response.id);
      handler(response);
    }
  }

  /** Server-initiated MCP input; serialize requests because the TUI has one blocking surface. */
  async requestMcpElicitation(request: McpElicitationRequest): Promise<McpElicitationResponse> {
    if (this.opts.hasMcpElicitationListener?.() !== true) return { id: request.id, action: "decline" };
    return new Promise<McpElicitationResponse>((resolve) => {
      this.pendingMcpElicitations.set(request.id, resolve);
      this.mcpElicitationQueue.push(request);
      this.pumpNextMcpElicitation();
    });
  }

  private pumpNextMcpElicitation(): void {
    if (this.activeMcpElicitationId || this.mcpElicitationQueue.length === 0) return;
    const request = this.mcpElicitationQueue.shift()!;
    this.activeMcpElicitationId = request.id;
    this.opts.onMcpElicitationRequested?.(request);

    const timeoutMs = this.opts.mcpElicitationTimeoutMs ?? 5 * 60_000;
    if (timeoutMs > 0) {
      this.mcpElicitationTimers.set(
        request.id,
        setTimeout(() => {
          this.resolveMcpElicitation({ id: request.id, action: "decline" });
        }, timeoutMs),
      );
    }
  }

  resolveMcpElicitation(response: McpElicitationResponse): void {
    const handler = this.pendingMcpElicitations.get(response.id);
    if (!handler) return;
    this.pendingMcpElicitations.delete(response.id);
    const timer = this.mcpElicitationTimers.get(response.id);
    if (timer) {
      clearTimeout(timer);
      this.mcpElicitationTimers.delete(response.id);
    }
    if (this.activeMcpElicitationId === response.id) this.activeMcpElicitationId = null;
    handler(response);
    this.pumpNextMcpElicitation();
  }

  pendingMcpElicitationCount(): number {
    return this.pendingMcpElicitations.size;
  }

  resolveMcpElicitation(response: McpElicitationResponse): void {
    const handler = this.pendingMcpElicitations.get(response.id);
    if (handler) {
      this.pendingMcpElicitations.delete(response.id);
      handler(response);
    }
  }

  pendingMcpElicitationCount(): number {
    return this.pendingMcpElicitations.size;
  }

  pendingApprovalCount(): number {
    return this.pendingApprovals.size;
  }
}
