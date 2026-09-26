/**
 * Plugin sandbox (P2 trust tier).
 *
 * Two complementary isolation tiers for running plugins that are not written
 * by the host author:
 *
 *   Tier 1 — Policy mediation (`sandboxPlugin`):
 *     Wraps an in-process plugin so every `PluginContext` operation it
 *     performs is checked against a `PluginSandboxPolicy` (allow-patterns for
 *     provide / lookup / declareCapability, a provide-count cap, and
 *     per-lifecycle timeouts). Denied operations throw
 *     `PluginSandboxViolation` and are recorded in an audit log. This tier
 *     constrains WHAT a plugin can touch, but shares the host's process.
 *
 *   Tier 2 — Worker isolation (`IsolatedPluginSandbox`):
 *     Runs a plugin *module file* inside a `worker_threads` Worker with hard
 *     `resourceLimits` (memory / stack / code-range caps) and a minimal
 *     message bridge. The plugin file cannot reach host objects at all: its
 *     `ctx` is a proxy whose operations round-trip over `postMessage`, and
 *     capability values it looks up must be structured-cloneable. A hung or
 *     crashing worker is terminated and surfaces as a normal plugin error.
 *     Tier 2 composes with Tier 1: the same `PluginSandboxPolicy` is enforced
 *     host-side on every bridged operation.
 *
 * Both tiers are opt-in and non-breaking: registering a plugin directly with
 * `DefaultPluginHost` keeps today's unsandboxed behaviour.
 *
 * Pattern syntax (`*` any run, `?` one char) is shared with the MCP trust
 * policy so operators learn one wildcard language across the product.
 */

import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { NexumPlugin, PluginContext, PluginLogger, PluginManifest } from "./types.js";
import { matchesPattern } from "../../mcp/trust.js";

// ── Contracts ───────────────────────────────────────────────────────────────

/** What a sandboxed plugin tried to do (audit + violation reporting). */
export type SandboxOperation = "provide" | "lookup" | "declareCapability";

export interface SandboxViolation {
  /** The plugin that was blocked. */
  pluginId: string;
  operation: SandboxOperation;
  /** The token / capability tag involved. */
  target: string;
  /** Human-readable reason the operation was denied (or failed). */
  reason: string;
  /** ISO timestamp. */
  at: string;
}

export interface SandboxAuditEntry {
  operation: SandboxOperation;
  target: string;
  decision: "allowed" | "denied";
  reason?: string;
  at: string;
}

/**
 * Per-plugin sandbox policy. All three allow-lists default to `[]` — DENY
 * everything — because a plugin is only sandboxed when the host author
 * explicitly asks for it. Grant with patterns (`*` and `?` wildcards).
 */
export interface PluginSandboxPolicy {
  /** Capability tokens this plugin may `provide` (patterns). Default: none. */
  provide?: string[];
  /** Capability tokens this plugin may `lookup` (patterns). Default: none. */
  lookup?: string[];
  /** Capability tags this plugin may `declareCapability` for. Default: none. */
  declare?: string[];
  /** Max capability provides during setup (default 16). */
  maxProvides?: number;
  /** Setup timeout in ms (default 10_000; 0 disables). */
  setupTimeoutMs?: number;
  /** Start timeout in ms (default 10_000; 0 disables). */
  startTimeoutMs?: number;
  /** Stop timeout in ms (default 5_000; 0 disables). */
  stopTimeoutMs?: number;
  /** Called on every denied/failed operation (metrics, UI badges, …). */
  onViolation?: (violation: SandboxViolation) => void;
}

const DEFAULT_MAX_PROVIDES = 16;
const DEFAULT_SETUP_TIMEOUT_MS = 10_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/** Thrown when a sandboxed plugin attempts a denied operation. */
export class PluginSandboxViolation extends Error {
  constructor(
    message: string,
    readonly violation: SandboxViolation,
  ) {
    super(message);
    this.name = "PluginSandboxViolation";
  }
}

