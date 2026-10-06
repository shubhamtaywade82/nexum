import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ChatMessage } from "../models/adapters/provider.js";
import { redactObject, redactText } from "../safety/redact.js";

export interface SessionMeta {
  id: string;
  startedAt: number;
  updatedAt: number;
  messageCount: number;
  firstUserLine: string;
}

/** Persists LLM conversation transcripts so a killed/restarted process can pick
 * back up, and so past conversations can be browsed and reloaded — one file per
 * session under `dir/<id>.json`, indexed by `dir/index.json`. Same atomic-write
 * shape as the plan-level CheckpointStore (src/runtime/checkpoint.ts). */
export class SessionStore {
  private readonly indexPath: string;

  constructor(private readonly dir: string) {
    this.indexPath = join(dir, "index.json");
    this.migrateLegacy();
  }

  // Older versions kept a single flat `<dir>.json` file. Fold it into the new
  // layout as one session, once, then remove it.
  private migrateLegacy(): void {
    const legacyPath = `${this.dir}.json`;
    if (!existsSync(legacyPath) || existsSync(this.indexPath)) return;
    try {
      const messages = JSON.parse(readFileSync(legacyPath, "utf8"));
      if (Array.isArray(messages) && messages.length > 0) {
        this.save(this.startNew(), messages as ChatMessage[]);
      }
    } catch {
      // corrupt legacy file — nothing worth migrating
    }
    unlinkSync(legacyPath);
  }

  private readIndex(): SessionMeta[] {
    if (!existsSync(this.indexPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8"));
      return Array.isArray(parsed) ? (parsed as SessionMeta[]) : [];
    } catch {
      return [];
    }
  }

  private writeAtomic(path: string, content: string): void {
    mkdirSync(this.dir, { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, path);
  }

  private sessionPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  startNew(): string {
    return randomUUID();
  }

  save(id: string, rawMessages: ChatMessage[]): void {
    // Transcripts are persisted to .nexum/sessions in plain JSON: strip
    // credentials (API keys, bearer tokens, JWTs, key=value secrets) before
    // they reach disk. The live in-memory conversation is untouched.
    const messages = rawMessages.map(redactMessage);
    this.writeAtomic(this.sessionPath(id), JSON.stringify(messages, null, 2));

    const now = Date.now();
    const firstUser = messages.find((m) => m.role === "user");
    const firstUserLine = (firstUser?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

    const index = this.readIndex();
    const existing = index.find((s) => s.id === id);
    const meta: SessionMeta = {
      id,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      messageCount: messages.length,
      firstUserLine: firstUserLine || existing?.firstUserLine || "(empty)",
    };
    const nextIndex = existing ? index.map((s) => (s.id === id ? meta : s)) : [...index, meta];
    this.writeAtomic(this.indexPath, JSON.stringify(nextIndex, null, 2));
  }

  load(id: string): ChatMessage[] | null {
    const path = this.sessionPath(id);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(parsed) ? (parsed as ChatMessage[]) : null;
    } catch {
      return null;
    }
  }

  listSessions(): SessionMeta[] {
    // Reverse before a stable sort so ties (saves within the same millisecond)
    // still resolve most-recently-touched-first instead of by insertion order.
    return this.readIndex()
      .reverse()
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  mostRecentId(): string | null {
    return this.listSessions()[0]?.id ?? null;
  }

  clear(id: string): void {
    const path = this.sessionPath(id);
    if (existsSync(path)) unlinkSync(path);
    const nextIndex = this.readIndex().filter((s) => s.id !== id);
    this.writeAtomic(this.indexPath, JSON.stringify(nextIndex, null, 2));
  }
}

function redactMessage(m: ChatMessage): ChatMessage {
  return {
    ...m,
    content: redactText(m.content ?? ""),
    ...(m.tool_calls ? { tool_calls: redactObject(m.tool_calls) } : {}),
  };
}
