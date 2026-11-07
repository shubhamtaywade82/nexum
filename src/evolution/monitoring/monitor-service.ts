/**
 * ContinuousMonitorService — live post-activation monitoring (v2.4).
 *
 * `nexum evolve --monitor` was a one-shot verdict over a static telemetry
 * file: it told you whether the active harness LOOKED healthy at that moment,
 * then exited. Real regression detection needs something still running when
 * the regression happens. This service:
 *
 *   1. TAILS a JSONL telemetry file (only newline-terminated lines are
 *      consumed, so a half-written sample is never evaluated),
 *   2. ingests every new sample into the ActivationMonitor,
 *   3. evaluates health on every batch through an injected callback — in the
 *      CLI this is `engine.evaluateActivationLive(experimentId)`, which also
 *      drives the ACTIVE → REGRESSED → ROLLBACK path automatically,
 *   4. keeps polling until stop().
 *
 * The service owns only the loop; the monitor instance and the evaluation
 * callback are injected so the wiring stays testable without timers or files.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { ActivationHealth, ActivationMonitor, OperationalTelemetry } from "./activation-monitor.js";

export interface TelemetryPollResult {
  /** Complete new samples parsed since the previous offset. */
  samples: OperationalTelemetry[];
  /** Byte offset to carry into the next poll. */
  offset: number;
}

/**
 * Reads telemetry appended to a JSONL file since `previousOffset`.
 * A trailing line without a newline is treated as still being written and
 * left for the next poll.
 */
export function pollTelemetryFile(path: string, previousOffset = 0): TelemetryPollResult {
  if (!existsSync(path)) return { samples: [], offset: previousOffset };
  const size = statSync(path).size;
  if (size <= previousOffset) return { samples: [], offset: previousOffset };

  const buffer = readFileSync(path);
  const chunk = buffer.subarray(previousOffset).toString("utf8");
  const lines = chunk.split("\n");
  // The element after the final "\n" is either "" (clean EOF) or a possibly
  // incomplete line that must not be consumed yet.
  const trailing = lines[lines.length - 1];
  const completeLines = lines.slice(0, -1);

  const samples: OperationalTelemetry[] = [];
  for (const line of completeLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      samples.push(JSON.parse(trimmed) as OperationalTelemetry);
    } catch {
      // A malformed line is skipped (and consumed) rather than fatal: one
      // corrupt sample must not blind the monitor forever.
    }
  }

  const offset =
    trailing === "" ? buffer.length : Math.max(previousOffset, buffer.length - Buffer.byteLength(trailing, "utf8"));
  return { samples, offset };
}

export interface ContinuousMonitorServiceOptions {
  /** JSONL telemetry file to tail. */
  telemetryPath: string;
  /** The monitor instance samples are ingested into (shared with the engine). */
  monitor: ActivationMonitor;
  /**
   * Evaluates health after each batch. Wire this to
   * `engine.evaluateActivationLive(experimentId)` for automatic rollback on
   * regression, or `monitor.evaluate(harnessId)` for reporting-only mode.
   * May be async (the engine path performs the rollback, which can await).
   */
  evaluate: (monitor: ActivationMonitor) => ActivationHealth | null | Promise<ActivationHealth | null>;
  /** Poll interval (default 60s). */
  intervalMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  logger?: { log: (message: string) => void; error: (message: string) => void };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ContinuousMonitorService {
  private readonly telemetryPath: string;
  private readonly monitor: ActivationMonitor;
  private readonly evaluate: ContinuousMonitorServiceOptions["evaluate"];
  private readonly intervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: { log: (m: string) => void; error: (m: string) => void };
  private stopped = false;
  private offset = 0;
  private lastHealth: ActivationHealth | null = null;

  constructor(opts: ContinuousMonitorServiceOptions) {
    this.telemetryPath = opts.telemetryPath;
    this.monitor = opts.monitor;
    this.evaluate = opts.evaluate;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.logger = opts.logger ?? { log: console.log, error: console.error };
  }

  /** Requests the loop to exit after the current poll (SIGINT-safe). */
  stop(): void {
    this.stopped = true;
  }

  /** Latest verdict seen by the service (null before the first batch). */
  currentHealth(): ActivationHealth | null {
    return this.lastHealth;
  }

  /**
   * Runs the poll→ingest→evaluate loop until stop() is called. Returns the
   * last observed health verdict.
   */
  async start(): Promise<ActivationHealth | null> {
    this.logger.log(
      `[Monitor] Watching ${this.telemetryPath} every ${Math.round(this.intervalMs / 1000)}s (Ctrl-C to stop).`,
    );
    while (!this.stopped) {
      let samples: OperationalTelemetry[] = [];
      try {
        const polled = pollTelemetryFile(this.telemetryPath, this.offset);
        this.offset = polled.offset;
        samples = polled.samples;
      } catch (err) {
        this.logger.error(`[Monitor] Telemetry poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (samples.length > 0) {
        for (const sample of samples) this.monitor.ingest(sample);
        try {
          this.lastHealth = await this.evaluate(this.monitor);
          if (this.lastHealth) {
            this.logger.log(
              `[Monitor] ${new Date(sampleAt(samples)).toISOString()} harness=${this.lastHealth.harnessId} status=${this.lastHealth.status.toUpperCase()} episodes=${this.lastHealth.sampleEpisodes}`,
            );
            if (this.lastHealth.status === "regressed") {
              this.logger.error(`[Monitor] REGRESSION DETECTED: ${this.lastHealth.rationale}`);
            }
          }
        } catch (err) {
          this.logger.error(`[Monitor] Health evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!this.stopped) await this.sleep(this.intervalMs);
    }
    this.logger.log("[Monitor] Stopped.");
    return this.lastHealth;
  }
}

function sampleAt(samples: OperationalTelemetry[]): number {
  return samples.length > 0 ? samples[samples.length - 1].at : Date.now();
}