/** Thrown when a sandboxed lifecycle call exceeds its time budget. */
export class PluginSandboxTimeout extends Error {
  constructor(
    message: string,
    readonly pluginId: string,
    readonly phase: "setup" | "start" | "stop",
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "PluginSandboxTimeout";
  }
}

/** Handle attached to sandboxed plugins for host-side inspection. */
export interface PluginSandboxHandle {
  readonly policy: PluginSandboxPolicy;
  /** Audit trail of every mediated operation (allowed and denied). */
  audit(): SandboxAuditEntry[];
}

/** A plugin wrapped by Tier 1 mediation. */
export type SandboxedPlugin = NexumPlugin & { readonly sandbox: PluginSandboxHandle };

function matchesAnyList(name: string, patterns: string[] | undefined): boolean {
  if (!patterns) return false;
  return patterns.some((p) => matchesPattern(name, p));
}

interface TimeoutError extends Error {
  timedOut: true;
  timeoutMs: number;
}

function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof Error && (err as TimeoutError).timedOut === true;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!(timeoutMs > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`timed out after ${timeoutMs}ms`) as TimeoutError;
      err.timedOut = true;
      err.timeoutMs = timeoutMs;
      reject(err);
    }, timeoutMs);
    // Do not hold the event loop open just for a sandbox timer.
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ── Tier 1: policy mediation ────────────────────────────────────────────────

/**
 * Wrap a plugin so its `setup(ctx)` receives a guarded context. Every
 * provide / lookup / declareCapability is pattern-checked against the policy,
 * counted, audited, and timeboxed. Denied operations throw
 * `PluginSandboxViolation`; lifecycle hangs throw `PluginSandboxTimeout`
 * (both surface as normal plugin errors through the host's best-effort
 * lifecycle handling).
 */
