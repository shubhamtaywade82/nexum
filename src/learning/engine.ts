import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryStore } from "../memory/store.js";
import { Provider } from "../models/adapters/provider.js";
import { EpisodeRecorder } from "./episode-recorder.js";
import { gradeEpisode } from "./grader.js";
import { LessonStore } from "./lesson-store.js";
import { reflect } from "./reflector.js";
import { SkillSynthesizer } from "./skill-synthesizer.js";
import { Episode } from "./types.js";
import { workspaceStateDir } from "../platform/paths.js";

export interface LearningEngineOptions {
  workspaceRoot: string;
  provider: Provider;
  memory: MemoryStore;
  /** Reflect on at most every Nth episode when the episode was a clean success. */
  reflectSuccessEveryN?: number;
  logger?: Pick<Console, "info" | "warn">;
  /**
   * Optional experience-layer ingestor; called once per persisted episode, on
   * the serialized `inFlight` chain (so it never blocks the user-facing turn
   * and never throws into it). EVO-002: closes the structural break between
   * `lessons.db` (this layer) and `experience.db` (the evolution layer) by
   * having the runtime wire a {@link ExperienceIngestionBridge} here.
   *
   * The callback MUST:
   *  - never throw (wrap all work in try/catch; this engine swallows errors
   *    via the `inFlight` chain's `.catch`, but the callback should still be
   *    defensive so a misconfigured store does not poison the lesson pipeline);
   *  - be idempotent (`ExperienceStore.save` uses ON CONFLICT(episode_id));
   *  - not block on network or long IO.
   */
  onEpisodePersisted?: (episode: Episode) => void;
}

/**
 * Owns the full loop: record → grade → reflect → absorb → synthesize/prune.
 * Background work is serialized and swallowed so learning never adds latency
 * to, or throws into, the user-facing turn.
 */
export class LearningEngine {
  readonly recorder = new EpisodeRecorder();
  private readonly lessons: LessonStore;
  private readonly synthesizer: SkillSynthesizer;
  private readonly reflectSuccessEveryN: number;
  private readonly logger: Pick<Console, "info" | "warn">;
  private readonly onEpisodePersisted?: (episode: Episode) => void;
  private successCounter = 0;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly opts: LearningEngineOptions) {
    const dbPath = join(workspaceStateDir(opts.workspaceRoot), "lessons.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.lessons = new LessonStore(dbPath);
    this.synthesizer = new SkillSynthesizer(opts.workspaceRoot, this.lessons, opts.logger);
    this.reflectSuccessEveryN = opts.reflectSuccessEveryN ?? 4;
    this.logger = opts.logger ?? console;
    this.onEpisodePersisted = opts.onEpisodePersisted;
  }

  onEpisodeEnd(terminal: Episode["terminal"], finalText: string): void {
    const episode = this.recorder.end(terminal, finalText);
    if (!episode) return;
    this.inFlight = this.inFlight
      .then(() => this.process(episode))
      .catch((error) => {
        this.logger.warn(`[Learning] pipeline error: ${error instanceof Error ? error.message : error}`);
      });
  }

  flush(): Promise<void> {
    return this.inFlight;
  }

  getLessonStore(): LessonStore {
    return this.lessons;
  }

  close(): void {
    this.lessons.close();
  }

  private async process(episode: Episode): Promise<void> {
    episode.grade = gradeEpisode(episode);
    this.lessons.recordEpisode({
      id: episode.id,
      goal: episode.goal,
      verdict: episode.grade.verdict,
      score: episode.grade.score,
      terminal: episode.terminal,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
      toolEventCount: episode.toolEvents.length,
      payload: JSON.stringify(episode),
    });

    // EVO-002: bridge every persisted episode into the cross-session
    // experience store so the evolution layer's TrajectoryAnalyzer,
    // EvidenceAggregator, and TargetEngine operate on measured evidence
    // instead of an empty store. The callback is wired by the runtime
    // (ExperienceIngestionBridge) and MUST NOT throw — it runs on the
    // serialized inFlight chain, so a throw here would be swallowed by the
    // .catch in onEpisodeEnd, but we still guard so a misconfigured store
    // can't poison the downstream reflection/synthesis steps.
    if (this.onEpisodePersisted) {
      try {
        this.onEpisodePersisted(episode);
      } catch (err) {
        this.logger.warn(
          `[Learning] experience ingestion failed for ${episode.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const shouldReflect =
      episode.grade.verdict !== "success" || ++this.successCounter % this.reflectSuccessEveryN === 0;
    if (!shouldReflect || episode.toolEvents.length === 0) return;

    const reflection = await reflect(this.opts.provider, episode);
    if (!reflection.lessons.length) return;

    const weight = episode.grade.verdict === "success" ? 0.4 : 0.25;
    const touched = this.lessons.absorb(reflection, episode.id, weight);
    this.logger.info(`[Learning] absorbed ${touched.length} lesson(s) from ${episode.grade.verdict} episode`);

    const report = this.synthesizer.run(this.opts.memory.allSkillUsage());
    if (report.createdOrUpdated.length || report.demoted.length) this.lessons.sweep();
  }
}
