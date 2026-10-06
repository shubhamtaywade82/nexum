/**
 * VerifierService — deterministic, checkable post-conditions.
 *
 * Complements the critic (which judges open-ended quality) with concrete
 * verification: does the output contain the required artifacts, is it free
 * of placeholders, did the referenced command actually succeed? Checks are
 * registered by products; verify() runs them all and reports.
 */

export interface VerificationCheck {
  id: string;
  description: string;
  /** Return pass/fail (+ detail) for the answer under verification. */
  run(answer: string): Promise<{ pass: boolean; detail?: string }> | { pass: boolean; detail?: string };
}

export interface VerificationResult {
  checkId: string;
  pass: boolean;
  detail?: string;
}

export interface VerificationReport {
  results: VerificationResult[];
  pass: boolean;
}

export class VerifierService {
  private readonly checks = new Map<string, VerificationCheck>();

  register(check: VerificationCheck): this {
    if (this.checks.has(check.id)) throw new Error(`verification check "${check.id}" is already registered`);
    this.checks.set(check.id, check);
    return this;
  }

  ids(): string[] {
    return [...this.checks.keys()];
  }

  async verify(answer: string): Promise<VerificationReport> {
    const results: VerificationResult[] = [];
    for (const check of this.checks.values()) {
      try {
        const outcome = await check.run(answer);
        results.push({ checkId: check.id, pass: outcome.pass, ...(outcome.detail ? { detail: outcome.detail } : {}) });
      } catch (err) {
        results.push({
          checkId: check.id,
          pass: false,
          detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return { results, pass: results.every((r) => r.pass) };
  }
}

// ── Built-in check factories ────────────────────────────────────────────────

/** The answer must contain every given substring. */
export function expectOutputContains(required: string[], id = "contains"): VerificationCheck {
  return {
    id,
    description: `answer contains: ${required.join(", ")}`,
    run(answer) {
      const missing = required.filter((s) => !answer.includes(s));
      return {
        pass: missing.length === 0,
        ...(missing.length > 0 ? { detail: `missing: ${missing.join(", ")}` } : {}),
      };
    },
  };
}

/** The answer must not contain placeholder markers. */
export function expectNoPlaceholders(id = "no-placeholders"): VerificationCheck {
  return {
    id,
    description: "answer is free of TODO/FIXME/placeholder markers",
    run(answer) {
      const pattern = /\bTODO\b|\bFIXME\b|\[insert[^\]]*\]|\[placeholder[^\]]*\]|lorem ipsum/i;
      const match = pattern.exec(answer);
      return { pass: match === null, ...(match ? { detail: `found "${match[0]}"` } : {}) };
    },
  };
}

/** The answer must be at least `minChars` long. */
export function expectMinLength(minChars: number, id = "min-length"): VerificationCheck {
  return {
    id,
    description: `answer is at least ${minChars} characters`,
    run(answer) {
      return { pass: answer.trim().length >= minChars, detail: `${answer.trim().length}/${minChars} chars` };
    },
  };
}

/** Outcome of a command run through the sandbox (ShellTool, a script runner, CI). */
export interface CommandOutcome {
  exitCode: number;
  output?: string;
}

/**
 * The command must exit 0. The runner is injected (normally the Docker
 * sandbox), so pass/fail comes from the process exit code — never from a
 * model reading the output. The answer under verification is ignored.
 */
export function expectCommandSucceeds(
  id: string,
  description: string,
  run: () => Promise<CommandOutcome>,
  maxDetailChars = 500,
): VerificationCheck {
  return {
    id,
    description,
    async run() {
      const { exitCode, output } = await run();
      if (!Number.isInteger(exitCode)) return { pass: false, detail: `invalid exit code: ${String(exitCode)}` };
      if (exitCode === 0) return { pass: true };
      const tail = output ? output.trim().slice(-maxDetailChars) : "";
      return { pass: false, detail: `exit ${exitCode}${tail ? `: ${tail}` : ""}` };
    },
  };
}