export function sandboxPlugin(plugin: NexumPlugin, policy: PluginSandboxPolicy = {}): SandboxedPlugin {
  const manifest = plugin.manifest;
  const auditEntries: SandboxAuditEntry[] = [];
  const maxProvides = policy.maxProvides ?? DEFAULT_MAX_PROVIDES;
  let provideCount = 0;

  const handle: PluginSandboxHandle = {
    policy,
    audit: () => [...auditEntries],
  };

  function record(operation: SandboxOperation, target: string, decision: "allowed" | "denied", reason?: string): void {
    auditEntries.push({ operation, target, decision, reason, at: new Date().toISOString() });
  }

  function deny(operation: SandboxOperation, target: string, reason: string): never {
    record(operation, target, "denied", reason);
    const violation: SandboxViolation = {
      pluginId: manifest.id,
      operation,
      target,
      reason,
      at: new Date().toISOString(),
    };
    policy.onViolation?.(violation);
    throw new PluginSandboxViolation(
      `sandbox denied ${operation}("${target}") for plugin "${manifest.id}": ${reason}`,
      violation,
    );
  }

  const guardedContext = (ctx: PluginContext): PluginContext => {
    return {
      manifest: ctx.manifest,
      host: ctx.host,
      workspaceRoot: ctx.workspaceRoot,
      log: ctx.log,
      provide<T>(token: string, value: T): void {
        if (provideCount >= maxProvides) {
          deny("provide", token, `provide cap reached (${maxProvides})`);
        }
        if (!matchesAnyList(token, policy.provide)) {
          deny("provide", token, "token not in policy.provide allow-list");
        }
        provideCount++;
        record("provide", token, "allowed");
        ctx.provide(token, value);
      },
      lookup<T>(token: string): T | undefined {
        if (!matchesAnyList(token, policy.lookup)) {
          deny("lookup", token, "token not in policy.lookup allow-list");
        }
        const value = ctx.lookup<T>(token);
        // A miss is not a sandbox decision — the capability simply is not
        // provided (yet); pass the undefined through like the host would.
        return value;
      },
      declareCapability(tag: string): void {
        if (!matchesAnyList(tag, policy.declare)) {
          deny("declareCapability", tag, "tag not in policy.declare allow-list");
        }
        record("declareCapability", tag, "allowed");
        ctx.declareCapability(tag);
      },
    };
  };

  function timeoutError(err: unknown, phase: "setup" | "start" | "stop", timeoutMs: number): Error {
    if (isTimeoutError(err)) {
      return new PluginSandboxTimeout(
        `plugin "${manifest.id}" ${phase} timed out after ${timeoutMs}ms`,
        manifest.id,
        phase,
        timeoutMs,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  const wrapped: SandboxedPlugin = {
    manifest,
    sandbox: handle,
    async setup(ctx: PluginContext): Promise<void> {
      const timeoutMs = policy.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
      try {
        await withTimeout(Promise.resolve(plugin.setup?.(guardedContext(ctx))), timeoutMs);
      } catch (err) {
        throw timeoutError(err, "setup", timeoutMs);
      }
    },
    async start(): Promise<void> {
      const timeoutMs = policy.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
      try {
        await withTimeout(Promise.resolve(plugin.start?.()), timeoutMs);
      } catch (err) {
        throw timeoutError(err, "start", timeoutMs);
      }
    },
    async stop(): Promise<void> {
      const timeoutMs = policy.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
      try {
        await withTimeout(Promise.resolve(plugin.stop?.()), timeoutMs);
      } catch (err) {
        throw timeoutError(err, "stop", timeoutMs);
      }
    },
  };
  return wrapped;
}

// ── Tier 2: worker-thread isolation ─────────────────────────────────────────

/**
 * Worker resource ceilings. Node enforces these per-isolate; a plugin that
 * exceeds them is killed by the runtime (surfaces as a sandbox error).
 */
export interface SandboxResourceLimits {
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  codeRangeSizeMb?: number;
  stackSizeMb?: number;
}

export interface IsolatedPluginSandboxOptions {
  /** Worker resource ceilings (defaults: 128 MB heap, 16 MB code range). */
  resourceLimits?: SandboxResourceLimits;
  /** Capabilities the isolated plugin may exercise (Tier 1, applied host-side). */
  policy?: PluginSandboxPolicy;
  /** Lifecycle timeouts (defaults as in PluginSandboxPolicy; 0 disables). */
  setupTimeoutMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Logger for worker-side log calls (default: console wrapper). */
  logger?: PluginLogger;
}

/**
 * A plugin whose code runs inside a Worker. Registering it on a
 * `DefaultPluginHost` is indistinguishable from an in-process plugin; the
 * bridge enforces the sandbox policy on every host-side operation.
 */
export type IsolatedPlugin = NexumPlugin & {
  readonly sandbox: PluginSandboxHandle & {
    /** Terminate the underlying worker immediately (host shutdown path). */
    terminate(): Promise<void>;
    /** True once the worker has exited (cleanly or not). */
    terminated(): boolean;
  };
};

// Worker bootstrap. Runs as a classic script (eval: true) — deliberately NOT
// part of the compiled bundle so sandboxing works from dist/ and tsx alike.
// It only receives a plugin file URL + performs a dynamic import; all host
// interaction flows through the message bridge below.
const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
const pending = new Map();
let seq = 0;
function callHost(op, payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "call", id, op, payload });
  });
}
const sandboxCtx = {
  get manifest() { return workerData.manifest; },
  get workspaceRoot() { return workerData.workspaceRoot; },
  log(level, msg, meta) { parentPort.postMessage({ type: "log", level, msg, meta }); },
  provide(token, value) { return callHost("provide", { token, value }); },
  lookup(token) { return callHost("lookup", { token }); },
  declareCapability(tag) { return callHost("declareCapability", { tag }); },
};
(async () => {
  const mod = await import(workerData.pluginFileUrl);
  const plugin = mod.default ?? mod;
  if (!plugin || !plugin.manifest) {
    throw new Error("plugin module must default-export { manifest, setup?, start?, stop? }");
  }
  parentPort.postMessage({ type: "ready", manifest: plugin.manifest });
  parentPort.on("message", (msg) => {
    if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value); else p.reject(new Error(msg.error));
    } else if (msg.type === "lifecycle") {
      const fn = msg.phase === "setup" ? plugin.setup : msg.phase === "start" ? plugin.start : plugin.stop;
      const invoke = msg.phase === "setup" ? () => fn && fn(sandboxCtx) : () => fn && fn();
      Promise.resolve(invoke()).then(
        () => parentPort.postMessage({ type: "lifecycle:done", phase: msg.phase }),
        (err) =>
          parentPort.postMessage({
            type: "lifecycle:error",
            phase: msg.phase,
            error: err && err.stack ? err.stack : String(err),
          }),
      );
    }
  });
})().catch((err) => {
  parentPort.postMessage({ type: "fatal", error: err && err.stack ? err.stack : String(err) });
});
`;

type BridgeCallOp = "provide" | "lookup" | "declareCapability";

interface WorkerOutMessage {
  type: "ready" | "call" | "log" | "lifecycle:done" | "lifecycle:error" | "fatal";
  manifest?: PluginManifest;
  id?: number;
  op?: BridgeCallOp;
  payload?: { token?: string; tag?: string; value?: unknown };
  level?: "debug" | "info" | "warn" | "error";
  msg?: string;
  meta?: Record<string, unknown>;
  phase?: "setup" | "start" | "stop";
  error?: string;
}

/** Default worker ceilings for untrusted code. */
const DEFAULT_RESOURCE_LIMITS: Required<SandboxResourceLimits> = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 32,
  codeRangeSizeMb: 16,
  stackSizeMb: 4,
};

/**
 * Tier 2 sandbox. `IsolatedPluginSandbox.load(file)` boots the worker,
 * imports the plugin module, and resolves an `IsolatedPlugin` whose lifecycle
 * methods proxy into the worker. See the module doc for the threat model:
 * resource isolation + no shared objects; policy mediation still happens on
 * the host side of the bridge.
 */
export class IsolatedPluginSandbox {
  private readonly worker: Worker;
  private readonly auditEntries: SandboxAuditEntry[] = [];
  private readonly policy: PluginSandboxPolicy;
  private readonly logger: PluginLogger;
  private readonly timeouts: { setup: number; start: number; stop: number };
  /** Lifecycle waiters to reject when the worker dies mid-call. */
  private readonly lifecycleWaiters = new Set<(err: Error) => void>();
  private workerTerminated = false;
  private exited = false;
  private fatal: string | undefined;
  private provideCount = 0;
  private currentPluginId: string | undefined;
  private currentProvide: ((token: string, value: unknown) => void) | undefined;
  private currentLookup: ((token: string) => unknown) | undefined;
  private currentDeclare: ((tag: string) => void) | undefined;
  private readyResolve!: (manifest: PluginManifest) => void;
  private readyReject!: (err: Error) => void;
  private readonly ready: Promise<PluginManifest>;

  private constructor(
    private readonly opts: IsolatedPluginSandboxOptions,
    pluginFileUrl: string,
  ) {
    this.policy = opts.policy ?? {};
    this.logger = opts.logger ?? consoleLogger();
    this.timeouts = {
      setup: opts.setupTimeoutMs ?? opts.policy?.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
      start: opts.startTimeoutMs ?? opts.policy?.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      stop: opts.stopTimeoutMs ?? opts.policy?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    };
    this.ready = new Promise<PluginManifest>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      resourceLimits: { ...DEFAULT_RESOURCE_LIMITS, ...opts.resourceLimits },
      workerData: { pluginFileUrl },
    });
    this.worker.on("message", (msg: WorkerOutMessage) => this.onMessage(msg));
    this.worker.on("error", (err: Error) => {
      this.failAll(`worker crashed: ${err.stack ?? err.message}`);
    });
    this.worker.on("exit", (code: number) => {
      this.exited = true;
      this.failAll(`worker exited (code ${code})`);
    });
  }

  /** Boot the worker and load a plugin module (absolute file path). */
  static async load(pluginFile: string, opts: IsolatedPluginSandboxOptions = {}): Promise<IsolatedPlugin> {
    const url = pathToFileURL(pluginFile).href;
    const sandbox = new IsolatedPluginSandbox(opts, url);
    const manifest = await sandbox.ready;
    return sandbox.asPlugin(manifest);
  }

  private asPlugin(manifest: PluginManifest): IsolatedPlugin {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- intentional: closed over by the handle below
    const self = this;
    const handle: IsolatedPlugin["sandbox"] = {
      policy: this.policy,
      audit: () => [...self.auditEntries],
      async terminate(): Promise<void> {
        await self.terminateWorker();
      },
      terminated: () => self.exited || self.workerTerminated,
    };

    return {
      manifest,
      sandbox: handle,
      setup: (ctx: PluginContext) => self.lifecycle("setup", ctx),
      start: () => self.lifecycle("start"),
      stop: () => self.lifecycle("stop", undefined, true),
    };
  }

  // ── host-side bridge ───────────────────────────────────────────────────

  private onMessage(msg: WorkerOutMessage): void {
    switch (msg.type) {
      case "ready":
        if (msg.manifest) {
          this.currentPluginId = msg.manifest.id;
          this.readyResolve(msg.manifest);
        }
        break;
      case "log":
        this.logger[msg.level ?? "info"](`[isolated] ${msg.msg ?? ""}`, msg.meta);
        break;
      case "call":
        this.onCall(msg.id!, msg.op!, msg.payload ?? {});
        break;
      case "fatal":
        this.fatal = msg.error ?? "unknown fatal error in sandbox worker";
        this.failAll(`sandbox worker fatal: ${this.fatal}`);
        break;
      default:
        break; // lifecycle results are handled by their own waiters
    }
  }

  private onCall(id: number, op: BridgeCallOp, payload: { token?: string; tag?: string; value?: unknown }): void {
    const reply = (ok: boolean, value?: unknown, error?: string): void => {
      this.worker.postMessage({ type: "result", id, ok, value, error });
    };
    const deny = (target: string, reason: string): void => {
      this.auditEntries.push({
        operation: op,
        target,
        decision: "denied",
        reason,
        at: new Date().toISOString(),
      });
      this.policy.onViolation?.({
        pluginId: this.currentPluginId ?? "(unloaded)",
        operation: op,
        target,
        reason,
        at: new Date().toISOString(),
      });
      reply(false, undefined, `sandbox denied ${op}("${target}"): ${reason}`);
    };
    const allow = (target: string): void => {
      this.auditEntries.push({
        operation: op,
        target,
        decision: "allowed",
        at: new Date().toISOString(),
      });
    };

    if (op === "provide") {
      const token = payload.token ?? "";
      const max = this.policy.maxProvides ?? DEFAULT_MAX_PROVIDES;
      if (this.provideCount >= max) {
        deny(token, `provide cap reached (${max})`);
        return;
      }
      if (!this.matches(token, this.policy.provide)) {
        deny(token, "token not in policy.provide allow-list");
        return;
      }
      this.provideCount++;
      allow(token);
      this.currentProvide?.(token, payload.value);
      reply(true);
      return;
    }
    if (op === "lookup") {
      const token = payload.token ?? "";
      if (!this.matches(token, this.policy.lookup)) {
        deny(token, "token not in policy.lookup allow-list");
        return;
      }
      let value: unknown;
      try {
        value = this.currentLookup?.(token);
      } catch (err) {
        deny(token, `host lookup threw: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      try {
        // Validate transferability BEFORE acking — postMessage throws on
        // non-cloneable values (functions, class instances, sockets, …).
        this.worker.postMessage({ type: "result", id, ok: true, value });
        allow(token);
      } catch {
        this.auditEntries.push({
          operation: "lookup",
          target: token,
          decision: "denied",
          reason: "capability value not structured-cloneable",
          at: new Date().toISOString(),
        });
        reply(false, undefined, `sandbox cannot transfer capability "${token}": value is not structured-cloneable`);
      }
      return;
    }
    // declareCapability
    const tag = payload.tag ?? "";
    if (!this.matches(tag, this.policy.declare)) {
      deny(tag, "tag not in policy.declare allow-list");
      return;
    }
    allow(tag);
    this.currentDeclare?.(tag);
    reply(true);
  }

  private matches(name: string, patterns: string[] | undefined): boolean {
    if (!patterns) return false;
    return patterns.some((p) => matchesPattern(name, p));
  }

  private failAll(reason: string): void {
    for (const reject of this.lifecycleWaiters) {
      reject(new Error(reason));
    }
    this.lifecycleWaiters.clear();
    try {
      this.readyReject(new Error(reason));
    } catch {
      /* ready already settled */
    }
  }

  private async lifecycle(
    phase: "setup" | "start" | "stop",
    ctx?: PluginContext,
    alwaysTerminate = false,
  ): Promise<void> {
    const pluginId = ctx?.manifest.id ?? this.currentPluginId ?? "(unloaded)";
    if (this.workerTerminated || this.exited) {
      throw new Error(
        `sandbox worker for plugin "${pluginId}" is no longer running${this.fatal ? `: ${this.fatal}` : ""}`,
      );
    }
    // Bind the bridge to the live host context for the duration of the call.
    if (ctx) {
      this.currentPluginId = ctx.manifest.id;
      this.currentProvide = (token, value) => ctx.provide(token, value);
      this.currentLookup = (token) => ctx.lookup<unknown>(token);
      this.currentDeclare = (tag) => ctx.declareCapability(tag);
    }

    const timeoutMs = this.timeouts[phase];
    const done = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: WorkerOutMessage): void => {
        if (msg.type === "lifecycle:done" && msg.phase === phase) {
          cleanup();
          resolve();
        } else if (msg.type === "lifecycle:error" && msg.phase === phase) {
          cleanup();
          reject(new Error(msg.error ?? "unknown error in sandboxed plugin"));
        }
      };
      const cleanup = (): void => {
        this.worker.off("message", onMessage);
        this.lifecycleWaiters.delete(reject);
      };
      this.lifecycleWaiters.add(reject);
      this.worker.on("message", onMessage);
    });

    this.worker.postMessage({ type: "lifecycle", phase });
    try {
      await withTimeout(done, timeoutMs);
    } catch (err) {
      // A hang or crash is unrecoverable for this worker — kill it so a
      // wedged plugin cannot leak a live isolate.
      await this.terminateWorker();
      if (isTimeoutError(err)) {
        throw new PluginSandboxTimeout(
          `isolated plugin "${pluginId}" ${phase} timed out after ${timeoutMs}ms`,
          pluginId,
          phase,
          timeoutMs,
        );
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this.currentProvide = undefined;
      this.currentLookup = undefined;
      this.currentDeclare = undefined;
    }
    if (alwaysTerminate) await this.terminateWorker();
  }

  private async terminateWorker(): Promise<void> {
    if (this.workerTerminated) return;
    this.workerTerminated = true;
    this.failAll("sandbox worker terminated");
    await this.worker.terminate().catch(() => undefined);
  }
}

function consoleLogger(): PluginLogger {
  return {
    debug: (msg, meta) => console.debug(`[sandbox] ${msg}`, meta ?? ""),
    info: (msg, meta) => console.info(`[sandbox] ${msg}`, meta ?? ""),
    warn: (msg, meta) => console.warn(`[sandbox] ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`[sandbox] ${msg}`, meta ?? ""),
  };
}
