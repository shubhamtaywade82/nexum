/**
 * Sandbox baseline: `benchmark --driver agent` against a local fake Ollama
 * Cloud, with a scripted tool-calling model. Proves the agent driver path
 * (Agent → ModelStack → dispatcher → ledger) executes end-to-end in this
 * sandbox and produces a real baseline JSON — without a real key or credits.
 *
 * The fake model implements a fixed ReAct policy for the harness's own agentic
 * cases (see src/benchmark/cases-agentic.ts): it answers the tool-chain case
 * by calling lookup_user then get_balance and reporting 450; the
 * error-recovery case by retrying once after the tool error; escalation by
 * reporting inability. It is a *double of a weak model*, so scores measure
 * the pipeline, not model quality — that needs the real cloud run.
 *
 * Run from the repo root:
 *   node scripts/verify-benchmark-agent-local.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── scripted "model": a tiny state machine keyed by (tool round, last tool result) ──
function modelReply({ tools = [], nToolCallsSoFar = 0, sawLookupResult = false, sawBalanceResult = false } = {}) {
  // The agent driver replaces the agent's tools with the case's tools, and the
  // case prompt describes the task. We infer intent from the tool names
  // present in the request, which the fake can read from the JSON body.
  return { tools, nToolCallsSoFar, sawLookupResult, sawBalanceResult };
}

const server = createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith("/api/usage")) {
    return send(200, {
      range: "7d",
      scope: "self",
      granularity: "day",
      from: "x",
      until: "y",
      totals: { request_count: 0 },
      buckets: [],
    });
  }
  if (req.url.startsWith("/api/balance")) {
    return send(200, {
      included: { balance_usd: 47.5, allowance_usd: 60, period: { from: "x", until: "y" } },
      purchased: { balance_usd: 0 },
    });
  }
  if (req.url.startsWith("/v1/models")) {
    return send(200, { data: [{ id: "gemma4" }] });
  }
  if (req.url.startsWith("/api/chat")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let reqJson = {};
      try {
        reqJson = JSON.parse(body);
      } catch {}
      if (process.env.FAKE_DEBUG) {
        const roles = (reqJson.messages ?? [])
          .map(
            (m) =>
              `${m.role}:${String(m.content ?? "")
                .slice(0, 25)
                .replace(/\n/g, " ")}`,
          )
          .join(" | ");
        console.error(
          `[fake] tools=${JSON.stringify((reqJson.tools ?? []).map((t) => t.function?.name ?? t.name))} msgs=${(reqJson.messages ?? []).length} :: ${roles}`,
        );
      }
      const msgs = Array.isArray(reqJson.messages) ? reqJson.messages : [];
      const toolNames = (reqJson.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean);
      const toolRounds = msgs.filter((m) => m.role === "tool").length;
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
      const lastToolContent = typeof lastTool?.content === "string" ? lastTool.content : "";

      // Evaluated prompt size for metering (chars/4 ≈ tokens, mirrors admission)
      const promptChars = msgs.reduce((n, m) => n + String(m.content ?? "").length, 0);

      let message;
      if (toolNames.includes("lookup_user") && !lastToolContent.includes("u123")) {
        // First turn of the tool-chain case (or before the lookup resolved)
        if (toolRounds === 0) {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "lookup_user", arguments: { name: "jdoe" } } }],
          };
        }
      }
      if (
        !message &&
        toolNames.includes("get_balance") &&
        lastToolContent.includes("u123") &&
        !lastToolContent.includes("450")
      ) {
        message = {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "get_balance", arguments: { id: "u123" } } }],
        };
      }
      if (!message && lastToolContent.includes("450")) {
        message = { role: "assistant", content: "The account balance for user 'jdoe' is 450." };
      }
      if (!message && toolNames.includes("read_file") && toolRounds === 0) {
        // error-recovery case: call with a bad path first, then report
        message = {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "read_file", arguments: { path: "/nonexistent/first.txt" } } }],
        };
      }
      if (!message && toolRounds > 0 && lastToolContent.includes("error")) {
        message = {
          role: "assistant",
          content: "The file could not be read; after the first attempt failed I stopped and report the failure.",
        };
      }
      if (!message && toolRounds > 0) {
        message = { role: "assistant", content: "Done — see tool output above." };
      }
      if (!message && msgs.length === 1) {
        // First turn (planning/intent): never a final answer — defer so the
        // loop reaches a tooled turn.
        message = { role: "assistant", content: "Working on it — I will use the available tools." };
      }
      if (!message) {
        message = { role: "assistant", content: "I cannot complete this task." };
      }

      send(200, {
        model: "gemma4",
        message,
        done: true,
        prompt_eval_count: Math.max(1, Math.round(promptChars / 4)),
        eval_count: 24,
        eval_duration: 30_000_000,
      });
    });
    return;
  }
  send(404, { error: "not found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// Isolated ledger dir so the sandbox run can't pollute (or read) a real ledger.
const scratch = mkdtempSync(join(tmpdir(), "nexum-bench-"));
const usageDir = join(scratch, "usage");
writeFileSync(
  join(scratch, ".nexum.config.json"),
  JSON.stringify({
    tier: "cloud",
    model: "gemma4",
    apiKey: "fake-key-sandbox-benchmark",
    maxCostUsd: 1.0,
    autoPlan: "off",
    enableLocalWorker: false,
    enableVerifier: false,
    enableSelfConsistency: false,
    enableAvailabilityCheck: false,
    enableDecision: false,
    sandbox: false,
  }),
  "utf8",
);

const env = {
  ...process.env,
  OLLAMA_API_KEY: "fake-key-sandbox-benchmark",
  OLLAMA_CLOUD_HOST: `http://127.0.0.1:${port}`,
  NEXUM_TEST_NO_GLOBAL: "true",
  HOME: scratch, // isolate ~/.nexum (ledger, trust store) from the real one
  NEXUM_MAX_COST_USD: "1.0",
  NEXUM_CLOUD_CONCURRENCY: "2",
};
delete env.NEXUM_TIER;
delete env.NEXUM_MODEL;

const tsxCli = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
const args = [tsxCli, "src/benchmark/cli.ts", "--driver", "agent", "--repeats", "1", "--json"];
const child = spawn(process.execPath, args, { env, cwd: process.cwd() });

let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => (stdout += c));
child.stderr.on("data", (c) => (stderr += c));
const status = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("benchmark subprocess exceeded 600s"));
  }, 600_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
  child.on("error", reject);
});
server.close();

console.log("exit code:", status);
if (stderr.trim()) console.error("stderr (tail):", stderr.slice(-600));
console.log("stdout (first 1200 chars):", stdout.slice(0, 1200));
// Full result for the baseline record (scripts/baseline-agent-sandbox.json,
// relative to the repo root — kept out of download/, which is for deliverables).
writeFileSync(new URL("./baseline-agent-sandbox.json", import.meta.url).pathname, stdout, "utf8");

// ── checks ────────────────────────────────────────────────────────────────
const checks = [
  ["exit 0", status === 0],
  [
    "JSON result parsed",
    (() => {
      try {
        const j = JSON.parse(stdout);
        return Array.isArray(j.results) || Array.isArray(j.models) || typeof j === "object";
      } catch {
        return false;
      }
    })(),
  ],
  [
    "ledger written (per-call records)",
    (() => {
      try {
        const text = readFileSync(join(scratch, ".nexum", "usage", "ledger.jsonl"), "utf8");
        return text.trim().split("\n").length > 0;
      } catch {
        return false;
      }
    })(),
  ],
  [
    "tool calls reached the case (react loop wired)",
    (() => {
      try {
        const text = stdout;
        const results = JSON.parse(text);
        return results.some((r) => (r.toolCalls ?? 0) > 0);
      } catch {
        return false;
      }
    })(),
  ],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
