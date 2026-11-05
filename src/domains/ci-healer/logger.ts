import type { Logger } from "./application/ports.js";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

export interface LoggerOptions {
  /** Defaults to CI_HEALER_LOG_LEVEL, then "info". */
  level?: string;
  sink?: (line: string) => void;
  clock?: () => Date;
}

/** Single-line key=value logger. Output is cron-friendly and grep-able. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = (options.level ?? process.env.CI_HEALER_LOG_LEVEL ?? "info") as Level;
  const threshold = LEVELS.indexOf(level);
  if (threshold < 0) throw new Error(`unknown log level: ${level}`);
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const clock = options.clock ?? (() => new Date());

  const write = (at: Level, message: string, fields: Record<string, unknown> = {}): void => {
    if (LEVELS.indexOf(at) < threshold) return;
    const stamp = clock()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const pairs = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
      .join("");
    sink(`${stamp} ${at.toUpperCase().padEnd(5)} ${message}${pairs}`);
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
