/**
 * Error taxonomy for the CI healer. Recoverable errors (command, timeout, protocol)
 * mean "retry on the next tick"; configuration and state errors need an operator.
 */

export class CiHealerError extends Error {}

/** Configuration is invalid. The daemon refuses to start. */
export class ConfigError extends CiHealerError {}

/** The SQLite ledger is unreadable or from an unknown schema. Fail closed. */
export class StateError extends CiHealerError {}

/** Another worker holds the lease for this repository. */
export class LeaseHeldError extends CiHealerError {}

/** An external command exited non-zero. */
export class CommandError extends CiHealerError {
  readonly argv: readonly string[];
  readonly status: number;
  readonly stderr: string;

  constructor(argv: readonly string[], status: number, stderr: string) {
    const tail = stderr.trim();
    const shown = tail.length > 500 ? `...${tail.slice(-500)}` : tail;
    super(`\`${argv.slice(0, 3).join(" ")}\` exited ${status}: ${shown}`);
    this.argv = argv;
    this.status = status;
    this.stderr = stderr;
  }
}

/** A command or RPC exceeded its deadline. */
export class TimeoutError extends CiHealerError {}

/** Malformed output or a JSON-RPC contract violation. */
export class ProtocolError extends CiHealerError {}

/** The optional local condenser failed. The deterministic digest is used instead. */
export class CondenserError extends CiHealerError {}

export function isRecoverable(error: unknown): boolean {
  return error instanceof CommandError || error instanceof TimeoutError || error instanceof ProtocolError;
}
