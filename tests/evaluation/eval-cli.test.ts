import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/cli/agent.js";
import { runEvalCli } from "../../src/evaluation/cli.js";

function chatResponse(content: string) {
  const encoder = new TextEncoder();
  const body = { message: { role: "assistant", content }, done: true, prompt_eval_count: 10, eval_count: 5 };
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

async function setup(answer: string) {
  const dir = await mkdtemp(join(tmpdir(), "eval-"));
  (globalThis as any).fetch = jest
    .fn()
    .mockImplementation(async (_u: string, init?: { body?: string }) =>
      init?.body ? chatResponse(answer) : { ok: true, status: 200, json: async () => ({ models: [] }) },
    );
  const dataset = {
    id: "smoke",
    name: "Smoke",
    scenarios: [
      {
        id: "greet",
        name: "greet",
        task: { goal: "say the magic word" },
        expected: { finalOutputContains: ["xyzzy"] },
      },
    ],
  };
  await writeFile(join(dir, "dataset.json"), JSON.stringify(dataset));
  const lines: string[] = [];
  const deps = {
    createAgent: () => new Agent({ config: { workspaceRoot: dir, tier: "local", model: "test-model" } }),
    stateDir: join(dir, ".nexum"),
    log: (l: string) => lines.push(l),
  };
  return { dir, deps, lines };
}

describe("nexum eval", () => {
  afterEach(() => jest.restoreAllMocks());

  it("runs scenarios through real agent turns, saves a report and exits 0 on pass", async () => {
    const { dir, deps, lines } = await setup("the magic word is xyzzy");
    const code = await runEvalCli([join(dir, "dataset.json")], deps);
    expect(code).toBe(0);
    expect(lines).toContain("PASS greet");
    expect((await readdir(join(dir, ".nexum", "evals"))).some((f) => f.startsWith("smoke-"))).toBe(true);
  });

  it("exits 1 when a scenario fails", async () => {
    const { dir, deps, lines } = await setup("no idea");
    expect(await runEvalCli([join(dir, "dataset.json")], deps)).toBe(1);
    expect(lines).toContain("FAIL greet");
  });

  it("rejects bad invocations with usage", async () => {
    const { deps, lines } = await setup("x");
    expect(await runEvalCli([], deps)).toBe(2);
    expect(lines.join("\n")).toContain("Usage: nexum eval");
  });
});
