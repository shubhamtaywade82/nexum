/**
 * ApprovalBroker — reusable human-in-the-loop resolver.
 *
 * Extracted from the Agent god-object (src/cli/agent.ts): the destructive
 * classification tables and the pending-approval promise plumbing now live
 * here so CLI, TUI, API, background workers, and the crypto agent share one
 * implementation.
 *
 * Since the gateway enforcement flip, confirmation decisions ORIGINATE in
 * the PolicyEngine (src/kernel/policy/rules.ts) and reach products as
 * structured ConfirmationRequired outcomes; `describeConfirmation` renders
 * those into the same pretty request the legacy classification produced.
 * `classifyApprovalNeeded` is retained for products that veto before the
 * gateway (and for tests); the shared shell-pattern table now lives in
 * rules.ts so policy and UX can never drift apart.
 *
 * The broker does not render anything — it classifies, asks the registered
 * responder, and resolves. UIs plug in via `setResponder`.
 */

import { DESTRUCTIVE_SHELL_PATTERNS } from "./rules.js";

export interface ApprovalRequestSpec {
  title: string;
  summary: string;
  tool: string;
  args?: Record<string, unknown>;
}

export type ApprovalResponder = (request: ApprovalRequestSpec) => Promise<boolean>;

// ── Destructive classification (shared table lives in policy/rules.ts) ──────

/** Classify whether a legacy tool call needs human approval, and why. */
export function classifyApprovalNeeded(
  name: string,
  args: Record<string, unknown>,
): { title: string; summary: string } | null {
  if (name === "delete_file") {
    const path = typeof args.path === "string" ? args.path : "(unknown path)";
    return { title: `Delete ${path}`, summary: `The agent wants to delete "${path}". This cannot be undone.` };
  }
  if (name === "run_shell") {
    const command = typeof args.command === "string" ? args.command : "";
    if (DESTRUCTIVE_SHELL_PATTERNS.some((p) => p.test(command))) {
      return { title: "Run destructive shell command", summary: command };
    }
  }
  if (name === "git") {
    const gitArgs = Array.isArray(args.args) ? (args.args as string[]) : [];
    if (gitArgs[0] === "push") {
      return { title: "Push git branch", summary: `The agent wants to run "git ${gitArgs.join(" ")}".` };
    }
  }
  if (name === "github") {
    const ghArgs = Array.isArray(args.args) ? (args.args as string[]) : [];
    if (ghArgs[0] === "pr" && ghArgs[1] === "create") {
      return { title: "Create Pull Request", summary: `The agent wants to run "gh ${ghArgs.join(" ")}".` };
    }
  }
  return null;
}

/**
 * Render a gateway ConfirmationRequired outcome into an approval request.
 * The legacy classification covers the historical cases (delete_file,
 * destructive shell, git push, gh pr create) with their established titles;
 * anything else falls back to a generic title plus the policy reason.
 */
export function describeConfirmation(
  name: string,
  args: Record<string, unknown>,
  policyReason: string,
): { title: string; summary: string; detail?: string } {
  const detail = previewOf(args);
  const spec = classifyApprovalNeeded(name, args) ?? { title: `Confirm ${name}`, summary: policyReason };
  return detail ? { ...spec, detail } : spec;
}

// Enough to judge the change at a glance; the full text still reaches the tool if approved.
const PREVIEW_LIMIT = 4_000;

/** What a file-changing call will write, so the user approves the content and not just a path. */
function previewOf(args: Record<string, unknown>): string | undefined {
  const raw = args.content ?? args.patch ?? args.diff ?? args.new_lines ?? args.text;
  const text = Array.isArray(raw) ? raw.join("\n") : typeof raw === "string" ? raw : undefined;
  if (!text) return undefined;
  return text.length > PREVIEW_LIMIT
    ? `${text.slice(0, PREVIEW_LIMIT)}\n… (${text.length - PREVIEW_LIMIT} more characters)`
    : text;
}

// ── Broker ──────────────────────────────────────────────────────────────────

export class ApprovalBroker {
  private responder: ApprovalResponder | null = null;
  private readonly pending = new Map<string, (approved: boolean) => void>();
  private seq = 0;

  constructor(private readonly autoApprove = false) {}

  setResponder(responder: ApprovalResponder | null): void {
    this.responder = responder;
  }

  get hasResponder(): boolean {
    return this.responder !== null;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Ask for approval. With autoApprove or no responder, returns true
   * (headless runs are explicitly unattended; gating happens in the
   * PolicyEngine instead of blocking forever).
   */
  async request(spec: ApprovalRequestSpec): Promise<boolean> {
    if (this.autoApprove) return true;
    if (!this.responder) return true;

    const id = `approval_${++this.seq}`;
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, resolve);
      this.responder!(spec)
        .then((approved) => {
          if (this.pending.delete(id)) resolve(approved);
        })
        .catch(() => {
          if (this.pending.delete(id)) resolve(false);
        });
    });
  }

  /** Resolve a pending request programmatically (tests, IPC, TUI overlays). */
  resolveAll(approved: boolean): void {
    for (const [id, resolve] of [...this.pending]) {
      this.pending.delete(id);
      resolve(approved);
    }
  }
}
