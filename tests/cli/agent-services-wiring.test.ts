import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/cli/agent.js";
import { resolveMcpEnv } from "../../src/mcp/env.js";
import { workspaceFile } from "../../src/context-providers/index.js";
import { WebFetchTool, InternetSearchTool } from "../../src/tools/web-tools.js";
import { JOB_SERVICE } from "../../src/platform/plugins/builtin/job-service-plugin.js";
import { HOOK_ENGINE } from "../../src/platform/plugins/index.js";

function chatResponse(content: string) {
  const encoder = new TextEncoder();
  const body = { message: { role: "assistant", content }, done: true };
  let delivered = false;
  return {
    ok: true,
    status: 200,
    json: async () => body,
    body: {
      getReader: () => ({
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: encoder.encode(JSON.stringify(body) + "\n") };
        },
      }),
    },
  };
}

function mockModels() {
  (globalThis as any).fetch = jest.fn().mockImplementation(async (_u: string, init?: { body?: string }) => {
    if (!init?.body) return { ok: true, status: 200, json: async () => ({ models: [] }) };
    return chatResponse("ok");
  });
}

describe("resolveMcpEnv", () => {
  const creds = { get: async (n: string) => ({ GITHUB_TOKEN: "ghp_x" })[n] };
  it("resolves credential references and keeps literals", async () => {
    expect(await resolveMcpEnv({ TOKEN: "credential:GITHUB_TOKEN", MODE: "ro" }, creds)).toEqual({
      TOKEN: "ghp_x",
      MODE: "ro",
    });
  });
  it("fails loudly on a missing credential and returns undefined for no env", async () => {
    await expect(resolveMcpEnv({ T: "credential:NOPE" }, creds)).rejects.toThrow('credential "NOPE" is not set');
    expect(await resolveMcpEnv(undefined, creds)).toBeUndefined();
  });
});

describe("workspaceFile (context file references)", () => {
  it("allows plain workspace files only", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "x");
    await writeFile(join(root, ".env"), "SECRET=1");
    await symlink("/etc/hosts", join(root, "hosts.txt")).catch(() => undefined);
    expect(workspaceFile(root, "src/a.ts")).toMatch(/src\/a\.ts$/);
    expect(workspaceFile(root, ".env")).toBeNull();
    expect(workspaceFile(root, "/etc/hosts")).toBeNull();
    expect(workspaceFile(root, "../outside.txt")).toBeNull();
    expect(workspaceFile(root, "hosts.txt")).toBeNull();
  });
});

describe("web tools", () => {
  const web = {
    fetchAndExtract: jest.fn(async (url: string) => ({
      url,
      title: "T",
      content: "word ".repeat(5_000),
      contentType: "text/html",
      wordCount: 5_000,
    })),
    search: jest.fn(async () => [{ title: "a", url: "https://a", snippet: "s" }]),
  } as never;

  it("web_fetch caps content and rejects non-http urls", async () => {
    const tool = new WebFetchTool(web);
    const res = await tool.call({ url: "https://example.com", max_chars: 100 });
    expect(res).toMatchObject({ truncated: true, title: "T" });
    expect(String(res.content)).toHaveLength(100);
    await expect(tool.call({ url: "file:///etc/passwd" })).rejects.toThrow("absolute http(s) URL");
  });

  it("internet_search returns results", async () => {
    expect((await new InternetSearchTool(web).call({ query: "nexum" })).results).toHaveLength(1);
  });
});

