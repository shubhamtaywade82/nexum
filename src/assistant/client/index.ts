import type {
  NexumCapabilities,
  NexumRun,
  RunEventEnvelope,
  ResolveInteractionRequest,
} from "../../protocol/types.js";

export interface NexumClientOptions {
  baseUrl?: string;
  token?: string;
  fetchFn?: typeof fetch;
}

export interface CreateSessionOptions {
  title?: string;
  idempotencyKey?: string;
}

export interface CreateRunOptions {
  idempotencyKey?: string;
}

export interface StreamEventsOptions {
  afterSeq?: number;
  signal?: AbortSignal;
}

export interface SessionSummary {
  id: string;
  workspaceRoot: string;
  title?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionDetail {
  session: SessionSummary;
  messages: Array<{ role: string; content: string; createdAt: number }>;
}

export class NexumClient {
  readonly baseUrl: string;
  readonly token?: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: NexumClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.NEXUM_SERVER_URL ?? "http://127.0.0.1:3777").replace(/\/$/, "");
    this.token = opts.token ?? process.env.NEXUM_SERVER_TOKEN;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async health(): Promise<{ status: string; uptime?: number }> {
    return this.request<{ status: string; uptime?: number }>("/health");
  }

  async ready(): Promise<{ status: string; checks: Record<string, string> }> {
    return this.request<{ status: string; checks: Record<string, string> }>("/ready");
  }

  async capabilities(): Promise<NexumCapabilities> {
    return this.request<NexumCapabilities>("/capabilities");
  }

  async createSession(opts: CreateSessionOptions = {}): Promise<{ id: string; createdAt: number }> {
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey) {
      headers["Idempotency-Key"] = opts.idempotencyKey;
    }
    return this.request<{ id: string; createdAt: number }>("/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: opts.title }),
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    const res = await this.request<{ sessions: SessionSummary[] }>("/sessions");
    return res.sessions;
  }

  async getSession(id: string): Promise<SessionDetail> {
    return this.request<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
  }

  async createRun(
    sessionId: string,
    goal: string,
    opts: CreateRunOptions = {},
  ): Promise<NexumRun> {
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey) {
      headers["Idempotency-Key"] = opts.idempotencyKey;
    }
    const res = await this.request<{ run: NexumRun }>(
      `/sessions/${encodeURIComponent(sessionId)}/runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ goal }),
      },
    );
    return res.run;
  }

  async getRun(runId: string): Promise<NexumRun> {
    return this.request<NexumRun>(`/runs/${encodeURIComponent(runId)}`);
  }

  async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    });
  }

  async resolveInteraction(
    runId: string,
    interactionId: string,
    resolution: ResolveInteractionRequest,
  ): Promise<{ resolved: boolean; interactionId: string }> {
    return this.request<{ resolved: boolean; interactionId: string }>(
      `/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify(resolution),
      },
    );
  }

  async *streamEvents(
    runId: string,
    opts: StreamEventsOptions = {},
  ): AsyncIterable<RunEventEnvelope> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (opts.afterSeq !== undefined) {
      headers["Last-Event-ID"] = String(opts.afterSeq);
    }

    const res = await this.fetchFn(
      `${this.baseUrl}/runs/${encodeURIComponent(runId)}/events?stream=1`,
      { headers, signal: opts.signal },
    );
    if (!res.ok || !res.body) {
      throw new Error(`SSE stream failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) yield parsed;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);
    if (this.token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await this.fetchFn(`${this.baseUrl}${path}`, { ...options, headers });
    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      let errorMessage = `${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed.message) errorMessage = parsed.message;
      } catch {
        // Non-JSON error body; preserve status text
      }
      throw new Error(errorMessage);
    }
    return res.json() as Promise<T>;
  }
}

function parseSseBlock(block: string): RunEventEnvelope | null {
  let id = 0;
  let eventType = "";
  let dataStr = "";

  for (const line of block.split("\n")) {
    if (line.startsWith("id: ")) id = Number(line.slice(4).trim()) || 0;
    else if (line.startsWith("event: ")) eventType = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
  }

  if (!dataStr) return null;
  try {
    const payload = JSON.parse(dataStr);
    return {
      seq: id || payload.seq || 0,
      runId: payload.runId ?? "",
      type: (eventType || payload.type) as RunEventEnvelope["type"],
      ts: payload.ts ?? Date.now(),
      payload,
    };
  } catch {
    return null;
  }
}
