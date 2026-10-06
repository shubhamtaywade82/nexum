/**
 * ToolGateway v2 — the security and execution boundary for every tool call
 * (review item 4).
 *
 * The pipeline is now an explicit chain of stages, each independently
 * observable and testable:
 *
 *   ToolRegistry (resolve + canonical aliases)
 *      ↓ schema validation   (decode → normalize → validate → canonical args)
 *      ↓ capability check    (ctx capabilities ∩ tool capabilities)
 *      ↓ policy check        (PolicyEngine decision; confirmation gate)
 *      ↓ budget/resource     (limits guard + concurrency lease + timeout)
 *      ↓ idempotency         (side-effecting mutation dedupe, review item 28)
 *      ↓ Tool Executor       (runs the handler with signal + call context)
 *      ↓ Tool
 *
 * Argument flow (review item 6): decode → normalize → validate → canonical
 * args → policy → execution. Mutating tools validate strictly (unknown
 * properties rejected); read-only tools prune leniently so weak models
 * keep working.
 *
 * Cancellation (review item 16): the run's AbortSignal flows through the
 * concurrency gate into the handler's ToolCallContext.
 *
 * Policy violations, unknown tools, validation failures, timeouts and
 * saturation all surface as STRUCTURED ToolResult failures — the model
 * loop stays resilient and can adapt.
 */

import { randomUUID } from "node:crypto";
import { ConcurrencyGate, GateSaturatedError } from "../../core/concurrency/gate.js";
import { throwIfAborted } from "../../core/cancellation/cancellation.js";
import type { OllamaToolSchema } from "../../models/adapters/provider.js";
import { ToolCatalog, ToolCatalogEntry } from "./tool-catalog.js";
import { ToolCallContext, ToolDefinition, ToolInvocation, ToolResult } from "../../core/tools/tool-contract.js";
import { canonicalToolName } from "../../core/tools/tool-aliases.js";
import { validateAndCanonicalizeArgs } from "../validation/argument-validator.js";
import { IdempotencyManager } from "../idempotency.js";
import type {
  AgentPolicyContext,
  EnvironmentPolicyContext,
  PolicyDecision,
  PolicyEngine,
  WorkspacePolicyContext,
} from "../../core/policy/policy-engine.js";
import type { BudgetTracker } from "../../runtime/budget/budget-tracker.js";
import type { TaskSpec } from "../../core/types.js";

/**
 * The tool port (review §24): discovery for schemas, invocation under the
 * full registry→validate→capability→policy→budget→execute pipeline.
 */
export interface ToolGateway {
  discover(capabilities?: string[]): ToolDefinition[];
  schemasFor(capabilities?: string[]): OllamaToolSchema[];
  invoke(
    nameOrRequest: string | ToolInvocation,
    rawArgs?: Record<string, unknown> | unknown,
    ctx?: InvokeContext,
  ): Promise<ToolResult>;
}

export class UnknownToolError extends Error {
  constructor(
    public readonly name: string,
    public readonly available: string[],
  ) {
    super(`unknown tool: ${name}. Available tools: ${available.sort().join(", ")}`);
    this.name = "UnknownToolError";
  }
}

export class ToolDeniedError extends Error {
  constructor(
    message: string,
    public readonly rule?: string,
  ) {
    super(message);
    this.name = "ToolDeniedError";
  }
}

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

