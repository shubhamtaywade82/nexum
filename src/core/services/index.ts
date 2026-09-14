/**
 * Unified Service Registry — a typed registry for long-lived services.
 *
 * Nexum already has many implicit services (ModelStack, SessionManager,
 * ApprovalManager, ExecutionManager in cli/services/). Today each is
 * constructed ad-hoc in the composition root and passed around by hand.
 *
 * The ServiceRegistry formalizes this pattern:
 *   - Services register themselves by a typed `ServiceToken<T>`.
 *   - Any code with a reference to the registry can `require(SOME_TOKEN)`.
 *   - Lifecycle is explicit: `start()` / `stop()` for services that own
 *     resources (DBs, sockets, child processes).
 *
 * The registry does NOT replace the PluginHost — it is the *capability map*
 * that plugins populate. A plugin's `setup()` typically does:
 *
 *   ctx.provide(JOB_SERVICE.id, jobs);
 *   // and equivalently, if the plugin wants to participate in lifecycle:
 *   services.register(JOB_SERVICE, jobs);
 *
 * For non-plugin embedding (library use of Nexum), the ServiceRegistry can
 * be used directly without the plugin host.
 */

import type { CapabilityToken } from "../capabilities/index.js";

/** A service token is just a capability token with a lifecycle. */
export type ServiceToken<T> = CapabilityToken<T>;

export interface ServiceLifecycle {
  /** Start the service (acquire resources, open connections, etc.). */
  start?(): Promise<void> | void;
  /** Stop the service (release resources, close connections, etc.). */
  stop?(): Promise<void> | void;
  /** Human-facing name for diagnostics. */
  readonly name?: string;
}

export interface ServiceRecord<T> {
  token: ServiceToken<T>;
  instance: T;
  lifecycle?: ServiceLifecycle;
  state: ServiceState;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
}

export type ServiceState = "registered" | "starting" | "running" | "stopping" | "stopped" | "error";

export class ServiceRegistry {
  private readonly services = new Map<string, ServiceRecord<unknown>>();
  private started = false;

  register<T>(token: ServiceToken<T>, instance: T, lifecycle?: ServiceLifecycle): this {
    if (this.services.has(token.id)) {
      throw new Error(`service "${token.id}" is already registered`);
    }
    this.services.set(token.id, {
      token,
      instance,
      lifecycle,
      state: "registered",
    });
    return this;
  }

  unregister<T>(token: ServiceToken<T>): boolean {
    return this.services.delete(token.id);
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.services.has(token.id);
  }

  get<T>(token: ServiceToken<T>): T | undefined {
    const rec = this.services.get(token.id);
    return rec?.instance as T | undefined;
  }

  require<T>(token: ServiceToken<T>): T {
    const rec = this.services.get(token.id);
    if (!rec) {
      throw new Error(
        `required service "${token.id}" is not registered. ` +
          `Available: ${[...this.services.keys()].sort().join(", ") || "(none)"}`,
      );
    }
    return rec.instance as T;
  }

  record<T>(token: ServiceToken<T>): ServiceRecord<T> | undefined {
    return this.services.get(token.id) as ServiceRecord<T> | undefined;
  }

  ids(): string[] {
    return [...this.services.keys()];
  }

  all(): ServiceRecord<unknown>[] {
    return [...this.services.values()];
  }

  /** Start all registered services that have a lifecycle.start(). */
  async start(): Promise<void> {
    if (this.started) return;
    for (const [id, rec] of this.services.entries()) {
      if (!rec.lifecycle?.start) continue;
      this.transition(id, "starting");
      try {
        await rec.lifecycle.start();
        this.transition(id, "running", { startedAt: new Date().toISOString() });
      } catch (err) {
        this.transition(id, "error", { error: errMessage(err) });
      }
    }
    this.started = true;
  }

  /** Stop all services in reverse registration order. */
  async stop(): Promise<void> {
    if (!this.started) return;
    const entries = [...this.services.entries()].reverse();
    for (const [id, rec] of entries) {
      if (!rec.lifecycle?.stop) continue;
      if (rec.state !== "running" && rec.state !== "error") continue;
      this.transition(id, "stopping");
      try {
        await rec.lifecycle.stop();
        this.transition(id, "stopped", { stoppedAt: new Date().toISOString() });
      } catch (err) {
        this.transition(id, "error", { error: errMessage(err) });
      }
    }
    this.started = false;
  }

  private transition(id: string, state: ServiceState, extra?: Partial<ServiceRecord<unknown>>): void {
    const rec = this.services.get(id);
    if (!rec) return;
    this.services.set(id, { ...rec, state, ...extra });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
