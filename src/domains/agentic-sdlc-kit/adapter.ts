/**
 * MAC v1 P6 — Agentic SDLC Kit adapter (SPEC §10) — the typed, mission-facing client.
 *
 * The Kit is the workflow authority for Kit-bound missions: only adapter-observed
 * Kit invocations (exit codes recorded by this module) can advance a TDD phase —
 * an LLM never advances or declares one (SPEC §10.3, ADR-0018/0021 in the Kit repo).
 *
 * Deny-by-default allowlist (SPEC §10.2): the only accepted input is the typed
 * `SdlcKitCommand` union, converted to argv here. Everything not in the union is
 * refused — notably `kit host install*`, `kit install`, `kit new`, `kit evolve`,
 * `kit memory` writes and any npm/package mutation. IDs are regex-validated
 * BEFORE spawning; no shell, no string concatenation.
 *
 * Fail-closed parsing (SPEC §10.5): where `--json` output is expected, a parse
 * failure is a FAILURE with the raw output preserved — the phase state is never
 * guessed. Unknown fields in `kit next --json` are ignored (forwards-compatible,
 * R-13); only missing required fields fail.
 *
 * De-duplication (RISK-REGISTER R-06): the five agent-facing `sdlc_*` tools
 * (src/tools/sdlc-tools.ts) and this adapter share ONE command-invocation path —
 * the default runner below wraps the already-exported `executeKitCommand`, and
 * kit resolution goes through the already-exported `resolveKitCliPath`. The five
 * tools are untouched; the adapter extends the bridge, it does not duplicate it.
 *
 * Layering: src/domains/agentic-sdlc-kit must not import ui, host or cli
 * (tests/architecture/mission-layering.test.ts). The adapter may import the
 * tools plane (the bridge) but never the mission plane — the mission plane takes
 * this adapter as an injected port and mirrors its surface structurally
 * (src/orchestration/mission/verification.ts, kept in sync by test).
 */

import { executeKitCommand, resolveKitCliPath } from "../../tools/sdlc-tools.js";

// ── Branded ids (SPEC §10.2 — validated before spawn) ───────────────────────

/** Feature/fix run id, e.g. `FEATURE-001`, `BUG-101` — `^[A-Z0-9][A-Z0-9-]*$`. */
export type FeatureId = string & { __brand: "FeatureId" };
/** Task id within a run, e.g. `TASK-001` — `^TASK-[0-9]{3,}$`. */
export type TaskId = string & { __brand: "TaskId" };

export const FEATURE_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]*$/;
export const TASK_ID_PATTERN = /^TASK-[0-9]{3,}$/;

export function isFeatureId(value: string): value is FeatureId {
  return FEATURE_ID_PATTERN.test(value);
}

export function isTaskId(value: string): value is TaskId {
  return TASK_ID_PATTERN.test(value);
}

// ── Command union (SPEC §10.2, verbatim) ────────────────────────────────────

/** TDD phase-machine actions — exactly what the Kit CLI accepts (verified surface). */
export type SdlcKitPhase = "start" | "red" | "green" | "refactor" | "verify";

export type SdlcKitCommand =
  | { op: "inspect"; path?: string }
  | { op: "doctor" }
  | { op: "validate-spec"; path: string }
  | { op: "validate-plan"; path: string }
  | { op: "verify"; path: string; dryRun?: boolean }
  | { op: "feature-phase"; featureId: FeatureId; taskId: TaskId; phase: SdlcKitPhase }
  | { op: "fix-phase"; fixId: FeatureId; taskId: TaskId; phase: SdlcKitPhase }
  | { op: "next" } // kit next --json
  | { op: "journal-verify"; runId: FeatureId }; // kit journal <ID> --verify

/** The closed op vocabulary — single source of truth for the allowlist. */
export const SDLCKIT_OPS = [
  "inspect",
  "doctor",
  "validate-spec",
  "validate-plan",
  "verify",
  "feature-phase",
  "fix-phase",
  "next",
  "journal-verify",
] as const;

