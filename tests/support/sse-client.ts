export interface ParsedSseEvent<T = Record<string, unknown>> {
  id: number;
  event: string;
  data: T;
}

export interface SseSubscription<T = Record<string, unknown>> {
  readonly events: ParsedSseEvent<T>[];
  waitForEvent(type: string, timeoutMs?: number): Promise<ParsedSseEvent<T>>;
  waitForTerminal(timeoutMs?: number): Promise<ParsedSseEvent<T>>;
  close(): void;
}

export function subscribeToEvents<T = Record<string, unknown>>(
  baseUrl: string,
  runId: string,
  opts: { afterSeq?: number; lastEventId?: number } = {},
): SseSubscription<T> {
  const events: ParsedSseEvent<T>[] = [];
  const controller = new AbortController();

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (opts.lastEventId !== undefined) {
    headers["Last-Event-ID"] = String(opts.lastEventId);
  }
  const url = new URL(`/runs/${encodeURIComponent(runId)}/events`, baseUrl);
  if (opts.afterSeq !== undefined) {
    url.searchParams.set("after", String(opts.afterSeq));
  }

  const terminalTypes = ["run.completed", "run.failed", "run.cancelled", "run.interrupted"];

  void (async () => {
    try {
      const res = await fetch(url.toString(), {
        headers,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          parseBlock(raw, events);
        }
      }
    } catch {
      // Abort or network close
    }
  })();

  return {
    events,
    close: () => controller.abort(),
    async waitForEvent(type: string, timeoutMs = 5000): Promise<ParsedSseEvent<T>> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = events.find((e) => e.event === type);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timeout waiting for SSE event '${type}' on run ${runId}`);
    },
    async waitForTerminal(timeoutMs = 5000): Promise<ParsedSseEvent<T>> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = events.find((e) => terminalTypes.includes(e.event));
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timeout waiting for terminal SSE event on run ${runId}`);
    },
  };
}

function parseBlock<T>(block: string, sink: ParsedSseEvent<T>[]): void {
  const lines = block.split("\n");
  let id = 0;
  let event = "message";
  let dataStr = "";

  for (const line of lines) {
    if (line.startsWith("id:")) {
      id = Number(line.slice(3).trim()) || 0;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataStr = line.slice(5).trim();
    }
  }

  if (dataStr) {
    try {
      sink.push({ id, event, data: JSON.parse(dataStr) as T });
    } catch {
      // ignore unparseable chunk
    }
  }
}