describe("Agent services wiring", () => {
  afterEach(() => jest.restoreAllMocks());

  it("records every message as its own durable run, searchable through session tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    mockModels();
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } });
    await agent.runUserMessage("first question about kafka partitions");
    await agent.runUserMessage("second question");
    const runs = agent.runEvents.listRuns();
    expect(runs.length).toBe(2);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(2);
    const names = agent.tools.registry.getTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["session_search", "session_events", "session_trace", "web_fetch"]));
    const events = await agent.tools.gateway.invoke("session_events", { run_id: runs[0].runId });
    expect(events.ok).toBe(true);
    expect((events.data.total as number) > 0).toBe(true);
  });

  it("mounts the profile with plugins backed by the agent's live services", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } });
    await agent.startHost();
    try {
      expect(agent.activeProfile).toBe("nexum-cli");
      expect(agent.pluginHost.lookup(JOB_SERVICE.id)).toBe(agent.jobs);
      expect(agent.pluginHost.lookup(HOOK_ENGINE.id)).toBe(agent.hooks);
    } finally {
      await agent.stopHost();
    }
  });

  it("falls back to nexum-cli for an unknown profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model", profile: "nope" } });
    expect(agent.activeProfile).toBe("nexum-cli");
  });

  it("ignores the workspace credentials file in an untrusted workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await mkdir(join(dir, ".nexum"), { recursive: true });
    await writeFile(join(dir, ".nexum", "credentials.json"), JSON.stringify({ NEXUM_FAKE_CRED: "from-repo" }));
    const workspaceTrust = { status: "untrusted", trusted: false, withheldKeys: [], withheldEnvFiles: [] } as never;
    const untrusted = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "m", workspaceTrust } });
    expect(await untrusted.credentials.get("NEXUM_FAKE_CRED")).toBeUndefined();
  });

  it("injects provider context (git branch, referenced file) once, and keeps it out of tool selection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/feature-x\n");
    await writeFile(join(dir, "notes.md"), "deploy steps here");
    mockModels();
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } });
    await agent.runUserMessage("summarize notes.md");
    await agent.runUserMessage("thanks, now shorten notes.md");
    let notes = agent.conversation.getMessages().filter((m) => m.content.startsWith("[context]"));
    expect(notes).toHaveLength(1); // unchanged context is not re-injected
    expect(notes[0].content).toContain("feature-x");
    expect(notes[0].content).toContain("deploy steps here");
    await agent.runUserMessage("thanks");
    notes = agent.conversation.getMessages().filter((m) => m.content.startsWith("[context]"));
    expect(notes).toHaveLength(2); // context changed (no file reference) → new note
    expect(notes[1].content).not.toContain("deploy steps here");
  });
});

describe("Agent wiring — telemetry and artifacts", () => {
  afterEach(() => jest.restoreAllMocks());

  it("feeds real runs into process telemetry", async () => {
    const { prometheusMetrics } = await import("../../src/observability/process-telemetry.js");
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    mockModels();
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } });
    await agent.runUserMessage("hello");
    expect(prometheusMetrics()).toContain("nexum_runs_started_total");
  });

  it("offloads an oversized tool output to an artifact the model can read back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "big.log"), Array.from({ length: 9_000 }, (_, i) => `entry ${i}`).join("\n"));
    let chat = 0;
    (globalThis as any).fetch = jest.fn().mockImplementation(async (_u: string, init?: { body?: string }) => {
      if (!init?.body) return { ok: true, status: 200, json: async () => ({ models: [] }) };
      chat += 1;
      if (chat === 1) {
        const encoder = new TextEncoder();
        const body = {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "read_file", arguments: { path: "big.log" } } }],
          },
          done: true,
        };
        let sent = false;
        return {
          ok: true,
          status: 200,
          json: async () => body,
          body: {
            getReader: () => ({
              read: async () =>
                sent
                  ? { done: true, value: undefined }
                  : ((sent = true), { done: false, value: encoder.encode(JSON.stringify(body) + "\n") }),
            }),
          },
        };
      }
      return chatResponse("done");
    });
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "test-model", enableHeuristicGate: false },
    });
    await agent.runUserMessage("read big.log");
    const toolMsg = agent.conversation.getMessages().find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("full output stored as artifact");
    expect(agent.artifacts.count()).toBe(1);
  });
});

describe("Agent wiring — NEXUM_TOKEN_BUDGET", () => {
  afterEach(() => {
    delete process.env.NEXUM_TOKEN_BUDGET;
    jest.restoreAllMocks();
  });

  it("refuses new runs once the session budget is spent", async () => {
    process.env.NEXUM_TOKEN_BUDGET = "10";
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const encoder = new TextEncoder();
    const body = { message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 8, eval_count: 4 };
    (globalThis as any).fetch = jest.fn().mockImplementation(async (_u: string, init?: { body?: string }) => {
      if (!init?.body) return { ok: true, status: 200, json: async () => ({ models: [] }) };
      let sent = false;
      return {
        ok: true,
        status: 200,
        json: async () => body,
        body: {
          getReader: () => ({
            read: async () =>
              sent
                ? { done: true, value: undefined }
                : ((sent = true), { done: false, value: encoder.encode(JSON.stringify(body) + "\n") }),
          }),
        },
      };
    });
    const agent = new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } });
    expect(agent.tokenBudget.limit).toBe(10);
    // The run that crosses the budget is stopped by the kernel mid-loop.
    expect(await agent.runUserMessage("first")).toMatch(/\[stopped\] token budget exhausted: 12\/10/);
    const second = await agent.runUserMessage("second");
    expect(second).toMatch(/^Token budget exhausted: 12\/10/);
  });
});
