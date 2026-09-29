/**
 * Arg-aware policy rules — confirmation granularity below the tool level.
 *
 * The kernel's ConfirmationRule works at tool granularity (risk ladder +
 * declared confirmation policy). For multi-face tools that is the wrong
 * resolution: `run_shell` covers both `ls` (never ask) and `rm -rf /` (must
 * ask), and `git` covers both `status` and `push --force`. Asking for every
 * shell command would wreck the product UX; asking for none of them would
 * wreck safety.
 *
 * These rules inspect PolicyRequest.args and return DEFINITIVE decisions for
 * the calls they recognize:
 *   - a confirmation decision for the dangerous faces,
 *   - an explicit allow (requireConfirmation: false) for the safe faces, so
 *     the tool-level ConfirmationRule never re-flags them.
 * Unrecognized tools fall through with null, deferring to the next rule.
 *
 * The shell patterns are the same tables the CLI Agent's approval flow used
 * before the enforcement flip (moved here so policy and UX stay in sync).
 */

import { PolicyRequest, PolicyDecision, PolicyRule } from "./policy-engine.js";

/** Shell command shapes that always require a human sign-off. */
export const DESTRUCTIVE_SHELL_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*[rf]?[a-z]*(\s|$)/i, // rm -rf / -fr / -r -f, any flag order
  /\bgit\s+push\b.*(--force\b|-f\b)/i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bmkfs\./i,
  />\s*\/dev\/sd[a-z]/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
];

const confirm = (tool: string, why: string, rule: string): PolicyDecision => ({
  allowed: true,
  requireConfirmation: true,
  reason: why,
  rule,
});

const allow = (tool: string, why: string, rule: string): PolicyDecision => ({
  allowed: true,
  requireConfirmation: false,
  reason: why,
  rule,
});

/**
 * run_shell: destructive patterns ask, everything else flows without a
 * prompt (legacy CLI parity — see classifyApprovalNeeded's history).
 *
 * `allowBenignFaces` (default true) makes a non-destructive command a
 * DEFINITIVE allow, preempting the tool-level ConfirmationRule — load-bearing
 * for the parity posture, where run_shell carries inferred
 * `confirmation: "required"` that must not fire on `ls`. Postures that WANT
 * every shell call to ask (standard/restricted) pass false so benign faces
 * fall through to the risk ladder.
 */
export class DestructiveShellRule implements PolicyRule {
  readonly id = "destructive-shell";
  readonly description = "Requires confirmation for destructive shell commands; allows benign ones.";

  constructor(private readonly allowBenignFaces = true) {}

  evaluate(request: PolicyRequest): PolicyDecision | null {
    if (request.tool.id !== "run_shell") return null;
    const command = typeof request.args.command === "string" ? request.args.command : "";
    if (DESTRUCTIVE_SHELL_PATTERNS.some((p) => p.test(command))) {
      return confirm(request.tool.id, `destructive shell command: ${command}`, this.id);
    }
    // "benign" is judged from the command text, which cannot bound what a command does on the
    // host (`cat ~/.aws/credentials` is not destructive) — host shells fall through to confirmation.
    if (this.allowBenignFaces && request.tool.execution.isolation !== "host") {
      return allow(request.tool.id, "shell command is non-destructive", this.id);
    }
    return null;
  }
}

/**
 * git / github: publish actions (push, PR creation) ask; local operations
 * (status, diff, commit, add, ...) flow freely under parity — pass
 * `allowBenignFaces = false` to defer them to the risk ladder instead.
 */
export class GitPublishRule implements PolicyRule {
  readonly id = "git-publish";
  readonly description = "Requires confirmation for git push and GitHub PR creation.";

  constructor(private readonly allowBenignFaces = true) {}

  evaluate(request: PolicyRequest): PolicyDecision | null {
    if (request.tool.id !== "git" && request.tool.id !== "github") return null;
    const argv = Array.isArray(request.args.args) ? (request.args.args as unknown[]).map(String) : [];
    const isPush = request.tool.id === "git" && argv[0] === "push";
    const isPrCreate = request.tool.id === "github" && argv[0] === "pr" && argv[1] === "create";
    if (isPush) {
      return confirm(request.tool.id, `push git branch: git ${argv.join(" ")}`, this.id);
    }
    if (isPrCreate) {
      return confirm(request.tool.id, `create pull request: gh ${argv.join(" ")}`, this.id);
    }
    if (this.allowBenignFaces) return allow(request.tool.id, "local version-control operation", this.id);
    return null;
  }
}

/**
 * delete_file: irreversible workspace mutation — always asks, regardless of
 * arguments (legacy parity: every delete was gated).
 */
export class DeleteFileRule implements PolicyRule {
  readonly id = "delete-file";
  readonly description = "Requires confirmation for every file deletion.";

  evaluate(request: PolicyRequest): PolicyDecision | null {
    if (request.tool.id !== "delete_file") return null;
    const path = typeof request.args.path === "string" ? request.args.path : "(unknown path)";
    return confirm(request.tool.id, `delete "${path}" — this cannot be undone`, this.id);
  }
}