export type SdlcKitOp = (typeof SDLCKIT_OPS)[number];

/** Phases that take a task id on the CLI (start/verify do not). */
const TASK_PHASES: readonly SdlcKitPhase[] = ["red", "green", "refactor"];

// ── Failure vocabulary (SPEC §10.5) ─────────────────────────────────────────

export type SdlcKitFailure =
  | "kit-unavailable" // resolveKitCliPath() → null — degraded + external-unavailable, never silent
  | "invalid-command" // deny-by-default allowlist / id regex / unknown op — refused before spawn
  | "timeout" // per-op timer fired twice (retry once, then blocker)
  | "parse" // non-JSON output where JSON required — fail-closed, never guess the phase
  | "command-failed"; // non-zero exit — kit refused (phase invariant) or verification failed

// ── Result (SPEC §10.2 floor, extended with structured failure) ──────────────

/** Evidence refs (mirrored from the mission plane, SPEC §5.2 — sync-tested). */
export type EvidenceRef = `artifact:${string}` | `event:${string}` | `run:${string}` | `checkpoint:${string}`;

export interface SdlcKitResult<T = unknown> {
  ok: boolean;
  exitCode: number;
  /** JSON parsed when `--json` output present and well-formed; null otherwise (doctor has none). */
  parsed: T | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Structured failure reason (SPEC §10.5); null iff ok. */
  failure: SdlcKitFailure | null;
  /** Mission-health blocker vocabulary; "external-unavailable" iff the Kit is missing. */
  blocker: string | null;
  /** Artifact refs to the raw output (populated when an artifactSink is wired). */
  evidence: EvidenceRef[];
  /** The argv the adapter built (without the CLI entrypoint) — auditable, never a secret. */
  argv: string[];
}

