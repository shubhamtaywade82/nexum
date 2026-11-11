import { MemoryStore } from "../memory/store.js";
import { LearningEngine } from "../learning/index.js";
import { ExperienceIngestionBridge } from "../learning/experience-bridge.js";
import { SkillsRegistry } from "../skills/registry.js";
import { SkillContent } from "../skills/types.js";
import type { ChatPort } from "../models/gateway/inference-dispatcher.js";
import { keepTrustForNexumWrite, WorkspaceTrustStore, workspaceDigest, workspaceSkillGate } from "./workspace-trust.js";

export interface AgentLearningOptions {
  workspaceRoot: string;
  provider: ChatPort;
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
  /** Trust decisions for the workspace's own skills. Defaults to the global store. */
  trustStore?: WorkspaceTrustStore;
}

export class AgentLearning {
  readonly memory: MemoryStore;
  readonly learning: LearningEngine;
  /** EVO-002 bridge: every persisted episode → experience.db. Owned here for close() on shutdown. */
  private readonly experienceBridge: ExperienceIngestionBridge | null;
  private readonly trustStore: WorkspaceTrustStore;
  /** Assigned by refreshSkills(), which the constructor runs before anything reads it. */
  private skills!: SkillsRegistry;
  /** Fingerprint of the discovery inputs (gate + trust-bearing files) the current registry was built from. */
  private skillsKey = "";
  private withheldReason: string | null = null;
  private lastNotifiedReason: string | null = null;
  pinnedSkillId: string | null = null;

  constructor(private readonly opts: AgentLearningOptions) {
    this.memory = opts.memory;
    this.trustStore = opts.trustStore ?? WorkspaceTrustStore.global();
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
      guardSkillWrite: keepTrustForNexumWrite(opts.workspaceRoot, this.trustStore),
    });
    this.refreshSkills();
  }

  /**
   * Rebuilds the skills registry when the workspace's skill gate or any
   * trust-bearing file changed, so `nexum trust` and a pulled skill both take
   * effect on the next turn. Cheap when nothing changed (one digest).
   */
  private refreshSkills(): void {
    const root = this.opts.workspaceRoot;
    const gate = workspaceSkillGate(root, this.trustStore);
    const key = `${gate.allowed ? "open" : "withheld"}:${workspaceDigest(root).digest}`;
    if (key === this.skillsKey) return;
    this.skillsKey = key;
    this.skills = SkillsRegistry.discover(
      { workspaceRoot: root, homeDir: this.opts.skillsHomeDir, workspaceTrusted: gate.allowed },
      this.opts.projectLanguage,
    );
    this.withheldReason = gate.allowed ? null : (gate.reason ?? null);
  }

  /** The reason the workspace's skills are currently withheld, or null when they load. */
  skillsWithheldReason(): string | null {
    this.refreshSkills();
    return this.withheldReason;
  }

  /**
   * The withheld reason once per change, for a one-line status notice. Returns
   * null when skills load or the same reason was already reported.
   */
  takeWithheldNotice(): string | null {
    const reason = this.skillsWithheldReason();
    if (reason === this.lastNotifiedReason) return null;
    this.lastNotifiedReason = reason;
    return reason;
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
    this.refreshSkills();
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
    this.refreshSkills();
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
