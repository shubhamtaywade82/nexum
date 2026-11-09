/**
 * The evolution bench is the one place a closed-loop engine is assembled. Every engine it builds is wired to the
 * bench's own experiment store, so experiment provenance cannot be left out by one call site.
 */
import { describe, it, expect, afterEach, beforeEach } from "@jest/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEvolutionBench, type EvolutionBench } from "../../src/evolution/bench.js";
import { ExperimentController } from "../../src/evolution/experiments/experiment-controller.js";
import { ExperimentStore } from "../../src/evolution/experiments/experiment-store.js";

let stateDir: string;
let bench: EvolutionBench | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "bench-"));
});

afterEach(() => {
  bench?.close();
  bench = undefined;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("openEvolutionBench", () => {
  it("opens the experience and experiment stores under the state directory", () => {
    bench = openEvolutionBench(stateDir);
    expect(existsSync(join(stateDir, "experience.db"))).toBe(true);
    expect(existsSync(join(stateDir, "experiments.db"))).toBe(true);
  });

  it("wires every engine it builds to the bench's own experiment store", () => {
    bench = openEvolutionBench(stateDir);
    const engine = bench.engine() as unknown as { experiments: ExperimentController };
    expect(engine.experiments).toBeInstanceOf(ExperimentController);
    expect(engine.experiments).not.toBeUndefined();
  });

  it("shares a caller's controller when asked, instead of building its own", () => {
    bench = openEvolutionBench(stateDir);
    const shared = new ExperimentController({ store: bench.experiments });
    const engine = bench.engineSharing(shared) as unknown as { experiments: ExperimentController };
    expect(engine.experiments).toBe(shared);
  });

  it("closes both stores", () => {
    const opened = openEvolutionBench(stateDir);
    opened.close();
    expect(() => new ExperimentStore(join(stateDir, "experiments.db")).listAll()).not.toThrow();
  });
});
