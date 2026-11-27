/**
 * EvidenceRef resolution service (SPEC §5.2 / ROADMAP P2).
 *
 * Agents exchange references; a reference that does not resolve against its
 * store is a CONTRACT VIOLATION (SPEC §4.1 grounding rule 2), surfaced as
 * such — never silently dropped, never silently widened.
 *
 * Resolvable families:
 *   artifact:${id}   → ReportArtifactStore (mission artifacts, P2) — and the
 *                      existing content-addressed ArtifactStore when supplied
 *   event:${id}      → a lookup of persisted EventEnvelope ids (the recorder
 *                      store or an in-memory index in tests)
 *   run:${id}        → run ids known to the execution history
 *   checkpoint:${id} → mission checkpoint ids (P6 lands the store; until
 *                      then a lookup function may be supplied)
 *
 * Layering: src/orchestration/mission/** imports only core + node builtins.
 */

import type { ReportArtifactStore } from "./report-artifacts.js";
import type { EvidenceRef } from "./events.js";

export type RefFamily = "artifact" | "event" | "run" | "checkpoint";

export function refFamily(ref: EvidenceRef): RefFamily {
  return ref.slice(0, ref.indexOf(":")) as RefFamily;
}

export function refId(ref: EvidenceRef): string {
  return ref.slice(ref.indexOf(":") + 1);
}

export interface RefResolution {
  ok: boolean;
  ref: EvidenceRef;
  /** Populated when ok — where it resolved (family store). */
  resolvedVia?: RefFamily;
  /** Populated when !ok — the contract violation description. */
  violation?: string;
}

export interface EvidenceResolverOptions {
  artifacts?: ReportArtifactStore;
  /** Existing content-addressed artifact store (ids without `ma_` prefix). */
  lookupArtifact?: (id: string) => boolean;
  lookupEvent?: (id: string) => boolean;
  lookupRun?: (id: string) => boolean;
  lookupCheckpoint?: (id: string) => boolean;
}

export class EvidenceResolver {
  private readonly artifacts?: ReportArtifactStore;
  private readonly lookups: Record<RefFamily, ((id: string) => boolean) | undefined>;

  constructor(opts: EvidenceResolverOptions = {}) {
    this.artifacts = opts.artifacts;
    this.lookups = {
      artifact: opts.lookupArtifact,
      event: opts.lookupEvent,
      run: opts.lookupRun,
      checkpoint: opts.lookupCheckpoint,
    };
  }

  /** Resolve one ref; unresolvable refs are contract violations, not errors to swallow. */
  resolve(ref: EvidenceRef): RefResolution {
    const family = refFamily(ref);
    const id = refId(ref);
    if (family === "artifact" && this.artifacts) {
      const read = this.artifacts.read(id);
      if (read.ok) return { ok: true, ref, resolvedVia: family };
      // fall through to an external artifact lookup if the mission store misses
      if (this.lookups.artifact?.(id)) return { ok: true, ref, resolvedVia: family };
      return { ok: false, ref, violation: `artifact ${id} not found in mission artifact store: ${read.reason}` };
    }
    const lookup = this.lookups[family];
    if (!lookup) {
      return { ok: false, ref, violation: `no ${family} store configured to resolve ${ref}` };
    }
    if (lookup(id)) return { ok: true, ref, resolvedVia: family };
    return { ok: false, ref, violation: `${family} ${id} does not resolve: contract violation (evidence must exist)` };
  }

  /** Resolve all refs; ok only when every ref resolves. Violations listed per ref. */
  resolveAll(refs: EvidenceRef[]): { ok: boolean; resolutions: RefResolution[] } {
    const resolutions = refs.map((r) => this.resolve(r));
    return { ok: resolutions.every((r) => r.ok), resolutions };
  }
}
