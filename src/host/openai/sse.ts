import type { ServerResponse } from "node:http";

const KEEP_ALIVE_MS = 15_000;

/**
 * Writes an OpenAI `chat.completion.chunk` stream. Opens lazily so a failure before the first byte can still be
 * answered with a normal error response, and sends SSE comment lines while the agent is silent so proxies and
 * clients do not time the connection out (OpenAI clients ignore comments).
 */
export class SseStream {
  private id = "";
  private created = 0;
  private timer: NodeJS.Timeout | undefined;
  private opened = false;
  private ended = false;

  constructor(
    private readonly res: ServerResponse,
    private readonly model: string,
    private readonly keepAliveMs = KEEP_ALIVE_MS,
  ) {}

  get isOpen(): boolean {
    return this.opened;
  }

  get isFinished(): boolean {
    return this.ended;
  }

  open(id: string): void {
    this.id = id;
    this.created = Math.floor(Date.now() / 1000);
    this.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.opened = true;
    this.chunk({ role: "assistant", content: "" }, null);
    this.timer = setInterval(() => this.write(": keep-alive\n\n"), this.keepAliveMs);
    this.timer.unref();
  }

  text(content: string): void {
    if (this.opened && !this.ended && content) this.chunk({ content }, null);
  }

  finish(): void {
    if (!this.opened || this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.chunk({}, "stop");
    this.write("data: [DONE]\n\n");
    this.res.end();
  }

  private chunk(delta: Record<string, unknown>, finishReason: "stop" | null): void {
    const payload = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    this.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private write(data: string): void {
    if (!this.res.destroyed && !this.res.writableEnded) this.res.write(data);
  }
}
