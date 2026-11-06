/**
 * ExperienceIngestionBridge — wires every persisted episode into the
 * cross-session experience store. EVO-002.
 *
 * This module is the single bridge between the `src/learning` layer (which
 * writes `lessons.db`) and the `src/evolution/experience` layer (which writes
 * `experience.db`). Before this bridge existed, `experience.db` was written
 * to ONLY by `nexum evolve --mutate` (see audit: GAP-2). Now every graded
 * episode flows through `TrajectoryAnalyzer.toExperienceRecord` into the
 * store, so `EvidenceAggregator`, `TargetEngine`, and any future
 * success-pattern analysis operate on measured evidence instead of an empty
 * store.
 *
 * Safety properties (enforced here, documented in docs/evolution):
 *  1. Never throws — wraps every step in try/catch and logs via the supplied
 *     logger. A misconfigured store or an unreadable git repo degrades to a
 *     no-op, never poisons the lesson pipeline.
 *  2. Idempotent — `ExperienceStore.save` uses ON CONFLICT(episode_id) DO
 *     UPDATE, so re-ingesting the same episode (e.g. after a crash recovery)
 *     is safe.
 *  3. Non-blocking — `LearningEngine.process` calls the callback on its
 *     serialized `inFlight` chain, off the user-facing turn. The bridge
 *     itself is synchronous (better-sqlite3 is synchronous); the chain
 *     serializes it correctly.
 *  4. Lazy + cached — the `ExperienceStore` handle and the harness version
 *     are resolved once per workspace and cached. We do NOT `git rev-parse`
 *     per episode.
 *  5. Lifecycle-aware — `close()` must be called on shutdown to release the
 *     SQLite handle and let WAL checkpoint. The runtime (Agent.stopHost)
 *     owns this lifecycle.
 *  6. No circular dependency — `src/learning/engine.ts` depends only on the
 *     callback's *shape* (`(episode: Episode) => void`); this module is the
 *     one that imports from `src/evolution/experience`. The runtime wires
 *     this module into the engine via the `onEpisodePersisted` option.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Episode } from "./types.js";
import { ExperienceStore } from "../evolution/experience/experience-store.js";
import { TrajectoryAnalyzer } from "../evolution/experience/trajectory-analyzer.js";
import { workspaceStateDir } from "../platform/paths.js";

export interface ExperienceIngestionBridgeOptions {
  /** Workspace root (used to locate <state>/experience.db and git HEAD). */
  workspaceRoot: string;
  /**
   * Executor model id to bind to records. Defaults to "unknown"; the runtime
   * should pass the resolved model id (e.g. turnBudget.modelId) so that
   * cross-model evidence deltas work. EVO-041 will make this per-episode.
   */
  executorModel?: string;
  /** Optional logger; defaults to console. */
  logger?: Pick<Console, "info" | "warn">;
  /**
   * If false, the bridge is disabled (no store opened, no ingestion). Used
   * by tests and headless runs that don't want a second SQLite handle.
   */
  enabled?: boolean;
}

export class ExperienceIngestionBridge {
  private store: ExperienceStore | null = null;
  private analyzer: TrajectoryAnalyzer | null = null;
  private harnessVersion: string | null = null;
  private disabled = false;
  private readonly opts: Required<Omit<ExperienceIngestionBridgeOptions, "logger">> & {
    logger: Pick<Console, "info" | "warn">;
  };

  constructor(opts: ExperienceIngestionBridgeOptions) {
    this.opts = {
      workspaceRoot: opts.workspaceRoot,
      executorModel: opts.executorModel ?? "unknown",
      enabled: opts.enabled ?? true,
      logger: opts.logger ?? console,
    };
    if (!this.opts.enabled) {
      this.disabled = true;
      return;
    }
  }

  /**
   * The callback to pass into `LearningEngineOptions.onEpisodePersisted`.
   * Returns true if the episode was ingested, false if the bridge is disabled
   * or ingestion failed (failures are logged, never thrown).
   */
  ingest = (episode: Episode): void => {
    if (this.disabled) return;
    try {
      const store = this.getStore();
      const analyzer = this.getAnalyzer();
      const record = analyzer.toExperienceRecord(episode);
      store.save(record);
    } catch (err) {
      // Never throw into the lesson pipeline. Log once and disable the
      // bridge for the lifetime of this engine so we don't spam the log on
      // every subsequent episode.
      this.opts.logger.warn(`[Learning] experience ingestion disabled: ${err instanceof Error ? err.message : err}`);
      this.disabled = true;
    }
  };

  /** Releases the SQLite handle. Call on shutdown (Agent.stopHost). */
  close(): void {
    if (this.store) {
      try {
        this.store.close();
      } catch {
        // best-effort
      }
      this.store = null;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private getStore(): ExperienceStore {
    if (this.store) return this.store;
    const dbPath = join(workspaceStateDir(this.opts.workspaceRoot), "experience.db");
    this.store = new ExperienceStore(dbPath);
    return this.store;
  }

  private getAnalyzer(): TrajectoryAnalyzer {
    if (this.analyzer) return this.analyzer;
    this.analyzer = new TrajectoryAnalyzer({
      executorModel: this.opts.executorModel,
      harnessVersion: this.resolveHarnessVersion(),
    });
    return this.analyzer;
  }

  /**
   * Resolves the harness version once per workspace and caches it. Falls back
   * to "unversioned" outside a git repo (matching TrajectoryAnalyzer's
   * default). We deliberately do NOT re-resolve per episode: the version is
   * pinned at bridge construction, which is correct because all episodes in
   * one process run under the same harness.
   */
  private resolveHarnessVersion(): string {
    if (this.harnessVersion !== null) return this.harnessVersion;
    let version = "unversioned";
    try {
      if (existsSync(join(this.opts.workspaceRoot, ".git"))) {
        const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
          cwd: this.opts.workspaceRoot,
          encoding: "utf8",
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out) version = out;
      }
    } catch {
      // Outside a git repo, or git not available. Fall back to unversioned.
    }
    this.harnessVersion = version;
    return version;
  }
}
