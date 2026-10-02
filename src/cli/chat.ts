import readline from "node:readline/promises";
import { NexumClient } from "../assistant/client/index.js";
import type { RunEventEnvelope } from "../protocol/types.js";

export interface ChatIo {
  question(query: string): Promise<string>;
  write(text: string): void;
  close(): void;
}

export function createStdioChat(): ChatIo {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    question: (q: string) => rl.question(q),
    write: (text: string) => process.stdout.write(text),
    close: () => rl.close(),
  };
}

export function parseChatArgs(args: string[]): { sessionId?: string; serverUrl?: string } {
  let sessionId: string | undefined;
  let serverUrl: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-s" || arg === "--session") && args[i + 1]) {
      sessionId = args[++i];
    } else if ((arg === "-u" || arg === "--url") && args[i + 1]) {
      serverUrl = args[++i];
    }
  }
  return { sessionId, serverUrl };
}

export async function handleSlashCommand(
  cmd: string,
  sessionId: string,
  client: NexumClient,
  io: ChatIo,
): Promise<boolean> {
  const trimmed = cmd.trim().toLowerCase();
  if (trimmed === "/exit" || trimmed === "/quit") return false;
  if (trimmed === "/help") {
    io.write("Commands: /help, /sessions, /status, /clear, /exit\n");
  } else if (trimmed === "/status") {
    io.write(`Session: ${sessionId}\nServer: ${client.baseUrl}\n`);
  } else if (trimmed === "/sessions") {
    const list = await client.listSessions();
    for (const s of list) {
      io.write(`${s.id}  ${s.messageCount} msgs  ${s.title ?? "(untitled)"}\n`);
    }
  } else if (trimmed === "/clear") {
    io.write("\x1Bc");
  } else {
    io.write(`Unknown command: ${trimmed}. Type /help for options.\n`);
  }
  return true;
}

async function promptApproval(
  runId: string,
  interactionId: string,
  title: string,
  client: NexumClient,
  io: ChatIo,
): Promise<void> {
  io.write(`\n[Approval Required] ${title}\n`);
  const answer = await io.question("Approve? (y/n): ");
  const approved = answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  await client.resolveInteraction(runId, interactionId, { approved });
}

async function handleStreamEvent(
  envelope: RunEventEnvelope,
  client: NexumClient,
  io: ChatIo,
): Promise<void> {
  const { payload } = envelope;
  if (payload.type === "thought") {
    io.write(`💭 ${payload.text}\n`);
  } else if (payload.type === "tool.started") {
    io.write(`⚡ Tool: ${payload.name}\n`);
  } else if (payload.type === "tool.completed") {
    io.write(`✔ Tool: ${payload.name} completed\n`);
  } else if (payload.type === "run.approval.required") {
    const title = payload.title ?? "Action requires approval";
    await promptApproval(envelope.runId, payload.interactionId, title, client, io);
  } else if (payload.type === "run.completed") {
    io.write(`\n🤖 ${payload.output}\n\n`);
  } else if (payload.type === "run.failed") {
    io.write(`\n❌ Run failed: ${payload.error}\n\n`);
  }
}

export async function executeChatTurn(
  sessionId: string,
  goal: string,
  client: NexumClient,
  io: ChatIo,
): Promise<void> {
  const run = await client.createRun(sessionId, goal);
  for await (const event of client.streamEvents(run.id)) {
    await handleStreamEvent(event, client, io);
    if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type)) {
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 25));
}

export async function runChatCli(
  args: string[],
  injectedClient?: NexumClient,
  injectedIo?: ChatIo,
): Promise<void> {
  const { sessionId: optSessionId, serverUrl } = parseChatArgs(args);
  const client = injectedClient ?? new NexumClient({ baseUrl: serverUrl });
  const io = injectedIo ?? createStdioChat();

  let sessionId = optSessionId;
  if (!sessionId) {
    const created = await client.createSession({ title: "Terminal Chat" });
    sessionId = created.id;
  }

  io.write(`● Connected to Nexum Server (${client.baseUrl})\n`);
  io.write(`● Active Session: ${sessionId}\n`);
  io.write(`Type /help for commands, /exit to quit.\n\n`);

  try {
    while (true) {
      const input = await io.question("nexum> ");
      const trimmed = input.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("/")) {
        const keepGoing = await handleSlashCommand(trimmed, sessionId, client, io);
        if (!keepGoing) break;
        continue;
      }
      await executeChatTurn(sessionId, trimmed, client, io);
    }
  } finally {
    io.close();
  }
}