/** Raw invocation record handed to the (optional) artifact sink. */
export interface KitRawOutput {
  op: SdlcKitOp;
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

// ── Injectable runner (like GitHubDeliveryAdapter takes git/HTTP) ───────────

export interface KitCommandInvocation {
  argv: string[];
  cwd: string;
  timeoutMs: number;
}

/**
 * The command runner. The default wraps `executeKitCommand` — the SAME path
 * the five `sdlc_*` tools use (R-06); tests inject a scripted stub Kit CLI.
 */
export type KitCommandRunner = (invocation: KitCommandInvocation) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export interface SdlcKitAdapterOptions {
  /** Working directory the Kit operates on (the repo under workflow). */
  cwd: string;
  /** Injectable runner; default wraps `executeKitCommand` (shared path, R-06). */
  runner?: KitCommandRunner;
  /** Injectable CLI resolution; default `resolveKitCliPath`. */
  resolveCli?: () => string | null;
  /** Per-op timeout overrides; default 60 000 ms for every op. */
  timeouts?: Partial<Record<SdlcKitOp, number>>;
  /**
   * Journal actor declaration (Kit ADR-0021 §3): the Kit cannot infer agent vs
   * human at the CLI boundary — a host DECLARES itself. The adapter always
   * declares, so the journal records the invoking agent honestly.
   */
  host?: string;
  /** Optional sink persisting raw output; returns the artifact refs for evidence. */
  artifactSink?: (record: KitRawOutput) => EvidenceRef[];
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Grace added to the adapter's race timer so the runner's own SIGTERM wins first. */
const RACE_GRACE_MS = 250;

const TIMEOUT_SIGNAL = Symbol("kit-timeout");

/**
 * The typed Kit client. One instance per working directory; stateless across
 * calls — all workflow state lives in the Kit itself (the authority).
 */
export class SdlcKitAdapter {
  private readonly cwd: string;
  private readonly runner: KitCommandRunner;
  private readonly resolveCli: () => string | null;
  private readonly timeouts: Partial<Record<SdlcKitOp, number>>;
  private readonly host: string;
  private readonly artifactSink?: (record: KitRawOutput) => EvidenceRef[];

  constructor(opts: SdlcKitAdapterOptions) {
    this.cwd = opts.cwd;
    this.runner = opts.runner ?? defaultKitRunner;
    this.resolveCli = opts.resolveCli ?? resolveKitCliPath;
    this.timeouts = opts.timeouts ?? {};
    this.host = opts.host ?? "nexum";
    this.artifactSink = opts.artifactSink;
  }

  /** Kit present? (SPEC §10.5 row 1 — checked again on every execute) */
  available(): boolean {
    return this.resolveCli() !== null;
  }

  /**
   * Execute one allowlisted Kit command. Deny-by-default: anything outside
   * the typed union (or failing id/path validation) is refused BEFORE any
   * process is spawned, with failure "invalid-command".
   */
  async execute<T = unknown>(command: SdlcKitCommand): Promise<SdlcKitResult<T>> {
    const argv = this.toArgv(command);
    if (argv === null) {
      return this.refused(command, "command is not in the typed allowlist (SPEC §10.2)");
    }
    if (!this.available()) {
      // SPEC §10.5 row 1: degraded + blocker; never silently proceed ungated.
      const result: SdlcKitResult<T> = {
        ok: false,
        exitCode: -1,
        parsed: null,
        stdout: "",
        stderr: "Agentic SDLC Kit CLI not found (resolveKitCliPath → null)",
        timedOut: false,
        durationMs: 0,
        failure: "kit-unavailable",
        blocker: "external-unavailable",
        evidence: [],
        argv,
      };
      return result;
    }

    const timeoutMs = this.timeouts[command.op] ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    // SPEC §10.5 row 2: timeout → retry once, then blocker. Zombies are the
    // runner's concern (the default SIGTERMs per existing implementation).
    let run = await this.runOnce(argv, timeoutMs);
    if (run.timedOut) {
      run = await this.runOnce(argv, timeoutMs);
    }
    const durationMs = Date.now() - started;

    // Fail-closed JSON parsing (SPEC §10.5 row 3): never guess the phase state.
    let parsed: T | null = null;
    let failure: SdlcKitFailure | null = null;
    if (run.timedOut) {
      failure = "timeout";
    } else if (run.exitCode !== 0) {
      failure = "command-failed";
    } else if (requiresJson(command.op)) {
      const parsedOrNull = parseJsonOutput<T>(run.stdout, command.op);
      if (parsedOrNull === null) {
        failure = "parse";
      } else {
        parsed = parsedOrNull;
      }
    } else if (command.op !== "doctor") {
      parsed = tryParseJson<T>(run.stdout);
    }

    const ok = failure === null && run.exitCode === 0;
    const blocker = failure === "timeout" ? "kit-timeout" : null;
    const record: KitRawOutput = {
      op: command.op,
      argv,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.timedOut ? -1 : run.exitCode,
      timedOut: run.timedOut,
      durationMs,
    };
    const evidence = this.artifactSink ? this.artifactSink(record) : [];

    return {
      ok,
      exitCode: record.exitCode,
      parsed,
      stdout: run.stdout,
      stderr: run.stderr,
      timedOut: run.timedOut,
      durationMs,
      failure,
      blocker,
      evidence,
      argv,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Union → argv. Returns null for anything not in the (closed) union. */
  private toArgv(command: SdlcKitCommand): string[] | null {
    if (command === null || typeof command !== "object" || !("op" in command)) return null;
    switch (command.op) {
      case "inspect": {
        const target = command.path && command.path.length > 0 ? command.path : this.cwd;
        return ["inspect", target, "--json"];
      }
      case "doctor":
        return ["doctor"]; // human-output command; no --json (verified surface)
      case "validate-spec":
      case "validate-plan":
      case "verify": {
        if (typeof command.path !== "string" || command.path.length === 0) return null;
        if (command.op === "verify") {
          return command.dryRun ? ["verify", command.path, "--json", "--dry-run"] : ["verify", command.path, "--json"];
        }
        return [command.op, command.path, "--json"];
      }
      case "feature-phase":
      case "fix-phase": {
        const id = command.op === "feature-phase" ? command.featureId : command.fixId;
        if (!isFeatureId(id) || !isTaskId(command.taskId)) return null; // id regex BEFORE spawn
        if (!TASK_PHASES.includes(command.phase)) {
          // start / verify take no task id on the CLI (verified surface)
          return [command.op === "feature-phase" ? "feature" : "fix", id, command.phase, "--json", "--host", this.host];
        }
        return [
          command.op === "feature-phase" ? "feature" : "fix",
          id,
          command.phase,
          command.taskId,
          "--json",
          "--host",
          this.host,
        ];
      }
      case "next":
        return ["next", "--json"];
      case "journal-verify":
        if (!isFeatureId(command.runId)) return null;
        return ["journal", command.runId, "--verify", "--json"];
      default:
        // Exhaustiveness + runtime deny-by-default: unknown op is refused.
        return null;
    }
  }

  private refused(command: unknown, reason: string): SdlcKitResult<never> {
    return {
      ok: false,
      exitCode: -1,
      parsed: null,
      stdout: "",
      stderr: `kit command refused: ${reason}`,
      timedOut: false,
      durationMs: 0,
      failure: "invalid-command",
      blocker: "invalid-command",
      evidence: [],
      argv: [`<refused:${String((command as { op?: unknown })?.op ?? "unknown")}>`],
    };
  }

  private async runOnce(
    argv: string[],
    timeoutMs: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }> {
    let timedOut = false;
    let raceTimer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        this.runner({ argv, cwd: this.cwd, timeoutMs }),
        new Promise<never>((_, reject) => {
          raceTimer = setTimeout(() => {
            timedOut = true;
            reject(TIMEOUT_SIGNAL);
          }, timeoutMs + RACE_GRACE_MS);
        }),
      ]);
      return { ...outcome, timedOut: false };
    } catch (err) {
      if (err === TIMEOUT_SIGNAL || (err instanceof Error && /timed out/i.test(err.message))) {
        return { stdout: "", stderr: `kit command timed out after ${timeoutMs}ms`, exitCode: -1, timedOut: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: message, exitCode: -1, timedOut };
    } finally {
      // never leak the race timer when the runner settles first
      if (raceTimer !== undefined) clearTimeout(raceTimer);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Ops whose CLI contract is machine-readable JSON on stdout. */
function requiresJson(op: SdlcKitOp): boolean {
  return op !== "doctor";
}

/**
 * Fail-closed parse: JSON required. For `next` the required fields are checked
 * (forwards-compatible: unknown fields ignored, R-13); other ops only need to
 * be well-formed JSON — content validation belongs to the mission plane.
 */
function parseJsonOutput<T>(stdout: string, op: SdlcKitOp): T | null {
  const parsed = tryParseJson<T>(stdout);
  if (parsed === null) return null;
  if (op === "next") {
    const required = parsed as { requiredAction?: unknown };
    if (typeof required.requiredAction !== "string" || required.requiredAction.length === 0) {
      return null; // missing required field (SPEC §10.5 row 6)
    }
  }
  return parsed;
}

function tryParseJson<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/**
 * Default runner — the shared command-invocation path (R-06): the SAME
 * `executeKitCommand` the five `sdlc_*` tools use. Its internal timer
 * SIGTERMs the child on expiry (no zombies); the rejection is classified
 * by the adapter's race/timer logic above.
 */
const defaultKitRunner: KitCommandRunner = async (invocation) => {
  try {
    return await executeKitCommand(invocation.argv, invocation.cwd, invocation.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: message, exitCode: -1 };
  }
};
