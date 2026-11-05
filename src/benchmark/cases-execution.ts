import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../tools/registry.js";
import { ReadFileTool } from "../tools/filesystem.js";
import { SearchCodeTool } from "../tools/search-tools.js";
import { AgenticBenchmarkCase, AgenticTrajectory } from "./types.js";

// Real end-to-end tool execution — not scripted mocks — against a throwaway
// workspace, so these cases exercise the actual Tool implementations
// (filesystem I/O, ripgrep-backed search) the real agent uses.
export async function buildExecutionCases(): Promise<AgenticBenchmarkCase[]> {
  const root = await mkdtemp(join(tmpdir(), "nexum-benchmark-"));
  await writeFile(join(root, "notes.txt"), "Project notes.\nThe secret code is 4471.\nEnd of notes.\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "auth.ts"),
    "// TODO: fix auth token refresh race condition\nexport function auth() {}\n",
  );

  // Fixtures for the multi-step cases below. None of them contains a TODO, so the
  // search case above still finds the auth TODO first.
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(
    join(root, "config", "app.json"),
    JSON.stringify({ name: "ledger", version: "1.4.2" }, null, 2) + "\n",
  );
  await writeFile(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## 1.4.2\n- Added offline mode for the ledger view.\n\n## 1.4.1\n- Fixed CSV export rounding.\n",
  );
  await mkdir(join(root, "src", "billing"), { recursive: true });
  await writeFile(
    join(root, "src", "billing", "tax.ts"),
    "export const GST_RATE = 0.18;\n\nexport function computeTax(amount: number): number {\n  return amount * GST_RATE;\n}\n",
  );
  await mkdir(join(root, "src", "payments"), { recursive: true });
  await writeFile(
    join(root, "src", "payments", "charges.ts"),
    "export function handleCharge(id: string) {\n  return id;\n}\n",
  );
  await writeFile(
    join(root, "src", "payments", "refunds.ts"),
    "export function handleRefund(id: string) {\n  return id;\n}\n",
  );
  await writeFile(
    join(root, "src", "payments", "disputes.ts"),
    "export function handleDispute(id: string) {\n  return id;\n}\n",
  );

  const readRegistry = new Registry().register(new ReadFileTool(root));
  const searchRegistry = new Registry().register(new SearchCodeTool(root));
  const workspaceRegistry = new Registry().register(new ReadFileTool(root)).register(new SearchCodeTool(root));
  const workspaceTools = [new ReadFileTool(root).schema, new SearchCodeTool(root).schema];
  const readPaths = (trajectory: AgenticTrajectory): string[] =>
    trajectory.toolCallsMade.filter((c) => c.name === "read_file").map((c) => String(c.args.path ?? ""));

  return [
    {
      id: "execution-real-read-file",
      kind: "agentic",
      category: "execution",
      description: "Reads a real file via the real ReadFileTool and reports its content correctly",
      messages: [{ role: "user", content: "Read the file notes.txt and tell me the secret code mentioned in it." }],
      tools: [new ReadFileTool(root).schema],
      maxTurns: 4,
      resolveTool: (name, args) => readRegistry.invoke(name, args),
      validate: (trajectory) => {
        if (!trajectory.toolCallsMade.some((c) => c.name === "read_file")) {
          return { pass: false, reason: "never called read_file" };
        }
        if (!/4471/.test(trajectory.finalContent)) {
          return {
            pass: false,
            reason: `final answer didn't contain the secret code (4471): "${trajectory.finalContent}"`,
          };
        }
        return { pass: true };
      },
    },
    {
      id: "execution-real-search-code",
      kind: "agentic",
      category: "execution",
      description: "Finds a real TODO comment via the real SearchCodeTool (ripgrep-backed)",
      messages: [
        { role: "user", content: "Search the codebase for TODO comments and tell me what the first one says." },
      ],
      tools: [new SearchCodeTool(root).schema],
      maxTurns: 4,
      resolveTool: (name, args) => searchRegistry.invoke(name, args),
      validate: (trajectory) => {
        if (!trajectory.toolCallsMade.some((c) => c.name === "search_code")) {
          return { pass: false, reason: "never called search_code" };
        }
        if (!/auth/i.test(trajectory.finalContent)) {
          return { pass: false, reason: `final answer didn't mention the auth TODO: "${trajectory.finalContent}"` };
        }
        return { pass: true };
      },
    },
    {
      id: "execution-read-two-files",
      kind: "agentic",
      category: "execution",
      description: "Reads one real file to learn what to look for in a second",
      messages: [
        {
          role: "user",
          content:
            "What does the changelog say about the app's current version? The current version is in config/app.json.",
        },
      ],
      tools: workspaceTools,
      maxTurns: 5,
      resolveTool: (name, args) => workspaceRegistry.invoke(name, args),
      validate: (trajectory) => {
        const paths = readPaths(trajectory);
        if (!paths.some((p) => p.includes("app.json"))) return { pass: false, reason: "never read config/app.json" };
        if (!/offline/i.test(trajectory.finalContent)) {
          return { pass: false, reason: `expected the 1.4.2 entry (offline mode): "${trajectory.finalContent}"` };
        }
        return { pass: true };
      },
    },
    {
      id: "execution-search-then-read",
      kind: "agentic",
      category: "execution",
      description: "Searches for a definition, then reports the constant it depends on",
      messages: [
        { role: "user", content: "Find where computeTax is defined and tell me the tax rate constant it uses." },
      ],
      tools: workspaceTools,
      maxTurns: 5,
      resolveTool: (name, args) => workspaceRegistry.invoke(name, args),
      validate: (trajectory) => {
        if (!trajectory.toolCallsMade.some((c) => c.name === "search_code")) {
          return { pass: false, reason: "never searched for computeTax" };
        }
        if (!/0\.18|18\s*%/.test(trajectory.finalContent)) {
          return { pass: false, reason: `expected the rate 0.18 (GST_RATE): "${trajectory.finalContent}"` };
        }
        return { pass: true };
      },
    },
    {
      id: "execution-find-defining-file",
      kind: "agentic",
      category: "execution",
      description: "Names the one file, among similar ones, that defines a function",
      messages: [{ role: "user", content: "Which file defines the function handleRefund? Give me its path." }],
      tools: workspaceTools,
      maxTurns: 4,
      resolveTool: (name, args) => workspaceRegistry.invoke(name, args),
      validate: (trajectory) => {
        if (!/refunds\.ts/.test(trajectory.finalContent)) {
          return { pass: false, reason: `expected src/payments/refunds.ts: "${trajectory.finalContent}"` };
        }
        if (/charges\.ts|disputes\.ts/.test(trajectory.finalContent)) {
          return { pass: false, reason: "also named a file that does not define handleRefund" };
        }
        return { pass: true };
      },
    },
    {
      id: "execution-missing-file-honest",
      kind: "agentic",
      category: "execution",
      description: "Says a file is missing instead of inventing its content",
      messages: [{ role: "user", content: "Read docs/ROADMAP.md and tell me the goal it sets for Q3." }],
      tools: [new ReadFileTool(root).schema],
      maxTurns: 4,
      resolveTool: (name, args) => readRegistry.invoke(name, args),
      validate: (trajectory) => {
        if (!readPaths(trajectory).some((p) => p.toLowerCase().includes("roadmap"))) {
          return { pass: false, reason: "never tried to read docs/ROADMAP.md" };
        }
        const saysMissing =
          /not (exist|found|available)|doesn['’]t exist|does not exist|couldn['’]t (find|read|open)|could not (find|read|open)|unable to (find|read|open)|no such file|missing/i;
        if (!saysMissing.test(trajectory.finalContent)) {
          return { pass: false, reason: `did not say the file is missing: "${trajectory.finalContent}"` };
        }
        return { pass: true };
      },
    },
  ];
}
