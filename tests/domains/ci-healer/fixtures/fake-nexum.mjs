#!/usr/bin/env node
// Test double for `nexum rpc --workspace <dir>`. Speaks the same NDJSON JSON-RPC wire
// format, prints one non-protocol line to stdout to prove the client ignores noise,
// and applies the edit selected by FAKE_NEXUM. Each goal is appended to FAKE_NEXUM_LOG
// followed by a separator, so tests can count invocations and inspect prompts.
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

process.stdout.write("fake-nexum: booting (non-JSON-RPC line)\n");

const mode = process.env.FAKE_NEXUM ?? "fix";
const logPath = process.env.FAKE_NEXUM_LOG;

const reply = (id, status, output = "", error = null) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { status, output, error } })}\n`);
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method !== "agent.execute") return;
  const goal = String(request.params?.goal ?? "");
  if (logPath) appendFileSync(logPath, `${goal}\n<<END>>\n`);

  switch (mode) {
    case "fix":
      appendFileSync("fixed.txt", "fixed\n");
      reply(request.id, "completed", "patched");
      break;
    case "fix_forbidden":
      appendFileSync("fixed.txt", "fixed\n");
      mkdirSync(".github/workflows", { recursive: true });
      writeFileSync(".github/workflows/ci.yml", "on: push\n");
      reply(request.id, "completed");
      break;
    case "noop":
      reply(request.id, "completed", "looked, changed nothing");
      break;
    case "edit_unrelated":
      writeFileSync("notes.txt", "investigated\n");
      reply(request.id, "completed", "edited the wrong thing");
      break;
    case "env":
      // Reports which credentials the child can see, so tests can prove the env policy.
      reply(
        request.id,
        "completed",
        `GH=${process.env.GH_TOKEN ?? "absent"} OLLAMA=${process.env.OLLAMA_API_KEY ?? "absent"}`,
      );
      break;
    case "fail":
      reply(request.id, "failed", "", "model unavailable");
      break;
    case "crash":
      process.exit(3);
      break;
    default:
      reply(request.id, "failed", "", `unknown FAKE_NEXUM mode ${mode}`);
  }
});
