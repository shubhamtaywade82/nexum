import { CondenserError } from "../errors.js";
import type { Digester } from "../domain/digest.js";
import type { GitHubPort, LogPort, Logger } from "./ports.js";

export interface CondensePort {
  condense(digest: string): Promise<string>;
}

export interface LogSourceOptions {
  github: Pick<GitHubPort, "failedLog">;
  digester: Digester;
  log: Logger;
  condenser?: CondensePort;
  /** Upper bound on raw log bytes read; the tail is kept. */
  byteCap: number;
}

/**
 * Fetches failed-job logs and produces the digest the agent receives. An optional
 * local condenser refines it. If the condenser is unavailable, the deterministic
 * digest is used, so an Ollama outage never blocks healing.
 */
export class LogSource implements LogPort {
  constructor(private readonly options: LogSourceOptions) {}

  async digestFor(runId: number): Promise<string> {
    const raw = tailBytes(await this.options.github.failedLog(runId), this.options.byteCap);
    const digest = this.options.digester.digest(raw);
    if (!this.options.condenser) return digest;
    try {
      return truncateBytes(await this.options.condenser.condense(digest), this.options.digester.byteCap);
    } catch (error) {
      if (!(error instanceof CondenserError)) throw error;
      this.options.log.warn("condenser unavailable; using deterministic digest", { error: error.message });
      return digest;
    }
  }
}

function tailBytes(text: string, cap: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= cap ? text : bytes.subarray(bytes.length - cap).toString("utf8");
}

function truncateBytes(text: string, cap: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= cap ? text : bytes.subarray(0, cap).toString("utf8");
}
