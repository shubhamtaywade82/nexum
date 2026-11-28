/**
 * MAC v1 P7 — labeled-outcome records (SPEC §15.3 / §6 rule 3).
 *
 * For every prediction subject, the eventual outcome is recorded at mission
 * termination (`predicted` vs `actual`, with evidence refs) — the raw material
 * for calibration. The store is:
 *
 *   - append-only (jsonl, one record per line);
 *   - idempotent per `labelId` (a deterministic id — re-running the
 *     deterministic suite does NOT inflate the dataset: honest accumulation);
 *   - retention-guaranteeing: per subject at least `MIN_LABELED_OUTCOMES`
 *     records are always retained (SPEC §6 rule 3 — labeled outcomes are
 *     retained for calibration; the ≥ 100 minimum is the gate for any
 *     `probability` field in production profiles, INV-9).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LabeledOutcome, MultiAgentSubject } from "./types.js";
import { MIN_LABELED_OUTCOMES } from "./metrics.js";

/** Where the deterministic suite persists labels (under the eval out dir). */
export const LABELED_OUTCOMES_FILENAME = "labeled-outcomes.jsonl";

export class LabeledOutcomeStore {
  private readonly path: string;
  private readonly byId = new Map<string, LabeledOutcome>();

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed) as LabeledOutcome;
          if (typeof record.labelId === "string") this.byId.set(record.labelId, record);
        } catch {
          // corrupt line: skipped on load; never crashes an evaluation
        }
      }
    }
  }

  /** All records, insertion order (a copy — never the live map). */
  load(): LabeledOutcome[] {
    return [...this.byId.values()];
  }

  /**
   * Append a label — idempotent per labelId: a repeated deterministic run
   * re-records the same id and does not double-count. Returns true when the
   * store changed.
   */
  append(label: LabeledOutcome): boolean {
    if (this.byId.has(label.labelId)) {
      const existing = this.byId.get(label.labelId) as LabeledOutcome;
      const same =
        existing.subject === label.subject &&
        existing.predicted === label.predicted &&
        existing.actual === label.actual;
      if (same) return false;
      // Same id, different content: a fixture changed — replace honestly
      // (the old record is superseded in the file, the map keeps the newest).
    }
    this.byId.set(label.labelId, label);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(label)}\n`);
    return true;
  }

  appendAll(labels: LabeledOutcome[]): number {
    let appended = 0;
    for (const label of labels) {
      if (this.append(label)) appended += 1;
    }
    return appended;
  }

  /** Labels scoped to one subject. */
  forSubject(subject: MultiAgentSubject): LabeledOutcome[] {
    return this.load().filter((l) => l.subject === subject);
  }

  /**
   * Retention (SPEC §6 rule 3): labeled outcomes are retained for calibration
   * with a minimum of MIN_LABELED_OUTCOMES records per subject — the store
   * never prunes below that, so the answer to "does the dataset exist" only
   * moves in one direction per subject.
   */
  retentionGuarantee(): Record<MultiAgentSubject, number> {
    const counts = {
      tracker: 0,
      predictor: 0,
      commander: 0,
      runtime: 0,
      mission: 0,
    } as Record<MultiAgentSubject, number>;
    for (const label of this.load()) counts[label.subject] += 1;
    return counts;
  }

  /** The ≥ 100 rule: only a covered subject may carry `probability`. */
  datasetUsable(subject: MultiAgentSubject): boolean {
    return this.forSubject(subject).length >= MIN_LABELED_OUTCOMES;
  }
}
