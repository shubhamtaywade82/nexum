import { MemoryStore } from "../memory/store.js";
import { LearningEngine } from "../learning/index.js";
import { ExperienceIngestionBridge } from "../learning/experience-bridge.js";
import { SkillsRegistry } from "../skills/registry.js";
import { SkillContent } from "../skills/types.js";
import { Provider } from "../models/adapters/provider.js";

export interface AgentLearningOptions {
  workspaceRoot: string;
  provider: Provider;
  memory: MemoryStore;
  skillsHomeDir?: string;
  projectLanguage?: string;
  /**
   * Executor model id to bind to experience records. Passed through to the
   * ExperienceIngestionBridge so cross-model evidence deltas work. EVO-041
   * will make this per-episode; for now it is pinned at construction.
   */
  executorModel?: string;
  /**
   * If false, the experience-ingestion bridge is not constructed. Defaults
   * to true. Tests that don't want a second SQLite handle can opt out.
   */
  enableExperienceIngestion?: boolean;
}

export class AgentLearning {
  readonly memory: MemoryStore;
  readonly learning: LearningEngine;
  readonly skills: SkillsRegistry;
  /** EVO-002 bridge: every persisted episode → experience.db. Owned here for close() on shutdown. */
  private readonly experienceBridge: ExperienceIngestionBridge | null;
  pinnedSkillId: string | null = null;

  constructor(opts: AgentLearningOptions) {
    this.memory = opts.memory;
    const enableBridge = opts.enableExperienceIngestion ?? true;
    this.experienceBridge = enableBridge
      ? new ExperienceIngestionBridge({
          workspaceRoot: opts.workspaceRoot,
          executorModel: opts.executorModel,
        })
      : null;
    this.learning = new LearningEngine({
      workspaceRoot: opts.workspaceRoot,
      provider: opts.provider,
      memory: opts.memory,
      onEpisodePersisted: this.experienceBridge?.ingest,
    });
    this.skills = SkillsRegistry.discover(
      { workspaceRoot: opts.workspaceRoot, homeDir: opts.skillsHomeDir },
      opts.projectLanguage,
    );
  }

  /** Releases the experience-store SQLite handle. Call on shutdown. */
  closeExperienceBridge(): void {
    this.experienceBridge?.close();
  }

  getLearnings(): Array<{ category: string; lesson: string }> {
    return this.memory.getLearnings().map((l) => ({
      category: l.category,
      lesson: l.lesson,
    }));
  }

  resolveForPrompt(userMessage: string): SkillContent[] {
    if (this.pinnedSkillId) {
      const skill = this.skills.activate(this.pinnedSkillId);
      return skill ? [skill] : [];
    }
    return this.skills.resolveForPrompt(userMessage);
  }

  pinSkill(id: string | null): void {
    this.pinnedSkillId = id;
  }

  getSkillsRegistry(): SkillsRegistry {
    return this.skills;
  }

  flushLearning(): Promise<void> {
    return this.learning.flush();
  }

  addLearning(category: string, context: string, lesson: string): void {
    this.memory.addLearning(category, context, lesson);
  }

  recordSkillUse(skillId: string, success: boolean): void {
    this.memory.recordSkillUse(skillId, success);
  }

  appendMessage(role: string, content: string): void {
    this.memory.appendMessage(role, content);
  }
}
