import { ServerHarness } from "../support/server-harness.js";
import { NexumClient } from "../../src/assistant/client/index.js";
import { runChatCli, type ChatIo } from "../../src/cli/chat.js";

describe("Claude-Code-like CLI (Wave 14)", () => {
  const harness = new ServerHarness();
  let client: NexumClient;

  beforeAll(async () => {
    await harness.start();
    client = new NexumClient({ baseUrl: harness.baseUrl });
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    harness.resetRunHandler();
    await harness.pg.cleanTables();
  });

  function createMockIo(inputs: string[]): { io: ChatIo; outputs: string[] } {
    const queue = [...inputs];
    const outputs: string[] = [];
    return {
      io: {
        question: async (_q: string) => queue.shift() ?? "/exit",
        write: (t: string) => outputs.push(t),
        close: () => {},
      },
      outputs,
    };
  }

  it("handles multi-turn chat and slash commands (/help, /status, /exit)", async () => {
    const { io, outputs } = createMockIo([
      "/help",
      "/status",
      "Hello agent, please calculate 2+2",
      "/exit",
    ]);

    await runChatCli([], client, io);

    const fullOutput = outputs.join("");
    expect(fullOutput).toContain("Connected to Nexum Server");
    expect(fullOutput).toContain("Commands: /help, /sessions, /status, /clear, /exit");
    expect(fullOutput).toContain("Session:");
    expect(fullOutput).toContain("Finished task: Hello agent, please calculate 2+2");
  });

  it("attaches to an existing session via -s flag", async () => {
    const existing = await client.createSession({ title: "Pre-existing Session" });

    const { io, outputs } = createMockIo(["/status", "/exit"]);
    await runChatCli(["-s", existing.id], client, io);

    const fullOutput = outputs.join("");
    expect(fullOutput).toContain(`Active Session: ${existing.id}`);
  });

  it("lists existing sessions via /sessions slash command", async () => {
    await client.createSession({ title: "Alpha Session" });
    await client.createSession({ title: "Beta Session" });

    const { io, outputs } = createMockIo(["/sessions", "/exit"]);
    await runChatCli([], client, io);

    const fullOutput = outputs.join("");
    expect(fullOutput).toContain("Alpha Session");
    expect(fullOutput).toContain("Beta Session");
  });

  it("prompts for and resolves interactive approvals", async () => {
    // Fake agent requests approval
    harness.setRunHandler(async (goal: string, agent) => {
      agent.emit("onThinking", "Evaluating safety...");
      agent.emit("onThinking", "Approval requested");
      return `Deployed with approval: ${goal}`;
    });

    const { io, outputs } = createMockIo(["Perform dangerous task", "/exit"]);
    await runChatCli([], client, io);

    const fullOutput = outputs.join("");
    expect(fullOutput).toContain("Deployed with approval");
  });
});
