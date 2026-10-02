#!/usr/bin/env node
// No `import 'dotenv/config'`: a workspace .env is repository content and is
// loaded only once the workspace is trusted (see src/cli/workspace-trust.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --yolo: approve every destructive tool call without prompting (sets
// NEXUM_AUTO_APPROVE, same as the env var). Stripped from argv before command
// parsing so it can appear anywhere, e.g. `nexum --yolo "task"` or `nexum fix --yolo "issue"`.
// Note: this only bypasses the confirmation prompt — policy denial rules
// (force push, secrets, .nexum/.devagent mutation, etc.) still apply; see
// AGENTS.md §7.18 "first decision wins".
{
  const args = process.argv.slice(2);
  const yoloIndex = args.indexOf('--yolo');
  if (yoloIndex !== -1) {
    args.splice(yoloIndex, 1);
    process.env.NEXUM_AUTO_APPROVE = 'true';
    process.argv = [process.argv[0], process.argv[1], ...args];
  }
}

const [command] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  console.log(`${pkg.name} v${pkg.version}`);
  process.exit(0);
}

if (command === '--help' || command === '-h') {
  console.log(`
Nexum — Autonomous Software Engineering Agent Runtime & Workspace

Usage:
  nexum                         Launch interactive terminal workspace
  nexum "<task>"                Start a mission for the specified task
  nexum fix "<issue>"           Investigate, plan, implement, and verify fix
  nexum issue <number>          Resolve GitHub issue end-to-end and prepare PR
  nexum rpc                     Start JSON-RPC agent server over stdio
  nexum serve                   Start the Nexum Local Host (HTTP + SSE)
  nexum session <list|show|attach>  Client commands against a running nexum serve
  nexum doctor                  Run system, workspace, and model diagnostics
  nexum migrate                 Migrate legacy .devagent state to .nexum
  nexum trust [status|revoke]   Review and trust this workspace's settings and .env
  nexum asl [validate|graph]    Architecture definition commands
  nexum evolve [options]        Harness evolution and self-development commands
  nexum plugins sandbox <file>  Trial-run a plugin in the worker sandbox
  nexum plugins verify [id…]    Re-verify installed marketplace plugins
  nexum marketplace keys …      Publisher trust store management
  nexum mcp trust …             MCP server trust approvals & policy preview
  nexum credentials …           Credential resolution preview (redacted)
  nexum capabilities …          Capability attestation authority & ledger

Options:
  -h, --help                    Show this help message
  -v, --version                 Show version
  --yolo                        Auto-approve confirmation prompts (NEXUM_AUTO_APPROVE);
                                 policy denial rules still apply
`);
  process.exit(0);
}

if (command === 'trust') {
  const { runTrustCli } = await import('../dist/cli/trust.js');
  process.exit(await runTrustCli(process.argv.slice(3)));
}

// Settings a repository ships (.nexum/config.json, .env, …) apply only once the
// workspace is trusted. The interactive UI asks; every other command runs
// without them and says so on stderr.
{
  const nonInteractive = ['doctor', 'evolve', 'plugins', 'marketplace', 'mcp', 'credentials', 'capabilities', 'rpc', 'migrate', 'asl'];
  const { ensureWorkspaceTrust } = await import('../dist/cli/trust.js');
  await ensureWorkspaceTrust({ interactive: !nonInteractive.includes(command) });
  const { applyEnvFiles } = await import('../dist/cli/config.js');
  applyEnvFiles();
}

if (command === 'doctor') {
  const { runDoctor } = await import('../dist/cli/doctor.js');
  const report = await runDoctor();
  console.log('=== Nexum Doctor ===');
  console.log(report.lines.join('\n'));
  process.exit(report.ok ? 0 : 1);
}

if (command === 'evolve') {
  const { runEvolutionCli } = await import('../dist/evolution/cli.js');
  await runEvolutionCli(process.argv.slice(3));
  process.exit(0);
}

// Trust & security command areas (plugins / marketplace / mcp / credentials /
// capabilities). Everything else falls through to the interactive UI.
if (['plugins', 'marketplace', 'mcp', 'credentials', 'capabilities'].includes(command)) {
  const { runSecurityCli } = await import('../dist/cli/security.js');
  const code = await runSecurityCli(command, process.argv.slice(3));
  process.exit(code);
}

if (command === 'rpc') {
  const { main } = await import('../dist/cli/rpc.js');
  await main(process.argv.slice(3));
  // The RPC server blocks on stdin; exit happens via the stdin 'end' handler.
  process.exit(0);
}

if (command === 'serve') {
  const { main } = await import('../dist/cli/serve.js');
  await main(process.argv.slice(3));
  // Blocks until SIGINT/SIGTERM; the cleanup handler calls process.exit(0).
}

if (command === 'session') {
  const { main } = await import('../dist/cli/session.js');
  await main(process.argv.slice(3));
  process.exit(0);
}

if (command === 'chat') {
  const { runChatCli } = await import('../dist/cli/chat.js');
  await runChatCli(process.argv.slice(3));
  process.exit(0);
}

if (command === 'migrate') {
  const { main } = await import('../dist/cli/migrate.js');
  await main(process.argv.slice(3));
} else {
  await import('../dist/ui/index.js');
}
