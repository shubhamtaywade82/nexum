/**
 * Deterministic first pass over `gh run view --log-failed` output. It strips ANSI
 * codes and the job/step/timestamp prefix, keeps failure-bearing lines plus
 * context, and caps the size. It runs before any model, so the model never sees
 * install noise and the digest is reproducible.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const GH_PREFIX = /^[^\t]*\t[^\t]*\t(?:\d{4}-\d{2}-\d{2}T\S+\s?)?/;
const SIGNALS: readonly RegExp[] = [
  /\b(?:error|errors|fail|failed|failing|failure|failures|exception|traceback|panic|expected|undefined|cannot|assertion|not found|no such file)\b/i,
  /\b(?:TypeError|NameError|NoMethodError|LoadError|ArgumentError|RuntimeError|SyntaxError|ReferenceError)\b/,
  /[\w/.-]+\.(?:rb|rake|ts|tsx|js|jsx|mjs|py|go|rs|java|kt|ex|exs):\d+/,
  /^\s*at\s+\S+/,
  /##\[error\]/,
];

export interface DigesterOptions {
  lineCap?: number;
  byteCap?: number;
  context?: number;
  tailLines?: number;
}

export class Digester {
  readonly byteCap: number;
  private readonly lineCap: number;
  private readonly context: number;
  private readonly tailLines: number;

  constructor(options: DigesterOptions = {}) {
    this.lineCap = options.lineCap ?? 400;
    this.byteCap = options.byteCap ?? 16_000;
    this.context = options.context ?? 2;
    this.tailLines = options.tailLines ?? 120;
  }

  digest(raw: string): string {
    const lines = normalize(raw);
    if (lines.length === 0) return "";
    const indexes = this.signalIndexes(lines);
    const body = indexes.length === 0 ? lines.slice(-this.tailLines) : collapse(lines, indexes);
    return this.capBytes(this.capLines(body).join("\n"));
  }

  private signalIndexes(lines: readonly string[]): number[] {
    const last = lines.length - 1;
    const keep = new Set<number>();
    lines.forEach((line, index) => {
      if (!SIGNALS.some((signal) => signal.test(line))) return;
      for (let j = Math.max(0, index - this.context); j <= Math.min(last, index + this.context); j++) keep.add(j);
    });
    return [...keep].sort((a, b) => a - b);
  }

  private capLines(body: string[]): string[] {
    if (body.length <= this.lineCap) return body;
    const half = Math.floor(this.lineCap / 2);
    return [...body.slice(0, half), `... ${body.length - this.lineCap} lines elided ...`, ...body.slice(-half)];
  }

  private capBytes(text: string): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= this.byteCap) return text;
    const headLength = Math.floor(this.byteCap / 2);
    const tailLength = this.byteCap - headLength;
    const head = bytes.subarray(0, headLength).toString("utf8");
    const tail = bytes.subarray(bytes.length - tailLength).toString("utf8");
    return `${head}\n... [digest truncated] ...\n${tail}`;
  }
}

function normalize(raw: string): string[] {
  const cleaned: string[] = [];
  for (const line of raw.split("\n")) {
    const text = line.replace(/\r$/, "").replace(ANSI, "").replace(GH_PREFIX, "").trimEnd();
    if (text.trim().length > 0) cleaned.push(text);
  }
  return cleaned;
}

function collapse(lines: readonly string[], indexes: readonly number[]): string[] {
  const out: string[] = [];
  let previous: number | undefined;
  for (const index of indexes) {
    if (previous !== undefined && index > previous + 1) out.push("...");
    out.push(lines[index]);
    previous = index;
  }
  return out;
}
