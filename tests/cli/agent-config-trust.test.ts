/**
 * An Agent's configuration follows the trust store and the workspace it was built with.
 *
 * Before this, the constructor and every turn's config reload called loadConfig() with no
 * arguments. So the global trust store decided what a workspace's config may apply, even when the
 * Agent was given its own store, and the workspace was whatever the process's cwd resolved to.
 */
import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { trustWorkspace, WorkspaceTrustStore } from "../../src/cli/workspace-trust.js";
import { Agent } from "../../src/cli/agent.js";
import { isolateModelSubsystems } from "../support/isolate-model-subsystems.js";

/** systemPrompt is not a workspace-safe key: it applies only once the workspace is trusted. */
const PROMPT_MARKER = "PROMPT-FROM-THIS-WORKSPACE-CONFIG";

const realFetch = globalThis.fetch;

function mockChatOnce(content: string): void {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ message: { role: "assistant", content }, done: true }) + "\n",
  );
  let delivered = false;
  const reader = {
    read: async () => {
      if (delivered) return { done: true, value: undefined };
      delivered = true;
      return { done: false, value: encoded };
    },
    releaseLock: () => {},
  };
  (globalThis as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ message: { role: "assistant", content }, done: true }),
    body: { getReader: () => reader },
  });
}

/** Messages of the main chat request: the one POST that carries a body. */
function firstRequestMessages(): Array<{ role: string; content: string }> {
  const calls = (globalThis.fetch as jest.Mock).mock.calls;
  const postCall = calls.find((c) => (c[1] as RequestInit | undefined)?.body);
  if (!postCall) throw new Error("No chat request was sent");
  return JSON.parse((postCall[1] as RequestInit).body as string).messages;
}

function systemText(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

function writeWorkspaceConfig(root: string, file: Record<string, unknown>): void {
  mkdirSync(join(root, ".nexum"), { recursive: true });
  writeFileSync(join(root, ".nexum", "config.json"), JSON.stringify(file));
}

isolateModelSubsystems();

describe("Agent configuration follows its trust store and workspace", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("applies the workspace config the injected trust store trusts, not the global store's verdict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-trust-"));
    const skillsHomeDir = await mkdtemp(join(tmpdir(), "skills-home-"));
    writeWorkspaceConfig(dir, { systemPrompt: PROMPT_MARKER });
    const injected = WorkspaceTrustStore.inMemory();
    trustWorkspace(dir, injected);
    // The global store (untrusted under NEXUM_TEST_NO_GLOBAL) must not be consulted for this workspace.
    mockChatOnce("ok");
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "test-model" },
      skillsHomeDir,
      trustStore: injected,
    });

    await agent.runUserMessage("hello");

    expect(systemText(firstRequestMessages())).toContain(PROMPT_MARKER);
  });

  it("withholds the workspace config when the injected trust store does not trust the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-untrusted-"));
    const skillsHomeDir = await mkdtemp(join(tmpdir(), "skills-home-"));
    writeWorkspaceConfig(dir, { systemPrompt: PROMPT_MARKER });
    mockChatOnce("ok");
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "test-model" },
      skillsHomeDir,
      trustStore: WorkspaceTrustStore.inMemory(),
    });

    await agent.runUserMessage("hello");

    expect(systemText(firstRequestMessages())).not.toContain(PROMPT_MARKER);
  });

  it("keeps the agent's own workspace root on every turn, whatever the process cwd is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-root-"));
    const skillsHomeDir = await mkdtemp(join(tmpdir(), "skills-home-"));
    const injected = WorkspaceTrustStore.inMemory();
    trustWorkspace(dir, injected);
    mockChatOnce("ok");
    const agent = new Agent({
      config: { workspaceRoot: dir, tier: "local", model: "test-model" },
      skillsHomeDir,
      trustStore: injected,
    });

    await agent.runUserMessage("hello");

    const system = systemText(firstRequestMessages());
    expect(system).toContain(`Workspace Root Directory: ${dir}`);
    expect(system).toContain(`Workspace Name: ${basename(dir)}`);
    expect(system).not.toContain(`Workspace Root Directory: ${process.cwd()}`);
  });
});
