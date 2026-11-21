/**
 * Sandbox verification: run cloud-check against a local fake Ollama Cloud
 * endpoint, proving the FULL metered path (usage/balance/model list/chat ->
 * dispatcher -> budget admission -> ledger) works end-to-end without a real
 * key or spending a credit.
 *
 * Serves the exact response shapes from the SDK's generated contracts
 * (node_modules/@nemesis-oss/ollama-sdk/dist/index.d.ts):
 *   GET  /api/usage   -> UsageResponse  { range, scope, granularity, from, until, totals: UsageSummary, buckets }
 *   GET  /api/balance -> BalanceResponse { included: { balance_usd, allowance_usd, period }, purchased: { balance_usd } }
 *   GET  /v1/models   -> { data: [{ id }, ...] }
 *   POST /api/chat    -> native Ollama chat JSON with prompt_eval_count/eval_count
 *
 * NOT a unit test — a one-off harness script. Run from the repo root:
 *   node scripts/verify-cloud-check-local.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";

// ── fake Ollama Cloud ──────────────────────────────────────────────────────
const server = createServer((req, res) => {
  console.error(`[fake] ${req.method} ${req.url}`);
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith("/api/usage")) {
    return send(200, {
      range: "7d",
      scope: "self",
      granularity: "day",
      from: "2026-11-14T00:00:00Z",
      until: "2026-11-21T00:00:00Z",
      totals: { request_count: 3, usage_usd: 0.05, input_tokens: 900, cached_input_tokens: 100, output_tokens: 200 },
      buckets: [],
    });
  }
  if (req.url.startsWith("/api/balance")) {
    return send(200, {
      included: {
        balance_usd: 47.5,
        allowance_usd: 60.0,
        period: { from: "2026-11-01T00:00:00Z", until: "2026-12-01T00:00:00Z" },
      },
      purchased: { balance_usd: 0.0 },
    });
  }
  if (req.url.startsWith("/v1/models")) {
    return send(200, {
      data: [{ id: "gemma4" }, { id: "gpt-oss:120b" }, { id: "kimi-k2.7:code" }, { id: "glm-5.3" }],
    });
  }
  if (req.url.startsWith("/api/chat")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // metered native Ollama chat response with token counts
      send(200, {
        model: "gemma4",
        message: { role: "assistant", content: "ok" },
        done: true,
        prompt_eval_count: 12,
        eval_count: 2,
        eval_duration: 500_000_000,
      });
    });
    return;
  }
  send(404, { error: "not found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// ── run cloud-check against it ────────────────────────────────────────────
const env = {
  ...process.env,
  OLLAMA_API_KEY: "fake-key-sandbox-verification",
  OLLAMA_CLOUD_HOST: `http://127.0.0.1:${port}`,
  NEXUM_TEST_NO_GLOBAL: "true",
};

// npx+tsx cold-start exceeded 120s in this sandbox; resolve tsx's CLI directly.
// ASYNC spawn (not spawnSync): the fake server shares this process's event
// loop, so a synchronous spawn would block it and every request would time
// out — exactly the failure this harness existed to catch.
const tsxCli = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
const child = spawn(process.execPath, [tsxCli, "src/cli/cloud-check.ts", "--model", "gemma4"], {
  env,
  cwd: process.cwd(),
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => (stdout += c));
child.stderr.on("data", (c) => (stderr += c));
const status = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("cloud-check subprocess exceeded 420s"));
  }, 420_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
  child.on("error", reject);
});

const out = stdout;
console.log("exit code:", status);
console.log(out);
if (stderr) console.error("stderr:", stderr.slice(0, 800));
server.close();

const checks = [
  ["credentials line", /credentials: 1 key\(s\)/.test(out)],
  [
    "usage ok (requests read from SDK shape)",
    /usage\[.*\]: ok \(requests: 3, \$0\.0500, 900 in\/200 out tok\)/.test(out),
  ],
  [
    "balance fields (included + purchased)",
    /balance\[.*\]: included=\$47\.5000 of \$60\.0000 allowance, purchased=\$0\.0000/.test(out),
  ],
  ["model listing", /models: 4 available/.test(out)],
  ["price catalog hit", /price\[gemma4\].*catalog/.test(out)],
  ["chat call ok", /chat: ok — ok/.test(out)],
  ["ledger recorded with real counts", /ledger: 1 call — tokens 12 in \/ 2 out/.test(out)],
  ["ledger cost computed", /cost \$0\.00/.test(out)],
  ["budget consumed", /budget: modelCalls=1/.test(out)],
  [
    "monthly guard snapshot ok (cross-session ledger read)",
    /monthly guard: ok — \d+ cloud calls, \$[\d.]+ spent in \d{4}-\d{2} \(block at \$36\.0000; budget \$48\.0000 - reserve \$12\.0000\)/.test(
      out,
    ),
  ],
  ["overall PASS", /cloud-check: PASS/.test(out)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
