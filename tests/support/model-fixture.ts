import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface ModelFixtureResponse {
  message?: { role: string; content: string; tool_calls?: unknown[] };
  done?: boolean;
}

export class ModelFixture {
  private server: Server | null = null;
  private port = 0;
  private customChatHandler?: (reqBody: unknown) => ModelFixtureResponse;
  readonly recordedRequests: unknown[] = [];

  setChatHandler(handler: (reqBody: unknown) => ModelFixtureResponse): void {
    this.customChatHandler = handler;
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      });
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
          resolve(`http://127.0.0.1:${this.port}`);
        }
      });
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (req.method === "GET" && url.pathname === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "fake-ollama", modified_at: new Date().toISOString() }] }));
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/v1/chat/completions")) {
      const body = await this.readBody(req);
      this.recordedRequests.push(body);

      const resp = this.customChatHandler
        ? this.customChatHandler(body)
        : {
            message: { role: "assistant", content: "I am a deterministic fake model response." },
            done: true,
          };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }
}