export class ToolTimeoutError extends Error {
  constructor(
    public readonly toolId: string,
    public readonly timeoutMs: number,
  ) {
    super(`tool "${toolId}" timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

// ── Argument repair (decode + normalize) ────────────────────────────────────

export { canonicalToolName } from "../../core/tools/tool-aliases.js";

export function normalizeToolArgs(definition: ToolDefinition | undefined, rawArgs: unknown): Record<string, unknown> {
  if (typeof rawArgs !== "object" || rawArgs === null) return {};

  const properties = (definition?.inputSchema?.properties ?? {}) as Record<string, unknown>;
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

/**
 * Decode raw model tool-call arguments (string JSON, partial JSON, arrays)
 * into an object. Mirrors the repair the Agent loop performs today, moved
 * behind the gateway so every execution path benefits.
 */
export function decodeRawArguments(rawArguments: unknown): { args: unknown; parseError: string | null } {
  if (typeof rawArguments === "object" && rawArguments !== null) {
    return { args: rawArguments, parseError: null };
  }
  if (typeof rawArguments === "string" && rawArguments) {
    try {
      return { args: JSON.parse(rawArguments), parseError: null };
    } catch (err) {
      const parseError = err instanceof Error ? err.message : String(err);
      // Legacy repair: bare comma-separated values become an array, which
      // normalizeToolArgs maps positionally onto the schema properties.
      const parts = rawArguments.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
      return { args: parts, parseError };
    }
  }
  return { args: {}, parseError: null };
}

/**
 * Legacy shallow schema validation kept for parity callers. The gateway's
 * real validation stage is validateAndCanonicalizeArgs (strict for
 * state-changing tools).
 */
export function validateAgainstSchema(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): string[] {
  const result = validateAndCanonicalizeArgs(
    schema
      ? ({
          inputSchema: schema,
          sideEffects: { filesystem: false, process: false, network: false, externalMutation: false, financial: false },
          risk: "read",
        } as ToolDefinition)
      : undefined,
    args,
    { mode: "lenient" },
  );
  return result.problems;
}

// ── Gateway ─────────────────────────────────────────────────────────────────

export interface ToolGatewayOptions {
  catalog: ToolCatalog;
  policyEngine?: PolicyEngine;
  /** Namespace used in concurrency gate labels. */
  label?: string;
  /**
   * "strict" (default) enforces required-args + types from the tool's
   * JSON-Schema; "off" restores exact legacy Registry behavior
   * (normalization only). Transitional compatibility flag.
   */
  validation?: "strict" | "off";
  /** Idempotency dedupe for side-effecting tools (review item 28). */
  idempotency?: IdempotencyManager;
}

export interface InvokeContext {
  agentId?: string;
  runId?: string;
  taskId?: string;
  mode?: string;
  unattended?: boolean;
  signal?: AbortSignal;
  /** Capability tags to filter tools by (capability check stage). */
  capabilities?: string[];
  /** Run budget — the budget stage guards limits before executing. */
  budget?: BudgetTracker;
  /** Skip policy (runtime-internal calls, e.g. strategies re-reading files). */
  skipPolicy?: boolean;
  /** Skip the capability filter (runtime-internal calls). */
  skipCapabilityCheck?: boolean;
  /** Task being executed (policy context, review item 7). */
  task?: TaskSpec;
  /** Agent identity (policy context, review item 7). */
  agent?: AgentPolicyContext;
  /** Workspace root + sandbox state (policy context, review items 7/9). */
  workspace?: WorkspacePolicyContext;
  /** Active execution profile (policy context, review item 8). */
  environment?: EnvironmentPolicyContext;
  /**
   * Confirmation already granted for THIS call (the embedding app resolved a
   * prior ConfirmationRequired outcome). Confirmation rules are skipped, but
   * deny rules and mode restrictions still apply — an approval can never
   * unlock something policy forbids outright.
   */
  confirmed?: boolean;
  /** Observability: called with every policy decision (review items 7, 13, 33). */
  onPolicyDecision?: (decision: PolicyDecision & { tool: string }) => void;
}

const failure = (code: string, message: string): ToolResult => ({
  ok: false,
  data: { error: code, message },
  error: { code, message },
});

export class DefaultToolGateway implements ToolGateway {
  private readonly catalog: ToolCatalog;
  private readonly policyEngine?: PolicyEngine;
  private readonly label: string;
  private readonly validation: "strict" | "off";
  private readonly idempotency?: IdempotencyManager;
  private readonly gates = new Map<string, ConcurrencyGate>();

  constructor(opts: ToolGatewayOptions) {
    this.catalog = opts.catalog;
    this.policyEngine = opts.policyEngine;
    this.label = opts.label ?? "tool-gateway";
    this.validation = opts.validation ?? "strict";
    this.idempotency = opts.idempotency;
  }

  /** Tools visible for a capability filter (empty filter = all). */
  discover(capabilities?: string[]): ToolDefinition[] {
    if (!capabilities || capabilities.length === 0) return this.catalog.all().map((e) => e.definition);
    return this.catalog
      .all()
      .filter((e) => e.definition.capabilities.some((c) => capabilities.includes(c)))
      .map((e) => e.definition);
  }

  schemasFor(capabilities?: string[]) {
    const defs = this.discover(capabilities);
    return defs.map((d) => ({
      type: "function" as const,
      function: { name: d.id, description: d.description, parameters: d.inputSchema },
    }));
  }

  /** Policy pre-check without executing (used by UIs to preview gates). */
  preview(name: string, args: Record<string, unknown>, ctx: InvokeContext = {}) {
    const entry = this.resolve(name);
    if (!entry) return null;
    if (!this.policyEngine || ctx.skipPolicy) return { allowed: true, requireConfirmation: false, reason: "no engine" };
    return this.policyEngine.check({
      tool: entry.definition,
      args,
      agentId: ctx.agentId ?? "unknown",
      runId: ctx.runId ?? "unknown",
      mode: ctx.mode,
      unattended: ctx.unattended,
    });
  }

  async invoke(
    nameOrRequest: string | ToolInvocation,
    rawArgs: Record<string, unknown> | unknown,
    ctx: InvokeContext = {},
  ): Promise<ToolResult> {
    const name = typeof nameOrRequest === "string" ? nameOrRequest : nameOrRequest.name;
    const raw = typeof nameOrRequest === "string" ? rawArgs : nameOrRequest.args;
    const invocationId =
      typeof nameOrRequest === "string" ? `tc_${randomUUID()}` : nameOrRequest.id || `tc_${randomUUID()}`;

    // ── stage 0: resolve (registry + canonical aliases) ────────────────────
    const entry = this.resolve(name);
    if (!entry) {
      return failure("UnknownTool", new UnknownToolError(name, this.catalog.ids()).message);
    }

    // ── stage 1: decode + normalize (weak-model argument repair) ───────────
    let args: Record<string, unknown>;
    if (typeof raw === "string") {
      const decoded = decodeRawArguments(raw);
      args = normalizeToolArgs(entry.definition, decoded.args);
    } else {
      args = normalizeToolArgs(entry.definition, raw);
    }

    // ── stage 2: validation → canonical args (review item 6) ───────────────
    if (this.validation === "strict") {
      const validated = validateAndCanonicalizeArgs(entry.definition, args);
      if (!validated.ok) {
        return failure("ValidationError", validated.problems.join("; "));
      }
      args = validated.args;
    }

    // ── stage 3: capability check (review item 4) ──────────────────────────
    if (!ctx.skipCapabilityCheck && ctx.capabilities && ctx.capabilities.length > 0) {
      const toolCaps = entry.definition.capabilities;
      const allowed = toolCaps.length === 0 || toolCaps.some((c) => ctx.capabilities!.includes(c));
      if (!allowed) {
        return failure(
          "CapabilityDenied",
          `tool "${entry.definition.id}" requires capabilities [${toolCaps.join(", ")}] not granted to this run [${ctx.capabilities.join(", ")}]`,
        );
      }
    }

    // ── stage 4: policy check (review items 4, 7) ──────────────────────────
    if (this.policyEngine && !ctx.skipPolicy) {
      const decision = this.policyEngine.check({
        tool: entry.definition,
        args,
        agentId: ctx.agentId ?? "unknown",
        runId: ctx.runId ?? "unknown",
        mode: ctx.mode,
        unattended: ctx.unattended,
        task: ctx.task,
        agent: ctx.agent,
        workspace: ctx.workspace,
        environment: ctx.environment,
        budget: ctx.budget?.snapshot(),
      });
      ctx.onPolicyDecision?.({ ...decision, tool: entry.definition.id });
      if (!decision.allowed) {
        return failure("PolicyDenied", decision.reason);
      }
      if (decision.requireConfirmation && !ctx.unattended && !ctx.confirmed) {
        // The gateway has no UX of its own: confirmation is surfaced as a
        // structured outcome so the embedding application (CLI/TUI approval
        // broker) can resolve it. Unattended runs bypass by contract.
        return {
          ok: false,
          data: { error: "ConfirmationRequired", message: decision.reason, args },
          error: { code: "ConfirmationRequired", message: decision.reason },
        };
      }
    }

    // ── stage 5: budget/resource guard (review item 4) ─────────────────────
    try {
      throwIfAborted(ctx.signal, `tool:${entry.definition.id}`);
      ctx.budget?.assertTimeLeft();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return failure("Cancelled", err.message);
    }

    // ── stage 5b: idempotency check (review item 28) ───────────────────────
    const keyMode = entry.definition.execution.idempotencyKey ?? "none";
    let idemKey: string | undefined;
    if (this.idempotency && (keyMode === "required" || keyMode === "auto")) {
      const check = this.idempotency.check(entry.definition.id, args, ctx.runId);
      if (check.status === "completed" && check.result) {
        const okFlag = typeof check.result.ok === "boolean" ? check.result.ok : true;
        const data = (check.result.data as Record<string, unknown> | undefined) ?? check.result;
        return { ok: okFlag, data };
      }
      if (check.status === "recorded") {
        return failure(
          "IdempotencyConflict",
          `an execution with the same idempotency key for "${entry.definition.id}" is already in flight`,
        );
      }
      if (keyMode === "required" && check.status === "new") {
        idemKey = this.idempotency.record(entry.definition.id, args, ctx.runId);
      } else if (keyMode === "auto") {
        idemKey = this.idempotency.keyFor(entry.definition.id, args);
      }
    }

    // ── stage 6: execute under concurrency lease + timeout + signal ────────
    const gate = this.gateFor(entry);
    const callCtx: ToolCallContext = {
      signal: ctx.signal,
      invocation: { id: invocationId, name: entry.definition.id, args },
      runId: ctx.runId,
      agentId: ctx.agentId,
      idempotencyKey: idemKey,
      startedAt: Date.now(),
    };

    try {
      const data = await gate.run(() => this.withTimeout(entry, args, callCtx), "normal", ctx.signal);
      const result: Record<string, unknown> = data;
      if (idemKey && this.idempotency) this.idempotency.complete(idemKey, result);
      return { ok: true, data: result };
    } catch (e) {
      if (idemKey && this.idempotency) this.idempotency.complete(idemKey, undefined, true);
      if (e instanceof ToolTimeoutError) return failure("Timeout", e.message);
      if (e instanceof ToolValidationError) return failure("ValidationError", e.message);
      if (e instanceof GateSaturatedError) return failure("ConcurrencyDenied", e.message);
      const err = e instanceof Error ? e : new Error(String(e));
      return failure(err.constructor.name, err.message);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  private resolve(name: string): ToolCatalogEntry | undefined {
    const canonical = canonicalToolName(name);
    const entry = this.catalog.get(canonical) ?? this.catalog.get(name);
    if (entry) return entry;
    const lower = canonical.toLowerCase();
    const found = this.catalog.ids().find((id) => id.toLowerCase() === lower);
    return found ? this.catalog.get(found) : undefined;
  }

  private gateFor(entry: ToolCatalogEntry): ConcurrencyGate {
    const key = entry.definition.id;
    let gate = this.gates.get(key);
    if (!gate) {
      gate = new ConcurrencyGate({
        maxConcurrent: entry.definition.execution.concurrency,
        label: `${this.label}:${key}`,
      });
      this.gates.set(key, gate);
    }
    return gate;
  }

  private withTimeout(
    entry: ToolCatalogEntry,
    args: Record<string, unknown>,
    callCtx: ToolCallContext,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = entry.definition.execution.timeoutMs;
    // cancellation reaches tool code (review item 16)
    const task = entry.handler(args, callCtx);

    if (!timeoutMs || timeoutMs <= 0) return task;

    return Promise.race([
      task,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new ToolTimeoutError(entry.definition.id, timeoutMs)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  }
}

// Invocation-shaped helper that stamps ids for tracing.
export function makeToolInvocation(name: string, args: Record<string, unknown>): ToolInvocation {
  return { id: `tc_${randomUUID()}`, name, args };
}
