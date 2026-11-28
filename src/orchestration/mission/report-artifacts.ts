/**
 * MAC v1 report artifacts (SPEC §5.3) — P2.
 *
 * Every role report is persisted as an IMMUTABLE artifact following the
 * experiment-artifact pattern (src/evolution/experiments/experiment-artifact.ts):
 *
 *   - written exclusively (`wx` — an existing artifact is NEVER overwritten);
 *   - never mutated: superseding means writing a NEW artifact with a fresh id;
 *   - self-hashed (sha256 over the canonical payload) — integrity detection,
 *     explicitly NOT tamper-proof (same caveat as evolution artifacts);
 *   - schema-validated (zod) BEFORE write; invalid payloads are rejected
 *     fail-closed.
 *
 * Layering: src/orchestration/mission/** must not import ui, agents or
 * domains (tests/architecture/mission-layering.test.ts). This module uses
 * only node:fs/crypto + zod.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const REPORT_ARTIFACT_SCHEMA_VERSION = 1;

export type ReportArtifactKind =
  "tracker-report" | "prediction-report" | "commander-decision" | "verification-evidence" | "mission-report";

/** SPEC §5.3 envelope. */
export interface ReportArtifact<T = unknown> {
  artifactId: string; // `ma_` + uuid
  kind: ReportArtifactKind;
  missionId: string;
  missionSeq: number; // monotonic per mission
  createdAt: string; // ISO 8601
  payload: T; // schema-validated before write
  sha256: string; // integrity self-hash
  /** Set when this artifact supersedes an earlier one (never mutate in place). */
  supersedes?: string;
  schemaVersion: number;
}

export function newArtifactId(): string {
  return `ma_${randomUUID()}`;
}

/** Canonical serialization for hashing (stable key order, no reformatting surprises). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

/** sha256 over the canonical payload — matches the experiment-artifact idiom. */
export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export interface WriteReportArtifactOptions {
  /** Schema the payload must satisfy (fail-closed when it does not). */
  payloadSchema?: z.ZodTypeAny;
  /** Artifact this one replaces; recorded, the original is left untouched. */
  supersedes?: string;
  /** ISO timestamp override (tests). */
  createdAt?: string;
}

export interface WriteResult {
  ok: true;
  artifact: ReportArtifact;
}

export interface WriteRejection {
  ok: false;
  reason: string;
}

/** Wrap an artifact payload in the SPEC §5.3 envelope (no I/O). */
export function buildReportArtifact<T>(
  kind: ReportArtifactKind,
  missionId: string,
  missionSeq: number,
  payload: T,
  opts: WriteReportArtifactOptions = {},
): WriteResult | WriteRejection {
  if (opts.payloadSchema) {
    const parsed = opts.payloadSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, reason: `payload failed ${kind} schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
    }
  }
  const artifact: ReportArtifact<T> = {
    artifactId: newArtifactId(),
    kind,
    missionId,
    missionSeq,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    payload,
    sha256: hashPayload(payload),
    ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
    schemaVersion: REPORT_ARTIFACT_SCHEMA_VERSION,
  };
  return { ok: true, artifact: artifact as ReportArtifact };
}

/** A store of report artifacts under a root directory (one JSON file per artifact). */
export class ReportArtifactStore {
  constructor(private readonly root: string) {}

  private pathFor(artifactId: string): string {
    return join(this.root, `${artifactId}.json`);
  }

  /**
   * Write an artifact EXCLUSIVELY (open `wx`): an existing file is never
   * overwritten — a second write to the same id is refused. The write is
   * atomic-enough for the artifact contract: the file appears whole or the
   * open fails before any bytes are written.
   */
  write(artifact: ReportArtifact): WriteResult | WriteRejection {
    mkdirSync(this.root, { recursive: true });
    const path = this.pathFor(artifact.artifactId);
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx"); // fails with EEXIST if the artifact exists
      writeSync(fd, JSON.stringify(artifact, null, 2));
      return { ok: true, artifact };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") {
        return {
          ok: false,
          reason: `artifact ${artifact.artifactId} already exists: artifacts are immutable (write a new artifact to supersede)`,
        };
      }
      return { ok: false, reason: `artifact write failed: ${e.message}` };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Read + integrity-verify. A hash mismatch is a contract violation surfaced, not hidden. */
  read(artifactId: string): { ok: true; artifact: ReportArtifact } | { ok: false; reason: string } {
    const path = this.pathFor(artifactId);
    if (!existsSync(path)) return { ok: false, reason: `artifact ${artifactId} not found` };
    try {
      const artifact = JSON.parse(readFileSync(path, "utf8")) as ReportArtifact;
      const actual = hashPayload(artifact.payload);
      if (actual !== artifact.sha256) {
        return {
          ok: false,
          reason: `integrity violation: artifact ${artifactId} payload hash ${actual} != recorded ${artifact.sha256}`,
        };
      }
      return { ok: true, artifact };
    } catch (err) {
      return { ok: false, reason: `artifact ${artifactId} unreadable: ${(err as Error).message}` };
    }
  }

  /** Supersede-by-new-artifact: writes a fresh artifact pointing back at the old id. */
  supersede(
    previous: ReportArtifact,
    payload: unknown,
    opts: WriteReportArtifactOptions = {},
  ): WriteResult | WriteRejection {
    const built = buildReportArtifact(previous.kind, previous.missionId, previous.missionSeq + 1, payload, {
      ...opts,
      supersedes: previous.artifactId,
    });
    if (!built.ok) return built;
    return this.write(built.artifact);
  }
}
