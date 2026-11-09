/**
 * The evolution bench: the stores a closed-loop run reads and writes, and the one assembly of the engine
 * over them.
 *
 * Before this, seven call sites built ClosedLoopEngine themselves. They drifted: the parallel path shared one
 * experiment controller, and a single-engine path built without one, so its experiment provenance was not
 * wired the same way. Every engine is now built here, and the experiment controller is always wired to the
 * bench's own experiment store. A caller that must share one controller across engines passes it explicitly.
 */
import { join } from "node:path";
import { ClosedLoopEngine, type ClosedLoopEngineOptions } from "./engine-v2.js";
import { ExperienceStore } from "./experience/experience-store.js";
import { ExperimentController } from "./experiments/experiment-controller.js";
import { ExperimentStore } from "./experiments/experiment-store.js";

export interface EvolutionBench {
  readonly experience: ExperienceStore;
  readonly experiments: ExperimentStore;
  /** The one assembly of the closed-loop engine. Role-specific options are the only thing a caller adds. */
  engine(options?: Omit<ClosedLoopEngineOptions, "experienceStore" | "experimentController">): ClosedLoopEngine;
  /** Engine with a controller the caller shares across engines (the parallel coordinator). */
  engineSharing(
    experimentController: ExperimentController,
    options?: Omit<ClosedLoopEngineOptions, "experienceStore" | "experimentController">,
  ): ClosedLoopEngine;
  close(): void;
}

export function openEvolutionBench(stateDir: string): EvolutionBench {
  const experience = new ExperienceStore(join(stateDir, "experience.db"));
  const experiments = new ExperimentStore(join(stateDir, "experiments.db"));
  const engineSharing = (
    experimentController: ExperimentController,
    options: Omit<ClosedLoopEngineOptions, "experienceStore" | "experimentController"> = {},
  ): ClosedLoopEngine => new ClosedLoopEngine({ ...options, experienceStore: experience, experimentController });
  return {
    experience,
    experiments,
    engine: (options = {}) => engineSharing(new ExperimentController({ store: experiments }), options),
    engineSharing,
    close(): void {
      experience.close();
      experiments.close();
    },
  };
}
