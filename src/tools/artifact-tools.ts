/**
 * artifact_read — page through (or grep) an artifact the runtime stored
 * instead of putting it in the model context (e.g. an oversized tool
 * output). The tool result shows an excerpt plus the artifact id; this tool
 * fetches exactly the part the model needs next.
 */

import { Tool, ToolError } from "./tool.js";
import type { ArtifactStore } from "../artifacts/index.js";

const DEFAULT_LENGTH = 4_000;
const MAX_LENGTH = 12_000;
const MAX_MATCHES = 50;

export class ArtifactReadTool extends Tool {
  constructor(private readonly store: ArtifactStore) {
    super();
  }
  get name() {
    return "artifact_read";
  }
  get description() {
    return "Read part of a stored artifact (e.g. a large tool output that was replaced by an excerpt). Use offset/length to page, or pattern to get matching lines with line numbers.";
  }
  override get tags() {
    return ["artifact", "output", "log", "read", "page", "grep"];
  }
  get parameters() {
    return {
      type: "object",
      properties: {
        artifact_id: { type: "string" },
        offset: { type: "integer", description: "Character offset (default 0)" },
        length: { type: "integer", description: `Characters to return (default ${DEFAULT_LENGTH}, max ${MAX_LENGTH})` },
        pattern: { type: "string", description: "Case-insensitive regex; returns matching lines instead of a slice" },
      },
      required: ["artifact_id"],
    };
  }
  async call(args: Record<string, unknown>) {
    const id = typeof args.artifact_id === "string" ? args.artifact_id.trim() : "";
    if (!id) throw new ToolError("artifact_id is required");
    const artifact = this.store.get(id);
    if (!artifact) return { error: "NotFound", message: `no artifact ${id}` };
    const content = artifact.content;

    if (typeof args.pattern === "string" && args.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(args.pattern, "i");
      } catch (e) {
        throw new ToolError(`invalid pattern: ${(e as Error).message}`);
      }
      const matches: Array<{ line: number; text: string }> = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (re.test(lines[i])) matches.push({ line: i + 1, text: lines[i].slice(0, 500) });
      }
      return { artifact_id: id, total_chars: content.length, matches, capped: matches.length >= MAX_MATCHES };
    }

    const offset = Math.max(0, typeof args.offset === "number" ? Math.floor(args.offset) : 0);
    const length = Math.min(
      MAX_LENGTH,
      Math.max(1, typeof args.length === "number" ? Math.floor(args.length) : DEFAULT_LENGTH),
    );
    const slice = content.slice(offset, offset + length);
    return {
      artifact_id: id,
      offset,
      returned_chars: slice.length,
      total_chars: content.length,
      has_more: offset + slice.length < content.length,
      content: slice,
    };
  }
}

/**
 * Replace an oversized tool output with head + tail excerpts and a pointer
 * to the full output stored as an artifact. Returns the text to put in the
 * transcript (unchanged when under the threshold).
 */
export function offloadLargeOutput(
  store: ArtifactStore,
  text: string,
  opts: {
    tool: string;
    threshold: number;
    args?: Record<string, unknown>;
    runId?: string;
    sessionId?: string;
    agentId?: string;
  },
): { text: string; artifactId?: string } {
  if (text.length <= opts.threshold) return { text };
  const artifact = store.save({
    name: `${opts.tool}-output`,
    kind: "log",
    content: text,
    mimeType: "text/plain",
    tags: ["tool-output", opts.tool],
    metadata: { args: opts.args ?? {} },
    provenance: {
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    },
  });
  const head = Math.floor(opts.threshold * 0.6);
  const tail = Math.floor(opts.threshold * 0.25);
  const omitted = text.length - head - tail;
  return {
    artifactId: artifact.id,
    text: [
      text.slice(0, head),
      `\n…[${omitted} chars omitted — full output stored as artifact ${artifact.id}; read more with artifact_read({"artifact_id":"${artifact.id}","offset":${head}}) or search it with a pattern]…\n`,
      text.slice(text.length - tail),
    ].join(""),
  };
}
