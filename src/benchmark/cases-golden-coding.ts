import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../tools/registry.js";
import { ReadFileTool } from "../tools/filesystem.js";
import { SearchCodeTool } from "../tools/search-tools.js";
import { PatchTool } from "../tools/edit-tools.js";
import type { AgenticBenchmarkCase } from "./types.js";

/**
 * Golden software engineering benchmark cases spanning TypeScript, React,
 * Node.js, and Rails. Unlike toy synthetic cases, these test the agent's
 * real diagnostic and code-modification skills against realistic idioms.
 */
export async function buildGoldenCodingCases(): Promise<AgenticBenchmarkCase[]> {
  const root = await mkdtemp(join(tmpdir(), "nexum-golden-coding-"));

  // 1. TypeScript Fixture: Discount calculation with empty/undefined items edge case
  await mkdir(join(root, "src", "pricing"), { recursive: true });
  await writeFile(
    join(root, "src", "pricing", "discounts.ts"),
    `export interface OrderItem { sku: string; price: number; quantity: number; }\n` +
      `export interface Order { items?: OrderItem[]; coupon?: string; }\n` +
      `export function calculateTotal(order: Order): number {\n` +
      `  // Crashes if items is undefined or empty\n` +
      `  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n` +
      `  return order.coupon === "SAVE10" ? subtotal * 0.9 : subtotal;\n` +
      `}\n`,
  );

  // 2. React Fixture: Custom hook race condition / missing cleanup
  await mkdir(join(root, "src", "hooks"), { recursive: true });
  await writeFile(
    join(root, "src", "hooks", "useSearchResults.ts"),
    `import { useState, useEffect } from "react";\n` +
      `export function useSearchResults(query: string) {\n` +
      `  const [data, setData] = useState<string[]>([]);\n` +
      `  useEffect(() => {\n` +
      `    if (!query) { setData([]); return; }\n` +
      `    fetch(\`/api/search?q=\${encodeURIComponent(query)}\`)\n` +
      `      .then((r) => r.json())\n` +
      `      .then((res) => setData(res.items));\n` +
      `  }, [query]);\n` +
      `  return data;\n` +
      `}\n`,
  );

  // 3. Node.js Fixture: Express async route error handling
  await mkdir(join(root, "src", "api"), { recursive: true });
  await writeFile(
    join(root, "src", "api", "users.ts"),
    `import type { Request, Response, NextFunction } from "express";\n` +
      `export async function getUser(req: Request, res: Response, next: NextFunction) {\n` +
      `  const user = await database.findUser(req.params.id);\n` +
      `  if (!user) return res.status(404).json({ error: "not found" });\n` +
      `  res.json(user);\n` +
      `}\n`,
  );

  // 4. Rails Fixture: SQL injection in Active Record scope
  await mkdir(join(root, "app", "models"), { recursive: true });
  await writeFile(
    join(root, "app", "models", "account.rb"),
    `class Account < ApplicationRecord\n` +
      `  has_many :transactions\n` +
      `  scope :recent_activity, ->(cutoff_date) {\n` +
      `    where("last_active_at >= '#{cutoff_date}'")\n` +
      `  }\n` +
      `end\n`,
  );

  // 5. Config Fixture for Patch Tool testing
  await mkdir(join(root, "src", "config"), { recursive: true });
  const featureFile = join(root, "src", "config", "features.ts");
  const initialFeatureContent = `export const FEATURE_FLAGS = {\n  enableBetaUi: false,\n  maxRetryLimit: 1,\n  timeoutMs: 3000,\n};\n`;
  await writeFile(featureFile, initialFeatureContent);

  const readTool = new ReadFileTool(root);
  const searchTool = new SearchCodeTool(root);
  const patchTool = new PatchTool(root);
  const registry = new Registry().register(readTool).register(searchTool).register(patchTool);
  const tools = [readTool.schema, searchTool.schema, patchTool.schema];

  return [
    {
      id: "coding-ts-defensive-reduce",
      kind: "agentic",
      category: "golden-coding",
      description: "Identifies null reference risk on optional items array in TypeScript",
      messages: [
        {
          role: "user",
          content:
            "Check src/pricing/discounts.ts. If order.items is undefined, what error occurs and how should calculateTotal handle it safely?",
        },
      ],
      tools,
      maxTurns: 4,
      resolveTool: (name, args) => registry.invoke(name, args),
      validate: (trajectory) => {
        const calledRead = trajectory.toolCallsMade.some((c) => c.name === "read_file");
        if (!calledRead) return { pass: false, reason: "never read src/pricing/discounts.ts" };
        const content = trajectory.finalContent.toLowerCase();
        const mentionsError = /cannot read|undefined|typeerror|null/i.test(content);
        const mentionsFix = /optional chaining|\?\.|order\.items\s*\?\?|\?\?|default|fallback/i.test(content);
        if (!mentionsError || !mentionsFix) {
          return { pass: false, reason: "did not identify TypeError and optional chaining or null-coalescing fix" };
        }
        return { pass: true };
      },
    },
    {
      id: "coding-react-race-cleanup",
      kind: "agentic",
      category: "golden-coding",
      description: "Detects race condition in React useEffect hook and identifies cleanup pattern",
      messages: [
        {
          role: "user",
          content:
            "In src/hooks/useSearchResults.ts, fast sequential searches cause race conditions where stale promises overwrite newer results. How should useEffect be fixed?",
        },
      ],
      tools,
      maxTurns: 4,
      resolveTool: (name, args) => registry.invoke(name, args),
      validate: (trajectory) => {
        const calledRead = trajectory.toolCallsMade.some((c) => c.name === "read_file");
        if (!calledRead) return { pass: false, reason: "never read src/hooks/useSearchResults.ts" };
        const content = trajectory.finalContent.toLowerCase();
        const mentionsCleanup = /cleanup|return\s*\(\)|active\s*=\s*false|cancelled|abortcontroller/i.test(content);
        if (!mentionsCleanup) {
          return { pass: false, reason: "did not mention effect cleanup function, active flag, or AbortController" };
        }
        return { pass: true };
      },
    },
    {
      id: "coding-node-async-error-propagation",
      kind: "agentic",
      category: "golden-coding",
      description: "Identifies unhandled async error in Express route handler and prescribes next(err)",
      messages: [
        {
          role: "user",
          content:
            "In src/api/users.ts, if database.findUser rejects with a database error, what happens in Express, and how should it be caught and forwarded?",
        },
      ],
      tools,
      maxTurns: 4,
      resolveTool: (name, args) => registry.invoke(name, args),
      validate: (trajectory) => {
        const calledRead = trajectory.toolCallsMade.some((c) => c.name === "read_file");
        if (!calledRead) return { pass: false, reason: "never read src/api/users.ts" };
        const content = trajectory.finalContent.toLowerCase();
        const mentionsNext = /next\s*\(\s*(err|e|error)/i.test(content);
        const mentionsTryCatch = /try\s*\{\s*|try\s*\/\s*catch|catch/i.test(content);
        if (!mentionsNext || !mentionsTryCatch) {
          return { pass: false, reason: "did not specify try/catch and next(error) forwarding" };
        }
        return { pass: true };
      },
    },
    {
      id: "coding-rails-sql-injection-prevention",
      kind: "agentic",
      category: "golden-coding",
      description: "Detects SQL injection via string interpolation in Rails scope and provides parameterized query",
      messages: [
        {
          role: "user",
          content:
            "Examine app/models/account.rb. Is there a security issue in the recent_activity scope, and how should it be rewritten safely in Active Record?",
        },
      ],
      tools,
      maxTurns: 4,
      resolveTool: (name, args) => registry.invoke(name, args),
      validate: (trajectory) => {
        const calledRead = trajectory.toolCallsMade.some((c) => c.name === "read_file");
        if (!calledRead) return { pass: false, reason: "never read app/models/account.rb" };
        const content = trajectory.finalContent.toLowerCase();
        const mentionsSqlInjection = /sql\s*injection|interpolat/i.test(content);
        const mentionsParamFix = /parameterized|\?|hash|where\s*\(\s*["']last_active_at/i.test(content);
        if (!mentionsSqlInjection || !mentionsParamFix) {
          return { pass: false, reason: "did not identify SQL injection or provide parameterized query" };
        }
        return { pass: true };
      },
    },
    {
      id: "coding-patch-feature-flag",
      kind: "agentic",
      category: "golden-coding",
      description: "Applies a code change via patch_file to mutate maxRetryLimit from 1 to 3",
      messages: [
        {
          role: "user",
          content:
            "Read src/config/features.ts to find the current configuration, then call the patch_file tool to change maxRetryLimit from 1 to 3.",
        },
      ],
      tools,
      maxTurns: 4,
      resolveTool: async (name, args) => {
        if (name === "read_file" && String(args.path ?? "").includes("features.ts")) {
          await writeFile(featureFile, initialFeatureContent, "utf-8");
        }
        return registry.invoke(name, args);
      },
      validate: (trajectory) => {
        const patchCall = trajectory.toolCallsMade.find((c) => c.name === "patch_file");
        if (!patchCall) return { pass: false, reason: "never called patch_file" };
        if (patchCall.result.error) return { pass: false, reason: `patch_file failed: ${patchCall.result.error}` };
        const findArg = String(patchCall.args.find ?? "");
        const replaceArg = String(patchCall.args.replace ?? "");
        if (!/maxRetryLimit/i.test(findArg) || !/3/.test(replaceArg)) {
          return { pass: false, reason: "patch_file arguments did not target maxRetryLimit -> 3" };
        }
        return { pass: true };
      },
    },
  ];
}
